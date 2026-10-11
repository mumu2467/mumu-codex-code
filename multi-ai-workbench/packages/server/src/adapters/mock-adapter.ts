/**
 * Mock 通道：不依赖任何账号即可端到端跑通整条链路（Step 1/2 的验证基础）。
 *
 * 它刻意还原了真实网页版的几个关键特征，让前端能在没有真机的情况下把交互做完：
 *   - 打开会话/粘贴文字/上传图片的前置耗时
 *   - 首字延迟（思考中）
 *   - 逐字流式吐出
 *   - 可被 stop() 打断，并保留半截内容
 *   - 可注入故障，用于演练错误态 + 重试
 *
 * 故障注入约定（写在消息文本里即可）：
 *   含 "#fail"    → 抛 selector 类错误（模拟页面改版）。**只失败第一次**，
 *                   同一条消息重试即成功——这样才能真正演示"错误态 → 一键重试"。
 *   含 "#captcha" → 抛 captcha 类错误（模拟验证码），且持续失败，
 *                   因为按降级阶梯它必须靠人工介入（L1）才能解决。
 */
import type { Provider } from '@maw/shared';
import { estimateTokens } from '@maw/shared';
import type { AdapterHealth, AdapterInput, ChatAdapter, ReplySink } from './types.js';
import { AbortedError, AdapterError, randInt, sleep } from '../utils/errors.js';

interface Persona {
  /** 打开会话 + 粘贴 + 传图的耗时区间（ms） */
  preDelay: [number, number];
  /** 首字延迟区间（ms） */
  think: [number, number];
  /** 每个 chunk 之间的间隔（ms） */
  chunkGap: [number, number];
  /** 每个 chunk 的字符数 */
  chunkSize: [number, number];
}

const PERSONAS: Record<Provider, Persona> = {
  deepseek: { preDelay: [180, 420], think: [420, 900], chunkGap: [22, 48], chunkSize: [2, 6] },
  doubao: { preDelay: [110, 280], think: [200, 560], chunkGap: [16, 38], chunkSize: [3, 9] },
  kimi: { preDelay: [220, 520], think: [520, 1150], chunkGap: [26, 60], chunkSize: [2, 5] },
};

export class MockAdapter implements ChatAdapter {
  readonly route = 'mock' as const;
  private sessionKey: string;
  private current?: AbortSignal;
  /** 已经注入过 #fail 的用户消息，用于保证"重试即成功" */
  private readonly faultedMessages = new Set<string>();

  constructor(
    readonly id: Provider,
    private readonly speed = 1,
  ) {
    this.sessionKey = `${id}-mock-${Date.now().toString(36)}`;
  }

  async init(): Promise<void> {
    /* mock 无需初始化 */
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, reason: '本地 mock 通道，无需登录态' };
  }

  async send(input: AdapterInput, sink: ReplySink, signal: AbortSignal): Promise<void> {
    this.current = signal;
    const persona = PERSONAS[this.id];
    const scale = (ms: number) => Math.max(1, Math.round(ms / this.speed));
    const wait = (ms: number) => sleep(ms, signal);

    // 1) 模拟"切换到该平台的会话窗口 + 粘贴文本 + 上传图片"
    await wait(scale(randInt(persona.preDelay[0], persona.preDelay[1]) + input.images.length * randInt(180, 420)));

    // 2) 思考（首字延迟）
    const think = scale(randInt(persona.think[0], persona.think[1]));
    await wait(think);

    // 3) 故障注入（放在首字延迟之后，模拟"点了发送但平台没反应/弹验证码"）
    if (input.text.includes('#captcha')) {
      // 验证码属于"必须人工介入"的类型，重试也没用，所以每次都抛
      throw new AdapterError(
        '（演练）平台弹出人机验证，需要人工过一次后才能继续发送',
        'captcha',
        false,
      );
    }
    if (input.text.includes('#fail') && !this.faultedMessages.has(input.userMessageId)) {
      this.faultedMessages.add(input.userMessageId);
      throw new AdapterError(
        '（演练）未找到发送按钮，页面结构可能已改版（selector miss）',
        'selector',
        true,
      );
    }

    sink.status('streaming');

    // 4) 逐 chunk 流式输出
    const answer = this.composeAnswer(input);
    let cursor = 0;
    let full = '';
    while (cursor < answer.length) {
      if (signal.aborted) throw new AbortedError();
      const size = randInt(persona.chunkSize[0], persona.chunkSize[1]);
      const delta = answer.slice(cursor, cursor + size);
      cursor += size;
      full += delta;
      sink.delta(delta, full);
      sink.meta({ tokenEstimate: estimateTokens(full) });
      await wait(scale(randInt(persona.chunkGap[0], persona.chunkGap[1])));
    }

    sink.meta({ firstTokenMs: think, tokenEstimate: estimateTokens(full) });
    this.current = undefined;
  }

  async stop(): Promise<void> {
    // 真实网页版这里会去点平台的"停止生成"按钮；mock 依赖 orchestrator 传进来的 signal
  }

  async newSession(): Promise<string> {
    this.sessionKey = `${this.id}-mock-${Date.now().toString(36)}`;
    return this.sessionKey;
  }

  async dispose(): Promise<void> {
    this.current = undefined;
  }

  /** 生成一段有该平台风格的回答（内容不是重点，重点是长度/结构接近真实，能压测 UI） */
  private composeAnswer(input: AdapterInput): string {
    const question = input.text.trim() || '（仅图片消息）';
    const imageLine =
      input.images.length > 0
        ? `我看到你附了 ${input.images.length} 张图片（${input.images.map((i) => i.name).join('、')}），已一并纳入理解。`
        : '这次没有图片，我按纯文本理解。';

    const common: Record<Provider, string[]> = {
      deepseek: [
        '我先拆一下这个问题的结构，再给结论。',
        '第一步，界定概念边界，避免把相近的说法混在一起。',
        '第二步，找出关键约束，也就是真正决定结论的那两三个变量。',
        '第三步，给出可验证的结论，并标注它的适用范围。',
        '如果你希望我展开某一步，或者换一个角度推导，直接说就行。',
      ],
      doubao: [
        '这个问题挺常见的，我用大白话给你讲一遍。',
        '简单说就是：先把目标定清楚，再看手上有什么牌，最后挑最省力的打法。',
        '举个小例子：就像出门前先看天气，再决定带不带伞，顺序反了就容易白忙活。',
        '要是你告诉我具体场景，我能给更贴的建议。',
        '有哪里没听明白的话，你随时打断我。',
      ],
      kimi: [
        '我会先把你给的材料读完整，再回答，避免只抓片段。',
        '从长文本理解的角度，这里有几个值得注意的细节：上下文依赖、术语一致性、以及隐含前提。',
        '综合来看，结论是：在大多数常规场景下，按上面的顺序处理就足够了。',
        '另外提醒一句，如果材料里存在互相矛盾的地方，需要先以时间最新的那份为准。',
        '需要我把上面这段整理成提纲或者表格吗？',
      ],
    };

    const body = common[this.id];
    return [
      `我是 ${this.id === 'doubao' ? '豆包' : this.id === 'deepseek' ? 'DeepSeek' : 'Kimi'}（当前为 mock 通道，非真实模型输出）。`,
      '',
      `你问的是：「${question}」`,
      imageLine,
      '',
      ...body.map((line, i) => `${i + 1}. ${line}`),
      '',
      '—— 以上内容由本地 mock 生成，用于验证「三窗并发 + 流式渲染 + 指标统计」的完整链路。',
      '接入真实平台后，这里会替换为网页版的真实回复。',
    ].join('\n');
  }
}
/**
 * 通用「网页版」适配器基类 —— Step 3b 的核心。
 *
 * 它把「在 AI 的 C 端网页里替你打字、点发送、读回复」这件事抽象成一套通用流程：
 *
 *   1. 打开/复用该家的浏览器窗口（持久化 profile，登录态由 Chromium 自己维护）
 *   2. 若换了工作台会话 → 先开一个全新的平台对话（避免不同会话互相污染上下文）
 *   3. 上传图片（setInputFiles）→ 输入文字（textarea 用 fill，富文本用键盘事件）
 *   4. 提交（Enter；如果编辑器把回车当换行，就回退点发送按钮）
 *   5. 轮询「最后一条助手消息」的文本，增量 diff 后推给 ReplySink
 *   6. 结束判定：平台自己的"生成中"标志消失 + 文本静默满 idleMs（或硬超时）
 *
 * 为什么三家能共用一个基类：它们只有"选择器、输入方式、结束标志"不同，
 * 这些差异全部外置在 `selectors/*.json` 里；确实需要写代码的差异，由子类覆写钩子。
 *
 * ⚠️ 自动化边界（必须显式说明，这也是本方案最大的不确定性来源）：
 *   - 登录：三家在异地/新设备登录都要短信验证码或 App 扫码，**只能人工**。本适配器复用
 *     已保存的登录态；一旦失效会抛 AdapterError('auth')，前端引导你去点「登录」。
 *   - 风控/验证码：命中时抛 AdapterError('captcha')，只能切到浏览器窗口人工过一次。
 *   - 页面改版：选择器会失效，抛 AdapterError('selector')，用 `npm run probe` 重新校准。
 *   - 这是"模拟真人操作你的账号"，不是官方接口；频率请克制，别拿它去刷量。
 */
import type { Page } from 'playwright';
import type { Provider } from '@maw/shared';
import { estimateTokens, providerLabel } from '@maw/shared';
import { PROVIDER_SITES, type BrowserPool } from '../browser/browser-pool.js';
import { AbortedError, AdapterError, isAbortError, sleep } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { candidates, loadSelectors, type WebSelectors } from './selectors/index.js';
import type { AdapterHealth, AdapterImage, AdapterInput, ChatAdapter, ReplySink } from './types.js';

/** 归一化网页正文：不间断空格、行尾空格、连续空行都会干扰 diff，统一处理掉 */
export function normalizeReply(raw: string): string {
  return (raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface WebAdapterTuning {
  /** 发送后多久还没看到回复就判首字超时（DeepSeek 深度思考可能很久，给宽一点） */
  firstTokenTimeoutMs?: number;
  /** 单条回复的硬超时，防止平台卡死把我们拖住 */
  overallTimeoutMs?: number;
  /** 有「生成中」标志时的静默判定时长 */
  idleMs?: number;
  /** 没有「生成中」标志时的静默判定时长（要更保守，避免把"思考停顿"当成结束） */
  idleMsNoStreamingFlag?: number;
  /** 采样间隔 */
  pollMs?: number;
}

export abstract class BaseWebAdapter implements ChatAdapter {
  readonly route = 'playwright' as const;

  protected readonly label: string;
  protected readonly selectors: WebSelectors;

  private readonly firstTokenTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private readonly loggedOutUrlRe?: RegExp;

  /** 当前正在生成的那一页，stop() 用它去点平台的停止按钮 */
  private activePage?: Page;
  /** 上一次发送用的工作台会话 key。变了 = 要开一个全新的平台对话 */
  private lastSessionKey?: string;
  /** 当前平台对话是否已经有过交流（决定续聊时要不要把历史一起带过去） */
  private chatDirty = false;

  constructor(
    readonly id: Provider,
    protected readonly pool: BrowserPool,
    protected readonly log: Logger,
    tuning: WebAdapterTuning = {},
  ) {
    this.label = providerLabel(id);
    this.selectors = loadSelectors(id, { reload: true });
    this.firstTokenTimeoutMs = tuning.firstTokenTimeoutMs ?? 60_000;
    this.overallTimeoutMs = tuning.overallTimeoutMs ?? 6 * 60_000;
    this.pollMs = tuning.pollMs ?? 600;
    const fallbackIdle = tuning.idleMsNoStreamingFlag ?? 3_000;
    this.idleMs = this.selectors.streaming ? (tuning.idleMs ?? 1_500) : fallbackIdle;
    if (this.selectors.loggedOutUrl) {
      try {
        this.loggedOutUrlRe = new RegExp(this.selectors.loggedOutUrl, 'i');
      } catch {
        this.log.warn(`${this.label}：loggedOutUrl 不是合法正则，已忽略：${this.selectors.loggedOutUrl}`);
      }
    }
  }

  // =============================================================== 生命周期

  async init(): Promise<void> {
    this.log.info(`${this.label} 网页版通道就绪（选择器：${this.constructor.name}）`);
  }

  /**
   * 体检。
   *
   * 刻意**不**主动开浏览器：/api/health 会被前端反复调用，如果体检顺手拉起三个 Edge 窗口，
   * 那页面一刷新就弹三扇窗，纯属骚扰。所以这里只检查"已经开着的那扇窗"。
   */
  async health(): Promise<AdapterHealth> {
    const page = this.pool.peekPage(this.id);
    if (!page || page.isClosed()) {
      return {
        ok: true,
        reason: '通道就绪：浏览器窗口尚未打开，首次发送会自动打开并复用已保存的登录态',
      };
    }
    const url = page.url();
    if (!/^https?:/i.test(url)) {
      return { ok: true, reason: '窗口已打开，还没加载页面（发送时会自动打开站点）' };
    }
    if (this.loggedOutUrlRe?.test(url)) {
      return { ok: false, reason: `登录态已失效（被重定向到 ${url}），请点顶部「登录」重新扫码` };
    }
    if (this.selectors.loggedOut) {
      const visible = await page.locator(this.selectors.loggedOut).first().isVisible().catch(() => false);
      if (visible) return { ok: false, reason: '检测到登录页元素，登录态可能已失效，请点顶部「登录」复核' };
    }
    const loggedIn = await page.locator(this.selectors.loggedIn).first().isVisible().catch(() => false);
    return loggedIn
      ? { ok: true, reason: '窗口已打开，登录态正常' }
      : { ok: true, reason: '窗口已打开，但没识别到登录态元素（发送失败时点「登录」复核一下）' };
  }

  async dispose(): Promise<void> {
    this.activePage = undefined;
    // 浏览器上下文由 BrowserPool 统一持有，这里不做关闭，避免误关用户正在用的窗口
  }

  // =============================================================== 发送主流程

  async send(input: AdapterInput, sink: ReplySink, signal: AbortSignal): Promise<void> {
    const page = await this.pool.openWindow(this.id);
    this.activePage = page;

    await this.preparePage(page);
    await this.assertNotBlocked(page);

    // 换了工作台会话 → 开一个全新的平台对话，两个会话的上下文不互相污染
    if (this.lastSessionKey !== input.sessionKey) {
      await this.openFreshChat(page);
      this.chatDirty = false;
      this.lastSessionKey = input.sessionKey;
    }

    // 记基线：发送前"最后一条助手消息"是什么，用来识别新出现的那条
    const baseline = await this.readReply(page);

    let attachmentsBefore = -1;
    if (input.images.length > 0) {
      attachmentsBefore = await this.countThumbnails(page);
      await this.uploadImages(page, input.images, attachmentsBefore);
    }

    const text = this.composeText(input);
    if (text.trim().length === 0 && input.images.length === 0) {
      throw new AdapterError(`${this.label}：消息是空的（文字和图片都没有）`, 'unknown', false);
    }
    if (text.trim().length > 0) await this.typeText(page, text);
    await this.assertNotBlocked(page);

    const submittedAt = Date.now();
    await this.submit(page);
    this.chatDirty = true;

    // ---- 等首字 ----
    const first = await this.waitForReplyStart(page, baseline, signal, submittedAt);
    sink.meta({ firstTokenMs: first.firstTokenMs });
    if (first.text.length > 0) sink.delta(first.text, first.text);

    // ---- 流式跟踪 ----
    let last = first.text;
    let idleSince = Date.now();

    try {
      for (;;) {
        await sleep(this.pollMs, signal);
        if (Date.now() > submittedAt + this.overallTimeoutMs) {
          throw new AdapterError(
            `${this.label}：等待回复超时（${Math.round(this.overallTimeoutMs / 1000)}s），已保留收到的 ${last.length} 字`,
            'network',
            true,
          );
        }

        const current = await this.readReply(page);
        if (current.text !== last) {
          if (current.text.length > 0) {
            // 只追加就发增量；出现重排/回退（markdown 重渲染）就整段重发，交给前端以 full 覆盖
            const appendOnly = current.text.startsWith(last);
            sink.delta(appendOnly ? current.text.slice(last.length) : current.text, current.text);
            last = current.text;
          }
          idleSince = Date.now();
        }

        const streaming = await this.isStreaming(page);
        if (streaming) {
          idleSince = Date.now();
          continue;
        }

        if (last.length > 0) {
          if (Date.now() - idleSince >= this.idleMs) break;
        } else if (Date.now() - idleSince >= this.idleMs * 6) {
          // 助手气泡挂出来半天却一个字都没有 —— 这不是"生成结束"，是真出问题了
          throw new AdapterError(
            `${this.label}：助手气泡已出现但一直没有内容。可能被限流/风控，或页面改版导致正文选择器失效` +
              `（跑 npm run probe -- ${this.id} --send 看看真实结构）。`,
            'selector',
            true,
          );
        }
      }
    } catch (err) {
      if (isAbortError(err)) await this.clickStop(page);
      throw err;
    }

    sink.meta({ tokenEstimate: estimateTokens(last) });
    this.log.info(`${this.label} 网页版回复完成：${last.length} 字`);
  }

  /** 中止生成：优先点平台自己的「停止生成」按钮，点不到就退化成 Esc（并如实记录） */
  async stop(): Promise<void> {
    const page = this.activePage;
    if (!page || page.isClosed()) return;
    await this.clickStop(page);
  }

  /** 平台侧新建对话：优先点页面上的「新建对话」，点不到就直接回首页（首页永远是干净的新对话） */
  async newSession(): Promise<string> {
    const page = await this.pool.openWindow(this.id);
    this.activePage = page;
    await this.preparePage(page);
    await this.openFreshChat(page);
    this.chatDirty = false;
    const key = `${this.id}-web-${Date.now().toString(36)}`;
    this.lastSessionKey = key;
    return key;
  }

  // =============================================================== 可覆写钩子

  /** 等页面能用了：SPA 首屏 + 输入框可见 */
  protected async preparePage(page: Page): Promise<void> {
    await page
      .locator(this.selectors.ready)
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(() => undefined);

    const input = page.locator(this.selectors.input).first();
    if (!(await input.isVisible().catch(() => false))) {
      await input.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
    }
    if (!(await page.locator(this.selectors.input).first().isVisible().catch(() => false))) {
      throw new AdapterError(
        `${this.label}：页面里找不到输入框（选择器 \`${this.selectors.input}\` 未命中）。` +
          `常见原因：① 登录态失效（点顶部「登录」）② 页面改版，选择器要重新校准（npm run probe -- ${this.id} --deep）`,
        'selector',
        true,
      );
    }
  }

  /** 把文字送进输入框：textarea 直接 fill；富文本编辑器用键盘事件（ProseMirror 只认这个） */
  protected async typeText(page: Page, text: string): Promise<void> {
    const input = page.locator(this.selectors.input).first();
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.click();

    if (this.selectors.inputKind === 'textarea') {
      await input.fill('');
      await input.fill(text);
      return;
    }

    // 一次性插入（快）。insertText 会派发 input 事件，ProseMirror / tiptap 能识别
    await page.keyboard.insertText(text);
    await page.waitForTimeout(300);
    const got = normalizeReply(await input.innerText({ timeout: 3_000 }).catch(() => ''));
    if (got.replace(/\s+/g, '').length === 0) {
      this.log.warn(`${this.label}：insertText 没被编辑器接受，回退成逐字输入（长文本会慢一点）`);
      await input.click();
      await page.keyboard.type(text, { delay: 12 });
    }
  }

  /** 提交：Enter 优先（三家实测都吃回车），编辑器吞回车时回退点发送按钮 */
  protected async submit(page: Page): Promise<void> {
    await page.locator(this.selectors.input).first().click().catch(() => undefined);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_200);

    if ((await this.readInputText(page)).trim().length === 0) return; // 发出去了

    this.log.warn(`${this.label}：回车没能发出去，改点发送按钮`);
    const clicked = await this.clickFirst(this.selectors.sendButton, page, 5_000);
    await page.waitForTimeout(800);
    if (!clicked || (await this.readInputText(page)).trim().length > 0) {
      throw new AdapterError(
        `${this.label}：消息发不出去，输入框里还留着内容。请切到浏览器窗口看一眼——` +
          `通常是需要过一次人机验证，或者发送按钮选择器失效（npm run probe -- ${this.id} --deep）。`,
        'selector',
        true,
      );
    }
  }

  /** 读输入框里还剩多少字（用来判断"到底发出去没有"） */
  protected async readInputText(page: Page): Promise<string> {
    const input = page.locator(this.selectors.input).first();
    if (this.selectors.inputKind === 'textarea') {
      return await input.inputValue({ timeout: 3_000 }).catch(() => '');
    }
    return await input.innerText({ timeout: 3_000 }).catch(() => '');
  }

  /**
   * 读"当前这条回复"的文本。
   * assistantMessage 支持多候选（逗号分隔），取第一个命中的候选 —— 页面改版时能自动降级。
   * 每个候选内部再取**最后一个**元素，因为 DOM 里的顺序就是时间顺序。
   */
  protected async readReply(page: Page): Promise<{ text: string; count: number }> {
    for (const one of candidates(this.selectors.assistantMessage)) {
      const locator = page.locator(one);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const text = await locator.nth(count - 1).innerText({ timeout: 4_000 }).catch(() => '');
      return { text: normalizeReply(text), count };
    }
    return { text: '', count: 0 };
  }

  /** 平台是否在生成中（有 streaming 选择器才判断得准，没有就靠静默时长兜底） */
  protected async isStreaming(page: Page): Promise<boolean> {
    if (!this.selectors.streaming) return false;
    return await page.locator(this.selectors.streaming).first().isVisible().catch(() => false);
  }

  /** 上传图片。setInputFiles 直接喂本地绝对路径，绕开系统文件选择框 */
  protected async uploadImages(page: Page, images: AdapterImage[], attachmentsBefore: number): Promise<void> {
    if (!this.selectors.fileInput) {
      throw new AdapterError(
        `${this.label}：没配置图片上传入口（fileInput），带不了这 ${images.length} 张图。` +
          `可先用纯文字发送，或跑 npm run probe -- ${this.id} --deep 找一下 file input。`,
        'selector',
        false,
      );
    }
    const files = images.map((img) => img.path);
    const inputs = page.locator(this.selectors.fileInput);
    const total = await inputs.count().catch(() => 0);
    let uploaded = false;
    for (let index = 0; index < total && !uploaded; index += 1) {
      try {
        await inputs.nth(index).setInputFiles(files, { timeout: 20_000 });
        uploaded = true;
        this.log.info(`${this.label}：已通过第 ${index + 1} 个 file input 上传 ${files.length} 张图`);
      } catch (err) {
        this.log.warn(`${this.label}：第 ${index + 1} 个 file input 上传失败：${(err as Error).message}`);
      }
    }
    if (!uploaded) {
      throw new AdapterError(`${this.label}：图片上传失败（${total} 个 file input 都没吃下文件）`, 'selector', true);
    }
    await this.waitForAttachments(page, attachmentsBefore, images.length);
  }

  /**
   * 图片缩略图数量（全页统计）。
   *
   * 为什么不限定在编辑器范围内：三家的缩略图挂在不同的祖先节点下（DeepSeek 在 editor 之外、
   * 豆包在 ProseMirror 的兄弟节点、Kimi 在 chat-editor 里），范围写死很容易漏。
   * 全页统计 + 看**增量**就够了 —— 头像之类本来就在的图片前后一抵消就没了。
   */
  protected async countThumbnails(page: Page): Promise<number> {
    return (await page
      .evaluate(
        `(function () {
          var imgs = document.querySelectorAll('img');
          var n = 0;
          for (var i = 0; i < imgs.length; i++) {
            var r = imgs[i].getBoundingClientRect();
            if (r.width >= 24 && r.height >= 24) n += 1;
          }
          return n;
        })()`,
      )
      .catch(() => -1)) as number;
  }

  /**
   * 等图片真的挂到输入区（缩略图出现）再去发消息。
   * 这一步很关键：平台上传图片是异步的，缩略图没出来就回车，消息会"只有文字没有图"——
   * 模型会一本正经地回你"我没看到图片"。
   */
  protected async waitForAttachments(page: Page, before: number, expected: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(600);
      const now = await this.countThumbnails(page);
      if (before >= 0 && now > before) {
        this.log.info(`${this.label}：图片已挂到输入区（缩略图 ${before} → ${now}）`);
        return;
      }
    }
    this.log.warn(
      `${this.label}：上传后 30s 内没看到缩略图（期望 ${expected} 张）。` +
        '如果模型回复"我没看到图片"，说明这一家的上传流程变了，请跑 npm run probe -- ' +
        `${this.id} --image=<图片路径> 排查。`,
    );
  }

  /** 开一个干净的平台对话 */
  protected async openFreshChat(page: Page): Promise<void> {
    const clicked = await this.clickFirst(this.selectors.newChat, page, 4_000);
    if (clicked) {
      await page.waitForTimeout(1_800);
      this.log.info(`${this.label}：已点击「新建对话」`);
      return;
    }
    await page
      .goto(PROVIDER_SITES[this.id], { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((err: unknown) => {
        throw new AdapterError(`${this.label}：打开首页失败：${(err as Error).message}`, 'network', true);
      });
    await page.waitForTimeout(2_000);
    this.log.info(`${this.label}：已回到首页开启新对话`);
  }

  /** 登录失效 / 验证码拦截的实时哨兵 */
  protected async assertNotBlocked(page: Page): Promise<void> {
    const url = page.url();
    if (this.loggedOutUrlRe?.test(url)) {
      throw new AdapterError(
        `${this.label}：登录态已失效（页面被重定向到 ${url}）。请回工作台点顶部「登录」，扫码后重发。`,
        'auth',
        false,
      );
    }
    if (!this.selectors.blocked) return;
    const visible = await page.locator(this.selectors.blocked).first().isVisible().catch(() => false);
    if (visible) {
      throw new AdapterError(
        `${this.label}：页面弹出了人机验证/风控提示。请切到浏览器窗口人工过一次（通常只需点一下滑块），过完重发即可。`,
        'captcha',
        true,
      );
    }
  }

  // =============================================================== 内部工具

  /** 把带历史上下文的文本拼出来：新开的平台对话里没有前文，需要自己补 */
  protected composeText(input: AdapterInput): string {
    const text = input.text.trim();
    if (this.chatDirty || input.history.length === 0) return text;
    const context = input.history
      .slice(-6)
      .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
    return [
      '（下面是我俩之前的对话上下文，请据此继续回答，不要在回复里复述这段上下文）',
      context,
      '',
      text,
    ].join('\n');
  }

  /** 依次尝试多候选选择器，点中一个可见的就算成功 */
  protected async clickFirst(selector: string | undefined, page: Page, timeout = 5_000): Promise<boolean> {
    if (!selector) return false;
    for (const one of candidates(selector)) {
      const locator = page.locator(one).first();
      if ((await locator.count().catch(() => 0)) === 0) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;
      try {
        await locator.click({ timeout });
        return true;
      } catch (err) {
        this.log.warn(`${this.label}：点击 ${one} 失败：${(err as Error).message}`);
      }
    }
    return false;
  }

  /** 点「停止生成」。点不到就 Esc —— 并如实说明"可能没真正停掉平台那一侧" */
  protected async clickStop(page: Page): Promise<void> {
    const clicked = await this.clickFirst(this.selectors.stopButton, page, 3_000);
    if (!clicked) await page.keyboard.press('Escape').catch(() => undefined);
    this.log.info(
      `${this.label}：已停止读取${clicked ? '，并点击了平台的停止按钮' : '（没找到平台的停止按钮，只发了 Esc，平台可能在后台继续生成）'}`,
    );
  }

  /** 等首字：判断依据是"助手消息比发送前多了一条 / 文本变了" */
  private async waitForReplyStart(
    page: Page,
    baseline: { text: string; count: number },
    signal: AbortSignal,
    submittedAt: number,
  ): Promise<{ text: string; firstTokenMs: number }> {
    const deadline = Date.now() + this.firstTokenTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs, signal);
      await this.assertNotBlocked(page);
      const current = await this.readReply(page);
      const isNewReply = current.count > baseline.count || (current.text.length > 0 && current.text !== baseline.text);
      if (isNewReply && current.text.length > 0) {
        return { text: current.text, firstTokenMs: Date.now() - submittedAt };
      }
    }
    throw new AdapterError(
      `${this.label}：发送后 ${Math.round(this.firstTokenTimeoutMs / 1000)}s 内没等到回复。` +
        `请切到浏览器窗口确认：① 消息到底发出去没有 ② 有没有弹验证码 ③ 页面是否改版。` +
        `排查工具：npm run probe -- ${this.id} --send`,
      'selector',
      true,
    );
  }

  /** 子类/外部想主动中止时用（预留：目前停止走 orchestrator 的 AbortSignal） */
  protected abortError(): AbortedError {
    return new AbortedError();
  }
}
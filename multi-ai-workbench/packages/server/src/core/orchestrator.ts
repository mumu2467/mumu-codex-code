/**
 * 编排层：一条用户消息 → 扇出到 N 个 adapter → 把流式过程聚合成事件。
 *
 * 这是整个后端唯一知道"并发投递"的地方；adapter 只管自己那一家怎么发。
 */
import type { Provider, Reply, SendResponse } from '@maw/shared';
import { estimateTokens } from '@maw/shared';
import type { EventBus } from './event-bus.js';
import type { ImageStore, StoredImage } from './image-store.js';
import type { SessionStore } from './session-store.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AdapterImage, AdapterInput, ReplySink } from '../adapters/types.js';
import { classifyError, isAbortError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

export interface SendParams {
  sessionId?: string;
  text: string;
  /** base64 data URL 数组 */
  images: string[];
  providers: Provider[];
}

export interface OrchestratorDeps {
  store: SessionStore;
  registry: AdapterRegistry;
  bus: EventBus;
  imageStore: ImageStore;
  log: Logger;
}

/** 流式过程中刷新数据库的最小间隔，避免每个字符都写一次盘 */
const PERSIST_INTERVAL_MS = 500;

export class Orchestrator {
  /** replyId → 中止控制器（停止生成 / 服务关闭时用） */
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: OrchestratorDeps) {}

  get runningCount(): number {
    return this.controllers.size;
  }

  /**
   * 接收一条消息并并发投递给选中的 provider。
   * 立即返回（附带 pending 状态的 replies），真正的输出走 WebSocket 事件流。
   */
  async send(params: SendParams): Promise<SendResponse> {
    const { store, registry, bus, imageStore } = this.deps;
    const text = params.text.trim();
    if (!text && params.images.length === 0) {
      throw new Error('消息内容不能为空（文字与图片至少要有一样）');
    }
    if (params.providers.length === 0) {
      throw new Error('至少勾选一个 AI 才能发送');
    }

    // 1) 图片落盘（失败直接抛给调用方，避免半途投递）
    const stored: StoredImage[] = [];
    for (const dataUrl of params.images) {
      stored.push(await imageStore.saveDataUrl(dataUrl));
    }

    // 2) 会话 + 用户消息入库
    const session = store.ensureSession(params.sessionId, text || '（图片消息）');
    const userMessage = store.addMessage({
      sessionId: session.id,
      role: 'user',
      content: text,
      images: stored.map((s) => s.url),
    });
    const touched = store.touchSession(session.id);
    if (touched) bus.emit({ sessionId: session.id, event: { type: 'session.updated', session: touched } });

    // 3) 为每个 provider 建一条 pending 回复
    const replies = params.providers.map((provider) =>
      store.createReply({
        userMessageId: userMessage.id,
        sessionId: session.id,
        provider,
        route: registry.routeOf(provider),
      }),
    );
    for (const reply of replies) {
      this.emitReplyStatus(reply);
    }

    // 4) 并发扇出（不 await：HTTP 立即返回，结果走 WS）
    for (const reply of replies) {
      void this.run(reply.id, text, stored);
    }

    this.deps.log.info(`会话 ${session.id} 投递「${text.slice(0, 24) || '（图片）'}」→ ${params.providers.join(', ')}`);
    return { messageId: userMessage.id, message: userMessage, replies };
  }

  /** 中止某条回复的生成（保留已产出的半截内容） */
  stop(replyId: string): boolean {
    const controller = this.controllers.get(replyId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 中止某个会话里所有正在生成的回复（Esc 全局停止） */
  stopSession(sessionId: string, provider?: Provider): number {
    let count = 0;
    for (const [replyId, controller] of this.controllers) {
      const reply = this.deps.store.getReply(replyId);
      if (!reply || reply.sessionId !== sessionId) continue;
      if (provider && reply.provider !== provider) continue;
      controller.abort();
      count += 1;
    }
    return count;
  }

  /** 一键重试：把失败的回复重置后重新走一遍发送流程 */
  async retry(replyId: string): Promise<Reply | undefined> {
    const { store, imageStore } = this.deps;
    const existing = store.getReply(replyId);
    if (!existing) return undefined;
    if (this.controllers.has(replyId)) throw new Error('该回复正在生成中，无需重试');

    const userMessage = store.getMessage(existing.userMessageId);
    if (!userMessage) throw new Error('找不到这条回复对应的用户消息');

    const images: StoredImage[] = (userMessage.images ?? [])
      .map((url) => imageStore.fromUrl(url))
      .filter((img): img is StoredImage => img !== undefined);

    store.resetReply(replyId);
    const reset = store.getReply(replyId);
    if (reset) this.emitReplyStatus(reset);

    void this.run(replyId, userMessage.content, images);
    return store.getReply(replyId);
  }

  /** 清空某 provider 在当前会话里的全部回复（三窗页「清空本窗」） */
  clearProvider(sessionId: string, provider: Provider): number {
    this.stopSession(sessionId, provider);
    return this.deps.store.deleteRepliesByProvider(sessionId, provider);
  }

  /** 让某 provider 在当前会话里开一个全新对话（丢弃上下文） */
  async newProviderSession(sessionId: string, provider: Provider): Promise<string> {
    this.stopSession(sessionId, provider);
    this.deps.store.deleteRepliesByProvider(sessionId, provider);
    return this.deps.registry.newSession(sessionId, provider);
  }

  /** 服务关闭：中止所有在途生成 */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  // ------------------------------------------------------------------ 内部

  /** 单条回复的完整生命周期 */
  private async run(replyId: string, text: string, images: StoredImage[]): Promise<void> {
    const { store, registry, bus, log } = this.deps;
    const reply = store.getReply(replyId);
    if (!reply) return;

    const controller = new AbortController();
    this.controllers.set(replyId, controller);

    const startedAt = Date.now();
    let acc = '';
    let firstTokenMs: number | undefined;
    let lastPersist = 0;

    const emit = (event: Parameters<EventBus['emit']>[0]['event']) =>
      bus.emit({ sessionId: reply.sessionId, event });

    const sink: ReplySink = {
      status: (status) => {
        store.updateReply(replyId, { status });
        emit({ type: 'reply.status', replyId, userMessageId: reply.userMessageId, sessionId: reply.sessionId, provider: reply.provider, status });
      },
      delta: (delta, full) => {
        acc = full;
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
        emit({ type: 'reply.delta', replyId, userMessageId: reply.userMessageId, sessionId: reply.sessionId, provider: reply.provider, delta, full });
        const now = Date.now();
        if (now - lastPersist >= PERSIST_INTERVAL_MS) {
          lastPersist = now;
          store.updateReply(replyId, { content: acc, firstTokenMs });
        }
      },
      meta: () => {
        /* 指标最终以 done 事件里的口径为准，这里不额外落库 */
      },
    };

    try {
      const adapter = await registry.resolve(reply.provider);
      sink.status('streaming');

      const input: AdapterInput = {
        userMessageId: reply.userMessageId,
        sessionId: reply.sessionId,
        sessionKey: registry.sessionKeyFor(reply.sessionId, reply.provider),
        text,
        images: images.map<AdapterImage>((img) => ({ path: img.path, url: img.url, mime: img.mime, name: img.name })),
        history: this.buildHistory(reply.sessionId, reply.provider, reply.userMessageId),
      };

      await adapter.send(input, sink, controller.signal);

      const latencyMs = Date.now() - startedAt;
      const tokenEstimate = estimateTokens(acc);
      store.updateReply(replyId, { status: 'done', content: acc, latencyMs, firstTokenMs, tokenEstimate });
      emit({
        type: 'reply.done',
        replyId,
        userMessageId: reply.userMessageId,
        sessionId: reply.sessionId,
        provider: reply.provider,
        content: acc,
        latencyMs,
        firstTokenMs,
        tokenEstimate,
      });
      log.debug(`${reply.provider} 完成：首字 ${firstTokenMs ?? '-'}ms / 总耗时 ${latencyMs}ms / ~${tokenEstimate} token`);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;

      if (isAbortError(err)) {
        // 用户主动停止：保留半截内容，状态判 done，用 stopped 标记区分
        const tokenEstimate = estimateTokens(acc);
        store.updateReply(replyId, {
          status: 'done',
          content: acc,
          latencyMs,
          firstTokenMs,
          tokenEstimate,
          stopped: true,
        });
        emit({
          type: 'reply.done',
          replyId,
          userMessageId: reply.userMessageId,
          sessionId: reply.sessionId,
          provider: reply.provider,
          content: acc,
          latencyMs,
          firstTokenMs,
          tokenEstimate,
          stopped: true,
        });
        log.info(`${reply.provider} 已被用户停止，保留 ${acc.length} 字`);
      } else {
        const { kind, retryable, message } = classifyError(err);
        store.updateReply(replyId, {
          status: 'error',
          content: acc,
          latencyMs,
          firstTokenMs,
          error: message,
          errorKind: kind,
          retryable,
        });
        emit({
          type: 'reply.error',
          replyId,
          userMessageId: reply.userMessageId,
          sessionId: reply.sessionId,
          provider: reply.provider,
          error: message,
          kind,
          retryable,
        });
        // 需要人工介入的错误，额外推一条 auth.required，前端据此弹引导（降级阶梯 L1）
        if (kind === 'auth' || kind === 'captcha') {
          emit({
            type: 'auth.required',
            sessionId: reply.sessionId,
            provider: reply.provider,
            reason: kind === 'auth' ? 'login' : 'captcha',
            hint: message,
          });
        }
        log.warn(`${reply.provider} 失败(${kind})：${message}`);
      }
    } finally {
      this.controllers.delete(replyId);
    }
  }

  private emitReplyStatus(reply: Reply): void {
    this.deps.bus.emit({
      sessionId: reply.sessionId,
      event: {
        type: 'reply.status',
        replyId: reply.id,
        userMessageId: reply.userMessageId,
        sessionId: reply.sessionId,
        provider: reply.provider,
        status: reply.status,
      },
    });
  }

  /** 组装该 provider 在本会话里的历史轮次（最近的若干轮），供真实 adapter 拼接上下文 */
  private buildHistory(sessionId: string, provider: Provider, currentUserMessageId: string) {
    const { store } = this.deps;
    const userMessages = store.listMessages(sessionId).filter((m) => m.role === 'user');
    const replies = store.listReplies(sessionId).filter((r) => r.provider === provider && r.status === 'done');
    const byUserMessage = new Map(replies.map((r) => [r.userMessageId, r]));

    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const message of userMessages) {
      if (message.id === currentUserMessageId) break;
      turns.push({ role: 'user', content: message.content });
      const reply = byUserMessage.get(message.id);
      if (reply?.content) turns.push({ role: 'assistant', content: reply.content });
    }
    // 只保留最近 6 条（3 轮），避免上下文过长
    return turns.slice(-6);
  }
}
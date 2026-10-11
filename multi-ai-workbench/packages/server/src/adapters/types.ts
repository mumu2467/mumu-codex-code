/**
 * ChatAdapter 抽象契约 —— 整个后端的核心扩展点。
 *
 * 只要实现这个接口，就能接入一家新的 AI；编排层（Orchestrator）完全不关心
 * 背后是 Playwright 驱动网页版、还是官方 API，还是本地 mock。
 *
 * 约定：adapter 内部出错时 **直接 throw AdapterError**（携带 kind / retryable），
 * 由编排层统一分类并转成 reply.error 事件——比让 adapter 自己回调错误更不容易漏。
 */
import type { AdapterRoute, Provider, ReplyStatus } from '@maw/shared';

/** 已落盘的图片，adapter 既能拿到本地路径（用于 Playwright setInputFiles），也能拿到可访问 URL */
export interface AdapterImage {
  path: string;
  url: string;
  mime: string;
  name: string;
}

export interface AdapterInput {
  userMessageId: string;
  sessionId: string;
  /** 平台侧会话标识；调用 newSession() 后会换成新的 */
  sessionKey: string;
  text: string;
  images: AdapterImage[];
  /** 该 provider 在本会话里此前的对话轮次（真实 adapter 可用来做上下文拼接） */
  history: { role: 'user' | 'assistant'; content: string }[];
}

/** adapter → 编排层的回调通道（单向，只吐数据不返回值） */
export interface ReplySink {
  /** 状态机流转：pending → streaming →（编排层负责 done/error） */
  status(status: ReplyStatus): void;
  /** 流式增量 + 截至当前的完整快照 */
  delta(delta: string, full: string): void;
  /** 中间指标（首字延迟等），可在流式过程中多次上报 */
  meta(meta: { firstTokenMs?: number; latencyMs?: number; tokenEstimate?: number }): void;
}

export interface AdapterHealth {
  ok: boolean;
  /** 人类可读的原因，会显示在前端"通道状态"里 */
  reason?: string;
}

export interface ChatAdapter {
  readonly id: Provider;
  readonly route: AdapterRoute;

  /** 启动/连接：Playwright 通道在这里取或建 BrowserContext；API 通道在这里校验 key */
  init(): Promise<void>;
  /** 体检：登录态是否有效、选择器是否命中、额度是否可用 */
  health(): Promise<AdapterHealth>;
  /** 发送一条消息，生命周期内持续回调 sink，直到正常返回或被 signal 中止 */
  send(input: AdapterInput, sink: ReplySink, signal: AbortSignal): Promise<void>;
  /** 中止当前生成（Playwright 通道对应"点平台自身的停止按钮"） */
  stop(): Promise<void>;
  /** 平台侧"新建对话"，返回新的 sessionKey */
  newSession(): Promise<string>;
  /** 释放资源 */
  dispose(): Promise<void>;
}

/** 三个通道共用的返回：route 未实现时给出明确的、可操作的报错 */
export function unsupportedRoute(provider: Provider, route: AdapterRoute): Error {
  const step = route === 'playwright' ? 'Step 3' : 'Step 7';
  return new Error(
    `provider「${provider}」配置的执行通道是 "${route}"，该通道尚未交付（计划在 ${step}）。` +
      `当前请把环境变量 ADAPTER_${provider.toUpperCase()} 设为 mock。`,
  );
}
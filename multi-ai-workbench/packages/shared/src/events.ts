/**
 * WebSocket 事件协议（单一事实来源）。
 * 任何一端改协议，另一端在 typecheck 阶段就会报错。
 */
import type { AdapterRoute, ErrorKind, Provider, ReplyStatus, Session, VoteValue } from './types.js';

/** 服务端 → 客户端 */
export type ServerEvent =
  /** 连接建立后的握手，告知当前各 provider 的执行通道 */
  | { type: 'hello'; providers: Record<Provider, { route: AdapterRoute; ok: boolean; reason?: string }> }
  /** 状态机流转（pending → streaming → done/error） */
  | { type: 'reply.status'; replyId: string; userMessageId: string; sessionId: string; provider: Provider; status: ReplyStatus }
  /** 流式增量；full 是截至当前的完整快照，便于乱序/丢包时自我修复 */
  | { type: 'reply.delta'; replyId: string; userMessageId: string; sessionId: string; provider: Provider; delta: string; full: string }
  /** 回复完成；stopped=true 表示被用户中途停止 */
  | { type: 'reply.done'; replyId: string; userMessageId: string; sessionId: string; provider: Provider; content: string; latencyMs: number; firstTokenMs?: number; tokenEstimate: number; stopped?: boolean }
  /** 回复失败；kind 决定 UI 的处置建议，retryable 决定是否显示"重试" */
  | { type: 'reply.error'; replyId: string; userMessageId: string; sessionId: string; provider: Provider; error: string; kind: ErrorKind; retryable: boolean }
  /** 需要人工介入（登录失效 / 验证码）；Step 3 起由 Playwright 通道触发 */
  | { type: 'auth.required'; sessionId: string; provider: Provider; reason: 'login' | 'captcha'; hint: string }
  /** 会话元信息变化（标题、更新时间、置顶） */
  | { type: 'session.updated'; session: Session }
  /** 某条回复的点赞/采纳发生变化 */
  | { type: 'reply.vote'; replyId: string; sessionId: string; vote: VoteValue }
  /** 心跳应答 */
  | { type: 'pong'; t: number };

/** 客户端 → 服务端 */
export type ClientEvent =
  /** 订阅某个会话的事件流（切换会话时重新发） */
  | { type: 'subscribe'; sessionId: string }
  /** 心跳 */
  | { type: 'ping'; t: number };

/** 事件里携带的会话 id（用于路由到订阅了该会话的连接） */
export function eventSessionId(event: ServerEvent): string | undefined {
  switch (event.type) {
    case 'reply.status':
    case 'reply.delta':
    case 'reply.done':
    case 'reply.error':
    case 'auth.required':
      return event.sessionId;
    case 'session.updated':
      return event.session.id;
    case 'reply.vote':
      return event.sessionId;
    default:
      return undefined;
  }
}
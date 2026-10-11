/** 后端内部事件总线：orchestrator 产出事件 → hub 广播给 WS 客户端 */
import type { ServerEvent } from '@maw/shared';

export interface Envelope {
  /** 事件归属的会话；没有会话维度的事件（如 hello）为 undefined */
  sessionId?: string;
  event: ServerEvent;
}

type Listener = (envelope: Envelope) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(envelope: Envelope): void {
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (err) {
        console.error('[event-bus] 监听器抛错：', err);
      }
    }
  }
}
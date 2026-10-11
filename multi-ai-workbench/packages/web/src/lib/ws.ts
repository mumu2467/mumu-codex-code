/** WebSocket 客户端：自动重连 + 重连后自动重新订阅会话 */
import type { ClientEvent, ServerEvent } from '@maw/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

interface Handlers {
  onEvent(event: ServerEvent): void;
  onStatus(status: WsStatus): void;
}

export class WsClient {
  private socket?: WebSocket;
  private timer?: number;
  private attempt = 0;
  private destroyed = false;
  private sessionId?: string;

  constructor(private readonly handlers: Handlers) {}

  /** 是否已被销毁（销毁后的实例不可复用） */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  connect(): void {
    if (this.destroyed) return;
    this.handlers.onStatus('connecting');

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
      // 重连成功后必须重新订阅，否则收不到该会话的任何事件
      if (this.sessionId) this.send({ type: 'subscribe', sessionId: this.sessionId });
    };

    socket.onmessage = (event) => {
      try {
        this.handlers.onEvent(JSON.parse(String(event.data)) as ServerEvent);
      } catch {
        /* 非法消息忽略 */
      }
    };

    socket.onclose = () => {
      this.handlers.onStatus('closed');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onerror 之后必定会触发 onclose，重连逻辑统一放在那里
      socket.close();
    };
  }

  subscribe(sessionId: string): void {
    this.sessionId = sessionId;
    this.send({ type: 'subscribe', sessionId });
  }

  send(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    // 指数退避，上限 8s，避免后端没起来时刷屏
    const delay = Math.min(8000, 400 * 2 ** this.attempt++);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }
}
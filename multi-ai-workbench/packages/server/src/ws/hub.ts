/**
 * WebSocket Hub：连接管理 + 会话订阅 + 广播。
 * 只做"把一个事件送到关心它的连接"这一件事，不含业务逻辑。
 */
import { WebSocket, type RawData } from 'ws';
import type { ClientEvent, ServerEvent } from '@maw/shared';
import { eventSessionId } from '@maw/shared';
import type { EventBus, Envelope } from '../core/event-bus.js';
import type { Logger } from '../utils/logger.js';

interface ClientState {
  /** 当前订阅的会话；未订阅时只收 hello/pong 这类全局事件 */
  sessionId?: string;
  alive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class WsHub {
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    bus: EventBus,
    private readonly log: Logger,
    /** 连接建立时下发的握手事件（含各 provider 的通道状态） */
    private readonly hello: ServerEvent,
  ) {
    bus.on((envelope) => this.dispatch(envelope));
  }

  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [socket, state] of this.clients) {
        if (!state.alive) {
          this.log.warn('客户端心跳超时，断开连接');
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        state.alive = false;
        try {
          socket.ping();
        } catch {
          this.clients.delete(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** 注册一条新连接（由 fastify 的 /ws 路由调用） */
  register(socket: WebSocket): void {
    const state: ClientState = { alive: true };
    this.clients.set(socket, state);
    this.log.debug(`新连接，当前 ${this.clients.size} 条`);

    socket.on('pong', () => {
      state.alive = true;
    });

    socket.on('message', (raw: RawData) => {
      state.alive = true;
      this.handleMessage(socket, state, raw.toString());
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.log.debug(`连接关闭，剩余 ${this.clients.size} 条`);
    });

    socket.on('error', (err: Error) => {
      this.log.warn(`连接异常：${err.message}`);
      this.clients.delete(socket);
    });

    this.sendTo(socket, this.hello);
  }

  /** 关闭所有连接（服务退出时） */
  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private handleMessage(socket: WebSocket, state: ClientState, raw: string): void {
    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      this.log.warn(`收到非 JSON 消息，已忽略：${raw.slice(0, 120)}`);
      return;
    }

    switch (event.type) {
      case 'subscribe':
        state.sessionId = event.sessionId;
        this.log.debug(`订阅会话 ${event.sessionId}`);
        break;
      case 'ping':
        this.sendTo(socket, { type: 'pong', t: event.t ?? Date.now() });
        break;
      default:
        this.log.warn(`未知的客户端事件：${(event as { type?: string }).type}`);
    }
  }

  private dispatch(envelope: Envelope): void {
    const sessionId = envelope.sessionId ?? eventSessionId(envelope.event);
    for (const [socket, state] of this.clients) {
      // 无会话维度的事件（hello/pong）不经过这里；有会话维度的事件只发给订阅者
      if (sessionId && state.sessionId !== sessionId) continue;
      this.sendTo(socket, envelope.event);
    }
  }

  private sendTo(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(event));
    } catch (err) {
      this.log.warn(`发送失败：${(err as Error).message}`);
    }
  }
}
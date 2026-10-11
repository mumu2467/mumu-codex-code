/**
 * Adapter 注册表：provider → adapter 实例（按执行通道懒创建）。
 * 新增一家 AI 只需在 PROVIDERS 里加枚举 + 在这里加一个 case，其余代码零改动。
 */
import type { AdapterRoute, Provider } from '@maw/shared';
import { PROVIDERS } from '@maw/shared';
import { MockAdapter } from './mock-adapter.js';
import { unsupportedRoute, type ChatAdapter } from './types.js';
import type { Logger } from '../utils/logger.js';

export class AdapterRegistry {
  private readonly routes: Record<Provider, AdapterRoute>;
  private readonly adapters = new Map<Provider, ChatAdapter>();
  /** `${sessionId}:${provider}` → 平台侧会话 key */
  private readonly sessionKeys = new Map<string, string>();

  constructor(
    routes: Record<Provider, AdapterRoute>,
    private readonly mockSpeed: number,
    private readonly log: Logger,
  ) {
    this.routes = { ...routes };
  }

  routeOf(provider: Provider): AdapterRoute {
    return this.routes[provider];
  }

  /** 当前所有通道状态，用于 /api/health 与 WS 握手 */
  async healthMap(): Promise<Record<Provider, { route: AdapterRoute; ok: boolean; reason?: string }>> {
    const entries = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const route = this.routes[provider];
        if (route !== 'mock') {
          return [provider, { route, ok: false, reason: unsupportedRoute(provider, route).message }] as const;
        }
        const adapter = await this.resolve(provider);
        const health = await adapter.health();
        return [provider, { route, ok: health.ok, reason: health.reason }] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<Provider, { route: AdapterRoute; ok: boolean; reason?: string }>;
  }

  async initAll(): Promise<void> {
    for (const provider of PROVIDERS) {
      if (this.routes[provider] !== 'mock') continue;
      await (await this.resolve(provider)).init();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.dispose().catch(() => undefined)));
    this.adapters.clear();
  }

  /** 运行时热切换执行通道（mock → playwright/api 需要重启后才会真正建连） */
  setRoute(provider: Provider, route: AdapterRoute): void {
    if (this.routes[provider] === route) return;
    this.routes[provider] = route;
    this.adapters.delete(provider);
    this.log.info(`通道已切换：${provider} → ${route}`);
  }

  async resolve(provider: Provider): Promise<ChatAdapter> {
    const cached = this.adapters.get(provider);
    if (cached) return cached;

    const route = this.routes[provider];
    let adapter: ChatAdapter;
    switch (route) {
      case 'mock':
        adapter = new MockAdapter(provider, this.mockSpeed);
        break;
      case 'playwright':
      case 'api':
        throw unsupportedRoute(provider, route);
      default: {
        const never: never = route;
        throw new Error(`未知执行通道：${String(never)}`);
      }
    }
    await adapter.init();
    this.adapters.set(provider, adapter);
    return adapter;
  }

  /** 每个 (会话, provider) 一个平台侧会话 key；「新会话」会刷新它 */
  sessionKeyFor(sessionId: string, provider: Provider): string {
    const key = `${sessionId}:${provider}`;
    const existing = this.sessionKeys.get(key);
    if (existing) return existing;
    const fresh = `${provider}-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
    this.sessionKeys.set(key, fresh);
    return fresh;
  }

  /** 让该 provider 在指定会话里开启一个全新对话（丢弃上下文） */
  async newSession(sessionId: string, provider: Provider): Promise<string> {
    const adapter = await this.resolve(provider);
    const fresh = await adapter.newSession();
    this.sessionKeys.set(`${sessionId}:${provider}`, fresh);
    return fresh;
  }
}
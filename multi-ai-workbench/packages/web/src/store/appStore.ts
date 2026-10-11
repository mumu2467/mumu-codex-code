/**
 * 全局状态（zustand）。
 * 唯一的数据来源是后端：所有本地写入都由 REST 响应或 WebSocket 事件驱动，
 * 前端不自己"编"消息，避免与服务端不一致。
 */
import { create } from 'zustand';
import type {
  AdapterRoute,
  Message,
  Provider,
  Reply,
  ServerEvent,
  Session,
  VoteValue,
} from '@maw/shared';
import { PROVIDERS, PROVIDER_META, providerLabel } from '@maw/shared';
import { api } from '../lib/api';
import { WsClient, type WsStatus } from '../lib/ws';

export interface Notice {
  id: string;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface AuthPrompt {
  provider: Provider;
  reason: 'login' | 'captcha';
  hint: string;
}

interface RouteInfo {
  route: AdapterRoute;
  ok: boolean;
  reason?: string;
}

interface AppState {
  // ---- 连接 ----
  wsStatus: WsStatus;
  routeInfo: Record<Provider, RouteInfo>;

  // ---- 全局开关（顶部勾选）----
  enabled: Record<Provider, boolean>;

  // ---- 当前会话 ----
  sessions: Session[];
  currentSessionId: string | null;
  currentSession: Session | null;
  messages: Message[];
  replies: Record<string, Reply>;

  // ---- UI 反馈 ----
  notices: Notice[];
  authPrompts: AuthPrompt[];
  sending: boolean;
  loadingSession: boolean;

  bootstrap(): Promise<void>;
  setWsStatus(status: WsStatus): void;
  applyServerEvent(event: ServerEvent): void;
  toggleProvider(provider: Provider): void;
  setProviderEnabled(provider: Provider, enabled: boolean): void;

  refreshSessions(): Promise<void>;
  selectSession(id: string): Promise<void>;
  createSession(): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  removeSession(id: string): Promise<void>;

  sendMessage(text: string, images: string[]): Promise<void>;
  stopReply(replyId: string): Promise<void>;
  stopAll(): Promise<void>;
  retryReply(replyId: string): Promise<void>;
  clearProvider(provider: Provider): Promise<void>;
  newProviderSession(provider: Provider): Promise<void>;
  vote(replyId: string, vote: VoteValue): Promise<void>;

  notify(kind: Notice['kind'], text: string): void;
  dismissNotice(id: string): void;
  dismissAuthPrompt(provider: Provider): void;
}

const ALL_ENABLED: Record<Provider, boolean> = { deepseek: true, doubao: true, kimi: true };

/** 未收到 hello 之前的兜底通道信息 */
const DEFAULT_ROUTES: Record<Provider, RouteInfo> = {
  deepseek: { route: 'mock', ok: true },
  doubao: { route: 'mock', ok: true },
  kimi: { route: 'mock', ok: true },
};

let noticeSeq = 0;

export const useAppStore = create<AppState>((set, get) => ({
  wsStatus: 'connecting',
  routeInfo: DEFAULT_ROUTES,
  enabled: { ...ALL_ENABLED },
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  messages: [],
  replies: {},
  notices: [],
  authPrompts: [],
  sending: false,
  loadingSession: false,

  // ------------------------------------------------------------ 启动与连接

  async bootstrap() {
    try {
      const health = await api.health();
      set({ routeInfo: health.providers });
    } catch {
      get().notify('error', '连不上后端服务，请确认 `npm run dev:server` 已启动');
    }

    await get().refreshSessions();
    const { sessions, currentSessionId } = get();
    if (currentSessionId) return;
    if (sessions.length > 0) {
      await get().selectSession(sessions[0]!.id);
    } else {
      await get().createSession();
    }
  },

  setWsStatus(status) {
    set({ wsStatus: status });
  },

  applyServerEvent(event) {
    switch (event.type) {
      case 'hello':
        set({ routeInfo: event.providers });
        return;

      case 'reply.status':
        set((s) => ({
          replies: upsertReply(s, event, { status: event.status }),
        }));
        return;

      case 'reply.delta':
        set((s) => ({
          replies: upsertReply(s, event, { status: 'streaming', content: event.full, error: undefined }),
        }));
        return;

      case 'reply.done':
        set((s) => ({
          replies: upsertReply(s, event, {
            status: 'done',
            content: event.content,
            latencyMs: event.latencyMs,
            firstTokenMs: event.firstTokenMs,
            tokenEstimate: event.tokenEstimate,
            stopped: event.stopped,
            error: undefined,
            errorKind: undefined,
          }),
        }));
        return;

      case 'reply.error':
        set((s) => ({
          replies: upsertReply(s, event, {
            status: 'error',
            error: event.error,
            errorKind: event.kind,
            retryable: event.retryable,
          }),
        }));
        return;

      case 'reply.vote':
        set((s) => {
          const existing = s.replies[event.replyId];
          if (!existing) return {};
          return { replies: { ...s.replies, [event.replyId]: { ...existing, vote: event.vote } } };
        });
        return;

      case 'session.updated':
        set((s) => {
          const others = s.sessions.filter((x) => x.id !== event.session.id);
          const sessions = [event.session, ...others].sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
          );
          return {
            sessions,
            currentSession: s.currentSessionId === event.session.id ? event.session : s.currentSession,
          };
        });
        return;

      case 'auth.required':
        set((s) => ({
          authPrompts: [
            ...s.authPrompts.filter((p) => p.provider !== event.provider),
            { provider: event.provider, reason: event.reason, hint: event.hint },
          ],
        }));
        return;

      case 'pong':
        return;

      default:
        return;
    }
  },

  // ---------------------------------------------------------------- 开关

  toggleProvider(provider) {
    set((s) => ({ enabled: { ...s.enabled, [provider]: !s.enabled[provider] } }));
  },

  setProviderEnabled(provider, enabled) {
    set((s) => ({ enabled: { ...s.enabled, [provider]: enabled } }));
  },

  // ---------------------------------------------------------------- 会话

  async refreshSessions() {
    try {
      set({ sessions: await api.listSessions() });
    } catch (err) {
      get().notify('error', `会话列表加载失败：${(err as Error).message}`);
    }
  },

  async selectSession(id) {
    set({ loadingSession: true });
    try {
      const bundle = await api.sessionBundle(id);
      const replies: Record<string, Reply> = {};
      for (const reply of bundle.replies) replies[reply.id] = reply;
      set({
        currentSessionId: id,
        currentSession: bundle.session,
        messages: bundle.messages,
        replies,
      });
      wsClient?.subscribe(id);
    } catch (err) {
      get().notify('error', `会话加载失败：${(err as Error).message}`);
    } finally {
      set({ loadingSession: false });
    }
  },

  async createSession() {
    try {
      const session = await api.createSession();
      set((s) => ({
        sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
        currentSessionId: session.id,
        currentSession: session,
        messages: [],
        replies: {},
      }));
      wsClient?.subscribe(session.id);
    } catch (err) {
      get().notify('error', `新建会话失败：${(err as Error).message}`);
    }
  },

  async renameSession(id, title) {
    try {
      const session = await api.updateSession(id, { title });
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? session : x)) }));
    } catch (err) {
      get().notify('error', `重命名失败：${(err as Error).message}`);
    }
  },

  async removeSession(id) {
    try {
      await api.deleteSession(id);
      const remaining = get().sessions.filter((x) => x.id !== id);
      set({ sessions: remaining });
      if (get().currentSessionId === id) {
        if (remaining.length > 0) await get().selectSession(remaining[0]!.id);
        else await get().createSession();
      }
    } catch (err) {
      get().notify('error', `删除失败：${(err as Error).message}`);
    }
  },

  // ------------------------------------------------------------ 发送与生成

  async sendMessage(text, images) {
    const state = get();
    const providers = PROVIDERS.filter((p) => state.enabled[p]);
    if (providers.length === 0) {
      get().notify('warn', '至少勾选一个 AI 再发送');
      return;
    }
    if (!text.trim() && images.length === 0) return;

    set({ sending: true });
    try {
      const res = await api.send({
        sessionId: state.currentSessionId ?? undefined,
        text,
        images,
        providers,
      });

      set((s) => {
        // 用户消息只有在还没出现过时才追加（防止与服务端事件重复）
        const messages = s.messages.some((m) => m.id === res.message.id)
          ? s.messages
          : [...s.messages, res.message];

        // 已存在的回复保留现值：WS 的增量可能已经跑到 POST 响应前面了
        const replies = { ...s.replies };
        for (const reply of res.replies) {
          if (!replies[reply.id]) replies[reply.id] = reply;
        }

        return {
          messages,
          replies,
          currentSessionId: res.message.sessionId,
          sending: false,
        };
      });

      if (state.currentSessionId !== res.message.sessionId) {
        wsClient?.subscribe(res.message.sessionId);
      }
      void get().refreshSessions();
    } catch (err) {
      set({ sending: false });
      get().notify('error', (err as Error).message);
    }
  },

  async stopReply(replyId) {
    try {
      await api.stop(replyId);
    } catch (err) {
      get().notify('error', `停止失败：${(err as Error).message}`);
    }
  },

  async stopAll() {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      const res = await api.stopSession(sessionId);
      if (res.stopped > 0) get().notify('info', `已停止 ${res.stopped} 路生成`);
    } catch (err) {
      get().notify('error', `停止失败：${(err as Error).message}`);
    }
  },

  async retryReply(replyId) {
    try {
      const { reply } = await api.retry(replyId);
      set((s) => ({ replies: { ...s.replies, [reply.id]: reply } }));
    } catch (err) {
      get().notify('error', `重试失败：${(err as Error).message}`);
    }
  },

  async clearProvider(provider) {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      const res = await api.clearProvider(sessionId, provider);
      set((s) => {
        const replies: Record<string, Reply> = {};
        for (const [id, reply] of Object.entries(s.replies)) {
          if (reply.provider !== provider) replies[id] = reply;
        }
        return { replies };
      });
      get().notify('info', `${providerLabel(provider)} 已清空 ${res.removed} 条回复`);
    } catch (err) {
      get().notify('error', `清空失败：${(err as Error).message}`);
    }
  },

  async newProviderSession(provider) {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      await api.newProviderSession(sessionId, provider);
      set((s) => {
        const replies: Record<string, Reply> = {};
        for (const [id, reply] of Object.entries(s.replies)) {
          if (reply.provider !== provider) replies[id] = reply;
        }
        return { replies };
      });
      get().notify('info', `${providerLabel(provider)} 已开启新会话`);
    } catch (err) {
      get().notify('error', `开启新会话失败：${(err as Error).message}`);
    }
  },

  async vote(replyId, vote) {
    // 乐观点亮，失败再回滚
    const previous = get().replies[replyId]?.vote ?? null;
    set((s) => {
      const existing = s.replies[replyId];
      if (!existing) return {};
      return { replies: { ...s.replies, [replyId]: { ...existing, vote } } };
    });
    try {
      const updated = await api.vote(replyId, vote);
      set((s) => ({ replies: { ...s.replies, [updated.id]: updated } }));
    } catch (err) {
      set((s) => {
        const existing = s.replies[replyId];
        if (!existing) return {};
        return { replies: { ...s.replies, [replyId]: { ...existing, vote: previous } } };
      });
      get().notify('error', `投票失败：${(err as Error).message}`);
    }
  },

  // ---------------------------------------------------------------- 提示

  notify(kind, text) {
    const id = `notice_${++noticeSeq}`;
    set((s) => ({ notices: [...s.notices, { id, kind, text }] }));
    window.setTimeout(() => get().dismissNotice(id), kind === 'error' ? 8000 : 4000);
  },

  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  dismissAuthPrompt(provider) {
    set((s) => ({ authPrompts: s.authPrompts.filter((p) => p.provider !== provider) }));
  },
}));

// ------------------------------------------------------------------ 内部工具

/** 用事件里的字段补全/更新 replies 表 */
function upsertReply(
  state: Pick<AppState, 'replies' | 'routeInfo'>,
  base: { replyId: string; userMessageId: string; sessionId: string; provider: Provider },
  patch: Partial<Reply>,
): Record<string, Reply> {
  const existing = state.replies[base.replyId];
  const merged: Reply = existing
    ? { ...existing, ...patch }
    : {
        id: base.replyId,
        userMessageId: base.userMessageId,
        sessionId: base.sessionId,
        provider: base.provider,
        content: '',
        status: 'pending',
        route: state.routeInfo[base.provider]?.route ?? 'mock',
        vote: null,
        createdAt: Date.now(),
        ...patch,
      };
  return { ...state.replies, [base.replyId]: merged };
}

/** 供 UI 取用的品牌色（避免到处 import） */
export function providerColor(provider: Provider): string {
  return PROVIDER_META[provider].color;
}

// ------------------------------------------------------------------ 实时连接

let wsClient: WsClient | null = null;

/**
 * 在 App 挂载时调用一次，返回同一个单例。
 *
 * 注意：React 18 StrictMode 会「挂载 → 卸载 → 再挂载」跑两遍副作用。
 * 如果第一次的清理把单例 destroy 掉了，第二次必须能拿到一个**新实例**，
 * 否则连接会永远建立不起来（destroyed 之后的实例 connect() 直接 return）。
 */
export function initRealtime(): WsClient {
  if (wsClient && !wsClient.isDestroyed) return wsClient;
  wsClient = new WsClient({
    onEvent: (event) => useAppStore.getState().applyServerEvent(event),
    onStatus: (status) => useAppStore.getState().setWsStatus(status),
  });
  wsClient.connect();
  return wsClient;
}
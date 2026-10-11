/** 后端 REST 客户端：统一错误处理，失败时抛出带中文原因的 Error */
import type {
  AdapterRoute,
  HealthResponse,
  Provider,
  ProviderStatus,
  Reply,
  SendResponse,
  Session,
  SessionBundle,
  VoteValue,
} from '@maw/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* 响应不是 JSON，用默认文案 */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  providers: () => request<ProviderStatus[]>('/api/providers'),

  listSessions: (q?: string) => request<Session[]>(`/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createSession: (title?: string) => post<Session>('/api/sessions', { title }),
  updateSession: (id: string, patch: { title?: string; pinned?: boolean }) =>
    request<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  sessionBundle: (id: string) => request<SessionBundle>(`/api/sessions/${id}/messages`),

  send: (payload: { sessionId?: string; text: string; images: string[]; providers: Provider[] }) =>
    post<SendResponse>('/api/send', payload),
  stop: (replyId: string) => post<{ ok: boolean; stopped: number }>('/api/stop', { replyId }),
  stopSession: (sessionId: string, provider?: Provider) => post<{ ok: boolean; stopped: number }>('/api/stop', { sessionId, provider }),
  retry: (replyId: string) => post<{ reply: Reply }>('/api/retry', { replyId }),
  clearProvider: (sessionId: string, provider: Provider) =>
    post<{ ok: boolean; removed: number }>('/api/replies/clear', { sessionId, provider }),
  newProviderSession: (sessionId: string, provider: Provider) =>
    post<{ ok: boolean; provider: Provider; sessionKey: string }>('/api/providers/new-session', { sessionId, provider }),
  setRoute: (provider: Provider, route: AdapterRoute) => post<{ ok: boolean }>('/api/providers/route', { provider, route }),
  vote: (replyId: string, vote: VoteValue) => post<Reply>(`/api/replies/${replyId}/vote`, { vote }),

  exportUrl: (sessionId: string, format: 'md' | 'json') => `/api/export/${sessionId}?format=${format}`,
};
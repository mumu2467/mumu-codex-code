/**
 * HTTP 接口层：只做"解析 → 调编排层 → 序列化"，不写业务逻辑。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HealthResponse, Provider } from '@maw/shared';
import { PROVIDER_META, isProvider, normalizeProviders, providerLabel } from '@maw/shared';
import type { Orchestrator } from '../core/orchestrator.js';
import type { EventBus } from '../core/event-bus.js';
import type { ImageStore } from '../core/image-store.js';
import type { SessionStore } from '../core/session-store.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import type { LoginService } from '../browser/login-service.js';
import { config } from '../config.js';
import type { Logger } from '../utils/logger.js';

export interface RouteDeps {
  store: SessionStore;
  orchestrator: Orchestrator;
  registry: AdapterRegistry;
  imageStore: ImageStore;
  bus: EventBus;
  log: Logger;
  startedAt: number;
  /** Playwright 浏览器池（登录窗口、profile 状态都走它） */
  pool: BrowserPool;
  /** 人工扫码登录服务 */
  login: LoginService;
}

const SendBody = z.object({
  sessionId: z.string().min(1).optional(),
  text: z.string().max(20_000).default(''),
  /** base64 data URL；前端已做压缩，单张一般 < 1MB */
  images: z.array(z.string()).max(8).default([]),
  providers: z.array(z.string()).optional(),
});

const VoteBody = z.object({
  vote: z.union([z.literal('up'), z.literal('best'), z.null()]),
});

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { store, orchestrator, registry, imageStore, bus, log, startedAt, pool, login } = deps;

  // ---------------------------------------------------------------- 健康检查

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    name: config.name,
    version: config.version,
    uptimeMs: Date.now() - startedAt,
    providers: await registry.healthMap(),
  }));

  app.get('/api/providers', async () =>
    registry
      .healthMap()
      .then((map) =>
        (Object.keys(map) as Provider[]).map((provider) => ({
          provider,
          label: providerLabel(provider),
          blurb: PROVIDER_META[provider].blurb,
          route: map[provider].route,
          ok: map[provider].ok,
          reason: map[provider].reason,
        })),
      ),
  );

  // ------------------------------------------------------------- 登录（Playwright 通道）

  /** 登录进度 + 浏览器 profile 概览 */
  app.get('/api/login/status', async () => ({
    ok: true,
    headless: config.browser.headless,
    profileRoot: config.browser.profileRoot,
    stateDir: config.browser.stateDir,
    providers: login.status(),
    profiles: pool.status(),
  }));

  /**
   * 打开指定 provider 的真实浏览器窗口，等你在窗口里扫码登录。
   * 立即返回，前端随后轮询 /api/login/status 看进度。
   */
  app.post('/api/login', async (request, reply) => {
    const body = z.object({ providers: z.array(z.string()).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '请求体不合法：providers 应为字符串数组' });
    if (config.browser.headless) {
      return reply.code(409).send({
        error:
          '当前是 headless 模式，浏览器不会显示窗口，没法扫码登录。' +
          '请把 .env 里的 BROWSER_HEADLESS 设为 false 后重启服务。',
      });
    }
    const providers = normalizeProviders(body.data.providers);
    log.info(`发起登录：${providers.join('、')}`);
    return { ok: true, providers: await login.start(providers) };
  });

  /** 手动确认已登录：跳过自动检测，直接保存当前登录态（选择器不准时的兜底） */
  app.post('/api/login/confirm', async (request, reply) => {
    const body = z.object({ provider: z.string() }).safeParse(request.body ?? {});
    if (!body.success || !isProvider(body.data.provider)) {
      return reply.code(400).send({ error: '请求体不合法：provider 必填，且需为 deepseek / doubao / kimi' });
    }
    return { ok: true, provider: await login.confirm(body.data.provider) };
  });

  /** 停止轮询登录状态（窗口保持打开，可继续手动登录） */
  app.post('/api/login/cancel', async (request, reply) => {
    const body = z.object({ providers: z.array(z.string()).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '请求体不合法：providers 应为字符串数组' });
    return { ok: true, providers: login.cancel(normalizeProviders(body.data.providers)) };
  });

  /**
   * 导出某家当前的 storageState（登录态备份）。
   * 应用内登录时 profile 本身就持久化了，这个接口主要用于把登录态拷到别处。
   */
  app.post('/api/login/export', async (request, reply) => {
    const body = z.object({ provider: z.string() }).safeParse(request.body ?? {});
    if (!body.success || !isProvider(body.data.provider)) {
      return reply.code(400).send({ error: '请求体不合法：provider 必填，且需为 deepseek / doubao / kimi' });
    }
    try {
      return { ok: true, file: await pool.saveState(body.data.provider) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** 运行时热切换执行通道（mock → playwright / api） */
  app.post('/api/providers/route', async (request, reply) => {
    const body = z
      .object({ provider: z.string(), route: z.enum(['mock', 'playwright', 'api']) })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '参数不合法：需要 { provider, route }' });
    if (!isProvider(body.data.provider)) return reply.code(400).send({ error: `未知 provider：${body.data.provider}` });

    registry.setRoute(body.data.provider, body.data.route);
    return { ok: true, providers: await registry.healthMap() };
  });

  // ------------------------------------------------------------------ 会话

  app.get('/api/sessions', async (request) => {
    const query = z.object({ q: z.string().optional() }).safeParse(request.query);
    return store.listSessions(query.success ? query.data.q : undefined);
  });

  app.post('/api/sessions', async (request) => {
    const body = z.object({ title: z.string().optional() }).safeParse(request.body ?? {});
    const session = store.createSession(body.success ? body.data.title : undefined);
    bus.emit({ sessionId: session.id, event: { type: 'session.updated', session } });
    return session;
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    return session;
  });

  app.patch('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ title: z.string().optional(), pinned: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数不合法' });
    const session = store.updateSession(id, body.data);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    bus.emit({ sessionId: session.id, event: { type: 'session.updated', session } });
    return session;
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    orchestrator.stopSession(id);
    const ok = store.deleteSession(id);
    return ok ? { ok: true } : reply.code(404).send({ error: '会话不存在' });
  });

  app.get('/api/sessions/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    return { session, messages: store.listMessages(id), replies: store.listReplies(id) };
  });

  // -------------------------------------------------------------- 发送/停止/重试

  app.post('/api/send', async (request, reply) => {
    const parsed = SendBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: `请求体不合法：${parsed.error.issues.map((i) => i.path.join('.')).join(',')}` });
    }
    const providers = normalizeProviders(parsed.data.providers);
    try {
      return await orchestrator.send({
        sessionId: parsed.data.sessionId,
        text: parsed.data.text,
        images: parsed.data.images,
        providers,
      });
    } catch (err) {
      log.warn(`/api/send 失败：${(err as Error).message}`);
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/stop', async (request, reply) => {
    const body = z.object({ replyId: z.string().optional(), sessionId: z.string().optional(), provider: z.string().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数不合法' });

    if (body.data.replyId) {
      return { ok: true, stopped: orchestrator.stop(body.data.replyId) ? 1 : 0 };
    }
    if (body.data.sessionId) {
      const provider = body.data.provider && isProvider(body.data.provider) ? body.data.provider : undefined;
      return { ok: true, stopped: orchestrator.stopSession(body.data.sessionId, provider) };
    }
    return reply.code(400).send({ error: '需要提供 replyId 或 sessionId' });
  });

  app.post('/api/retry', async (request, reply) => {
    const body = z.object({ replyId: z.string() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数不合法：需要 { replyId }' });
    try {
      // 注意：这里不能把局部变量命名为 reply，会和 fastify 的 reply 参数撞名
      const updatedReply = await orchestrator.retry(body.data.replyId);
      if (!updatedReply) return reply.code(404).send({ error: '回复不存在' });
      return { reply: updatedReply };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 三窗页「清空本窗」：删除该 provider 在当前会话的全部回复 */
  app.post('/api/replies/clear', async (request, reply) => {
    const body = z.object({ sessionId: z.string(), provider: z.string() }).safeParse(request.body ?? {});
    if (!body.success || !isProvider(body.data.provider)) return reply.code(400).send({ error: '参数不合法：需要 { sessionId, provider }' });
    const removed = orchestrator.clearProvider(body.data.sessionId, body.data.provider);
    return { ok: true, removed };
  });

  /** 三窗页「新会话」：让该 provider 在本会话里开一个全新对话 */
  app.post('/api/providers/new-session', async (request, reply) => {
    const body = z.object({ sessionId: z.string(), provider: z.string() }).safeParse(request.body ?? {});
    if (!body.success || !isProvider(body.data.provider)) return reply.code(400).send({ error: '参数不合法：需要 { sessionId, provider }' });
    try {
      const sessionKey = await orchestrator.newProviderSession(body.data.sessionId, body.data.provider);
      // 清空动作改变了会话内容，推一条 session.updated 让其它端刷新
      const session = store.touchSession(body.data.sessionId);
      if (session) bus.emit({ sessionId: session.id, event: { type: 'session.updated', session } });
      return { ok: true, provider: body.data.provider, sessionKey };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 点赞 / 采纳为最佳答案（页面 2 使用，数据落在 replies.vote 列） */
  app.post('/api/replies/:id/vote', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = VoteBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数不合法：vote 只能是 up / best / null' });
    const updated = store.updateReply(id, { vote: body.data.vote });
    if (!updated) return reply.code(404).send({ error: '回复不存在' });
    bus.emit({ sessionId: updated.sessionId, event: { type: 'reply.vote', replyId: id, sessionId: updated.sessionId, vote: updated.vote } });
    return updated;
  });

  // ------------------------------------------------------------------ 上传

  /** multipart 直传（不依赖前端压缩时使用）；前端默认走 /api/send 内联 data URL */
  app.post('/api/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: '缺少文件字段 file' });
    try {
      const buffer = await file.toBuffer();
      const stored = await imageStore.saveBuffer(buffer, file.mimetype, file.filename);
      return stored;
    } catch (err) {
      return reply.code(400).send({ error: `上传失败：${(err as Error).message}` });
    }
  });

  // ------------------------------------------------------------------ 导出

  app.get('/api/export/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = z.object({ format: z.enum(['md', 'json']).default('md') }).safeParse(request.query);
    const format = query.success ? query.data.format : 'md';

    const session = store.getSession(sessionId);
    if (!session) return reply.code(404).send({ error: '会话不存在' });

    const messages = store.listMessages(sessionId);
    const replies = store.listReplies(sessionId);
    const safeName = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session';
    const asciiName = `session-${sessionId.slice(-6)}.${format}`;
    reply.header(
      'content-disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.${format}`)}`,
    );

    if (format === 'json') {
      reply.header('content-type', 'application/json; charset=utf-8');
      return { session, messages, replies, exportedAt: new Date().toISOString() };
    }

    reply.header('content-type', 'text/markdown; charset=utf-8');
    return renderMarkdown(session.title, messages, replies);
  });
}

// -------------------------------------------------------------------- 导出实现

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 会话 → Markdown：用户消息 + 其下三家回复各自成节 */
function renderMarkdown(
  title: string,
  messages: Awaited<ReturnType<SessionStore['listMessages']>>,
  replies: Awaited<ReturnType<SessionStore['listReplies']>>,
): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `> 导出时间：${formatTime(Date.now())}`,
    `> 消息数：${messages.length} ｜ 回复数：${replies.length}`,
    '',
  ];

  const byUserMessage = new Map<string, typeof replies>();
  for (const reply of replies) {
    const list = byUserMessage.get(reply.userMessageId) ?? [];
    list.push(reply);
    byUserMessage.set(reply.userMessageId, list);
  }

  for (const message of messages) {
    if (message.role !== 'user') continue;
    lines.push(`## 🙋 用户 · ${formatTime(message.createdAt)}`, '');
    lines.push(message.content || '（图片消息）', '');
    for (const image of message.images ?? []) {
      lines.push(`![图片](${image})`, '');
    }
    for (const reply of byUserMessage.get(message.id) ?? []) {
      const meta = [
        `耗时 ${reply.latencyMs ?? '-'}ms`,
        `首字 ${reply.firstTokenMs ?? '-'}ms`,
        `约 ${reply.tokenEstimate ?? '-'} token`,
        `通道 ${reply.route}`,
      ].join(' ｜ ');
      const badge = reply.status === 'error' ? '❌ 失败' : reply.stopped ? '⏹ 已停止' : '✅ 完成';
      lines.push(`### ${providerLabel(reply.provider)} · ${badge}`, '', `> ${meta}`, '');
      lines.push(reply.content || (reply.error ? `> 错误：${reply.error}` : '（无内容）'), '');
    }
    lines.push('---', '');
  }

  return lines.join('\n');
}
/**
 * 服务入口：装配依赖 → 注册插件/路由 → 监听 → 优雅退出。
 * 所有可变依赖都在这里注入，方便后续替换（比如换掉 SQLite 实现、加 Redis 广播）。
 */
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import { AdapterRegistry } from './adapters/registry.js';
import { config } from './config.js';
import { EventBus } from './core/event-bus.js';
import { ImageStore } from './core/image-store.js';
import { Orchestrator } from './core/orchestrator.js';
import { SessionStore } from './core/session-store.js';
import { registerRoutes } from './http/routes.js';
import { createLogger } from './utils/logger.js';
import { WsHub } from './ws/hub.js';

const startedAt = Date.now();

async function main(): Promise<void> {
  const log = createLogger('boot');

  // ---------- 依赖装配 ----------
  const store = new SessionStore();
  const stale = store.markStaleReplies();
  if (stale > 0) log.warn(`启动清理：${stale} 条上次被中断的回复已标记为失败（可重试）`);

  const bus = new EventBus();
  const imageStore = new ImageStore(config.uploadDir);
  const registry = new AdapterRegistry(config.routes, config.mockSpeed, createLogger('adapter'));
  await registry.initAll();

  const orchestrator = new Orchestrator({
    store,
    registry,
    bus,
    imageStore,
    log: createLogger('orchestrator'),
  });

  const app = Fastify({
    logger: false,
    // 前端会把压缩后的图片以 base64 塞进请求体，默认 1MB 不够用
    bodyLimit: Math.max(8 * 1024 * 1024, config.maxUploadBytes * 3),
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 12, fields: 20 },
  });
  await app.register(fastifyStatic, { root: config.uploadDir, prefix: '/uploads/' });
  await app.register(fastifyWebsocket);

  const hub = new WsHub(bus, createLogger('ws'), {
    type: 'hello',
    providers: await registry.healthMap(),
  });
  hub.startHeartbeat();

  app.get('/ws', { websocket: true }, (socket) => {
    hub.register(socket);
  });

  await registerRoutes(app, {
    store,
    orchestrator,
    registry,
    imageStore,
    bus,
    log: createLogger('http'),
    startedAt,
  });

  // 若前端已构建（packages/web/dist 存在），顺手挂到根路径：
  // 这样 `npm run build && npm start` 就是单端口可跑的完整应用。
  const webDist = path.resolve(config.projectRoot, 'packages', 'web', 'dist');
  const webIndex = path.join(webDist, 'index.html');
  if (fs.existsSync(webIndex)) {
    const indexHtml = fs.readFileSync(webIndex, 'utf8');
    await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      if (url.startsWith('/api') || url.startsWith('/uploads') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: `接口不存在：${url}` });
      }
      // SPA 回退：非静态资源的路径一律返回 index.html
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
    log.info(`已挂载前端构建产物 ${webDist}`);
  }

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    log.error(`未捕获的请求错误：${error.message}`);
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(status).send({ error: error.message });
  });

  await app.listen({ host: config.host, port: config.port });

  const health = await registry.healthMap();
  const routeSummary = Object.entries(health)
    .map(([provider, h]) => `${provider}=${h.route}${h.ok ? '' : '(不可用)'}`)
    .join('  ');
  log.info(`已启动  http://${config.host}:${config.port}`);
  log.info(`数据目录 ${config.storageDir}`);
  log.info(`执行通道 ${routeSummary}`);
  log.info(`WebSocket ws://${config.host}:${config.port}/ws`);

  // ---------- 优雅退出 ----------
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在关闭…`);
    orchestrator.abortAll();
    hub.closeAll();
    await registry.disposeAll();
    await app.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝', reason));
  process.on('uncaughtException', (err) => log.error('未捕获异常', err));
}

main().catch((err) => {
  console.error('[boot] 启动失败：', err);
  process.exit(1);
});
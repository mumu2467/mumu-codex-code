#!/usr/bin/env node
/**
 * 端到端冒烟测试（自带服务端生命周期）：
 *   1. 在临时目录里拉起一个 server 实例（独立端口 + 独立 storage）
 *   2. 建立 WebSocket 连接
 *   3. POST /api/send 同时发给三家，校验三路都收到 delta 并以 done 收尾
 *   4. 用 "#fail" 触发错误注入，校验 error 事件 + retry 能恢复
 *   5. 校验图片（base64 data URL）能落盘成可访问的 /uploads 资源
 *   6. 清理并退出（失败则非 0 退出码）
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-smoke-'));

// 1x1 的透明 PNG，用来验证图片落盘链路
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`服务端在 ${timeoutMs}ms 内没有就绪`);
}

/** 收集 WS 事件，直到满足 predicate 或超时 */
function collect(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      client.removeEventListener('message', onMessage);
      reject(new Error(`${label} 超时（${timeoutMs}ms），已收到：${events.map((e) => e.type).join(', ') || '无'}`));
    }, timeoutMs);
    function onMessage(raw) {
      const evt = JSON.parse(typeof raw.data === 'string' ? raw.data : raw.data.toString());
      events.push(evt);
      if (predicate(events, evt)) {
        clearTimeout(timer);
        client.removeEventListener('message', onMessage);
        resolve(events);
      }
    }
    client.addEventListener('message', onMessage);
  });
}

const server = spawn(
  process.execPath,
  ['--import', 'tsx', path.join('packages', 'server', 'src', 'index.ts')],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STORAGE_DIR: storageDir,
      LOG_LEVEL: 'warn',
      ADAPTER_DEEPSEEK: 'mock',
      ADAPTER_DOUBAO: 'mock',
      ADAPTER_KIMI: 'mock',
      MOCK_SPEED: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c.toString()));
server.stderr.on('data', (c) => (serverLog += c.toString()));

let ws;
let exitCode = 0;

try {
  const health = await waitForHealth();
  console.log('\n[1] 服务端就绪');
  check('GET /api/health 返回 ok', health.ok === true);
  check('三家 provider 均为 mock 通道', Object.values(health.providers).every((p) => p.route === 'mock'));

  ws = new WebSocket(WS_URL);
  await once(ws, 'open');
  console.log('\n[2] WebSocket 已连接');

  // 建会话
  const sessionRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '冒烟测试会话' }),
  });
  const session = await sessionRes.json();
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));

  // ---------- 场景 A：三路并发正常流式 ----------
  console.log('\n[3] 场景 A：一条消息（文字 + 图片）同时发三家');
  const donePromise = collect(
    ws,
    (events) => events.filter((e) => e.type === 'reply.done').length >= 3,
    30000,
    '三路 reply.done',
  );

  const sendRes = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      text: '用一句话解释什么是「多 AI 聚合」。',
      images: [TINY_PNG],
      providers: ['deepseek', 'doubao', 'kimi'],
    }),
  });
  const sent = await sendRes.json();
  check('POST /api/send 返回 messageId', typeof sent.messageId === 'string' && sent.messageId.length > 0);
  check('返回 3 条 pending reply', Array.isArray(sent.replies) && sent.replies.length === 3);

  const eventsA = await donePromise;
  const doneA = eventsA.filter((e) => e.type === 'reply.done');
  const deltaA = eventsA.filter((e) => e.type === 'reply.delta');
  const providersSeen = new Set(doneA.map((e) => e.provider));
  check('三家都收到 reply.done', providersSeen.size === 3, [...providersSeen].join('/'));
  check('收到流式增量 delta', deltaA.length > 10, `${deltaA.length} 个 delta`);
  check('每条 done 都带 latencyMs', doneA.every((e) => typeof e.latencyMs === 'number' && e.latencyMs > 0));
  check('每条 done 都带 firstTokenMs', doneA.every((e) => typeof e.firstTokenMs === 'number' && e.firstTokenMs > 0));
  check('每条 done 正文非空', doneA.every((e) => typeof e.content === 'string' && e.content.length > 20));
  check(
    '首字延迟 < 总耗时',
    doneA.every((e) => e.firstTokenMs <= e.latencyMs),
  );
  check(
    'delta 的 full 是单调增长的全量快照',
    deltaA.every((e) => typeof e.full === 'string') &&
      deltaA.filter((e) => e.provider === 'deepseek').every((e, i, arr) => i === 0 || e.full.length >= arr[i - 1].full.length),
  );

  // ---------- 场景 B：图片落盘 ----------
  console.log('\n[4] 场景 B：图片落盘与静态访问');
  const messagesRes = await fetch(`${BASE}/api/sessions/${session.id}/messages`);
  const bundle = await messagesRes.json();
  const userMsg = bundle.messages.find((m) => m.role === 'user');
  check('用户消息落库', Boolean(userMsg));
  check('用户消息带 1 张图片 URL', Array.isArray(userMsg?.images) && userMsg.images.length === 1, userMsg?.images?.[0]);
  if (userMsg?.images?.[0]) {
    const imgRes = await fetch(`${BASE}${userMsg.images[0]}`);
    check('图片可通过 /uploads 静态访问', imgRes.ok, `HTTP ${imgRes.status}`);
    check('图片 content-type 为 image/png', imgRes.headers.get('content-type')?.includes('image/png') === true);
  }
  check('回复已落库为 done', bundle.replies.filter((r) => r.status === 'done').length === 3);

  // ---------- 场景 C：错误注入 + 重试 ----------
  console.log('\n[5] 场景 C：错误注入（#fail）与一键重试');
  const failDonePromise = collect(ws, (events) => events.some((e) => e.type === 'reply.error'), 20000, 'reply.error');
  await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      text: '这条消息会触发失败 #fail',
      images: [],
      providers: ['doubao'],
    }),
  });
  const eventsC = await failDonePromise;
  const errEvt = eventsC.find((e) => e.type === 'reply.error');
  check('收到 reply.error', Boolean(errEvt));
  check('错误事件带 kind', typeof errEvt?.kind === 'string' && errEvt.kind.length > 0, errEvt?.kind);
  check('错误事件可重试 retryable=true', errEvt?.retryable === true);

  const retryDonePromise = collect(ws, (events) => events.some((e) => e.type === 'reply.done'), 20000, '重试后的 reply.done');
  const retryRes = await fetch(`${BASE}/api/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replyId: errEvt.replyId }),
  });
  check('POST /api/retry 返回 200', retryRes.ok);
  const retryEvents = await retryDonePromise;
  check('重试后成功收到 reply.done', retryEvents.some((e) => e.type === 'reply.done'));

  // ---------- 场景 D：停止生成 ----------
  console.log('\n[6] 场景 D：停止生成会保留已输出的半截内容');
  const stopSend = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, text: '写一篇 800 字的长文，我会中途叫停你。', images: [], providers: ['kimi'] }),
  });
  const stopTarget = (await stopSend.json()).replies[0];
  const stoppedPromise = collect(
    ws,
    (events) => events.some((e) => e.type === 'reply.done' && e.replyId === stopTarget.id),
    20000,
    '停止后的 reply.done',
  );
  await sleep(700);
  await fetch(`${BASE}/api/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replyId: stopTarget.id }),
  });
  const stoppedEvents = await stoppedPromise;
  const stopped = stoppedEvents.find((e) => e.type === 'reply.done' && e.replyId === stopTarget.id);
  check('停止后仍收到 done（半截内容）', Boolean(stopped));
  check('停止标记 stopped=true', stopped?.stopped === true);
  check('停止时保留部分内容', (stopped?.content?.length ?? 0) > 0, `${stopped?.content?.length ?? 0} 字`);

  // ---------- 场景 E：导出 ----------
  console.log('\n[7] 场景 E：会话导出');
  const mdRes = await fetch(`${BASE}/api/export/${session.id}?format=md`);
  const md = await mdRes.text();
  check('导出 Markdown 成功', mdRes.ok && md.includes('# 冒烟测试会话'));
  const jsonRes = await fetch(`${BASE}/api/export/${session.id}?format=json`);
  const json = await jsonRes.json();
  check('导出 JSON 成功', jsonRes.ok && Array.isArray(json.messages) && Array.isArray(json.replies));
} catch (err) {
  console.error(`\n✘ 冒烟测试失败：${err?.message ?? err}`);
  exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  server.kill();
  await sleep(400);
  fs.rmSync(storageDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${'─'.repeat(58)}`);
console.log(`冒烟测试：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log(`失败项：\n${failed.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('\n')}`);
  console.log(`\n--- 服务端日志尾部 ---\n${serverLog.split(/\r?\n/).slice(-40).join('\n')}`);
  exitCode = 1;
}
console.log(`${'─'.repeat(58)}`);
process.exit(exitCode);
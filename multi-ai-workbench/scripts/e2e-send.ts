#!/usr/bin/env node
/**
 * 端到端联调脚本：给三家（或指定家）真发一条消息，实时打印 WebSocket 事件流。
 *
 *   npm run e2e -- "用一句话介绍你自己"
 *   npm run e2e -- --providers deepseek,kimi "只发这两家"
 *   npm run e2e -- --timeout 300 "写一篇 800 字的文章"
 *   MAW_SERVER_PORT=8877 npm run e2e -- "端口不对时这样指"
 *
 * 它同时验证了「HTTP 投递 → 编排 → Playwright 通道 → WebSocket 流式回传」整条链路，
 * 所以接完真实通道后第一件事就是跑它，不用开前端也能确认到底通没通。
 *
 * 前置：后端已经在跑（npm run dev 或 npm run start --workspace @maw/server）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS, isProvider, providerLabel, type Provider } from '@maw/shared';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return undefined;
  const raw = args[index]!;
  if (raw.includes('=')) return raw.slice(raw.indexOf('=') + 1) || undefined;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : undefined;
};

const port = flag('port') ?? process.env.MAW_SERVER_PORT ?? process.env.PORT ?? '8787';
const host = flag('host') ?? process.env.HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;
const wsUrl = `ws://${host}:${port}/ws`;
const timeoutMs = Number(flag('timeout') ?? 180) * 1000;

const providerArg = flag('providers');
const providers: Provider[] = providerArg
  ? (providerArg.split(',').map((s) => s.trim()).filter(isProvider) as Provider[])
  : [...PROVIDERS];
if (providers.length === 0) {
  console.error(`--providers 里没有合法值，可选：${PROVIDERS.join(' / ')}`);
  process.exit(2);
}

/**
 * --image=<本地图片路径>（可重复）：走「文字 + 图片」混合发送那条路。
 * 前端是压成 base64 data URL 再发的，这里保持一致，顺便验证了上传链路。
 */
const imagePaths: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const raw = args[index]!;
  if (raw.startsWith('--image=')) imagePaths.push(raw.slice('--image='.length));
  else if (raw === '--image' && args[index + 1] && !args[index + 1]!.startsWith('--')) imagePaths.push(args[index + 1]!);
}
if (imagePaths.length === 0) {
  // 兼容旧的 --image=... 写法之外的场景：给出明确提示，别静默丢掉图片
  console.log('（未指定图片；要验证多模态请加 --image=<本地图片路径>）');
}
const images = imagePaths.map((file) => {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
});

// 位置参数里第一个不是 flag 值的东西当消息文本
const consumed = new Set<string>();
for (const name of ['port', 'host', 'timeout', 'providers', 'image']) {
  const raw = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!raw) continue;
  consumed.add(raw);
  if (!raw.includes('=')) {
    const index = args.indexOf(raw);
    if (args[index + 1]) consumed.add(args[index + 1]!);
  }
}
// 没给文字时不硬塞默认问候：只给图片就是"纯图片消息"（用来验证走的是发送按钮而不是回车）
const text = args.find((arg) => !arg.startsWith('--') && !consumed.has(arg)) ?? (images.length > 0 ? '' : '你好，请只回复两个字：收到');
if (!text.trim() && images.length === 0) {
  console.error('文字与图片至少要有一样');
  process.exit(2);
}

const startedAt = Date.now();
const stamp = () => `+${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`;

/** 每条回复的进度状态 */
interface Track {
  provider: Provider;
  chars: number;
  firstTokenMs?: number;
  status: string;
}
const tracks = new Map<string, Track>();
let pending = 0;
let failed = 0;
let sessionId = '';

console.log(`目标服务 ${base}`);
console.log(`消息文本 「${text}」${images.length > 0 ? `（附 ${images.length} 张图：${imagePaths.join(', ')}）` : ''}`);
console.log(`参与通道 ${providers.map(providerLabel).join(' / ')}\n`);

// 1) 先看健康检查：通道是不是 playwright / api，有没有明显错误
try {
  const health = (await (await fetch(`${base}/api/health`)).json()) as {
    providers: Record<Provider, { route: string; ok: boolean; reason?: string }>;
  };
  for (const provider of PROVIDERS) {
    const item = health.providers[provider];
    console.log(`  ${providerLabel(provider).padEnd(9)} ${item.route.padEnd(11)} ${item.ok ? '✔' : '✘'} ${item.reason ?? ''}`);
  }
  console.log('');
} catch (err) {
  console.error(`连不上后端 ${base}，请先启动服务（npm run dev）。${(err as Error).message}`);
  process.exit(2);
}

// 2) 订阅 WebSocket
const socket = new WebSocket(wsUrl);
const finished = new Promise<void>((resolve) => {
  const timer = setTimeout(() => {
    console.error(`\n⏱  等待超时（${timeoutMs / 1000}s）`);
    resolve();
  }, timeoutMs);

  socket.addEventListener('open', async () => {
    try {
      // 先建一个会话：服务端只把事件推给「订阅了该会话」的连接，
      // 所以必须拿到 sessionId → subscribe → 再发消息，否则一个事件都收不到。
      const created = (await (
        await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `e2e ${new Date().toLocaleTimeString('zh-CN')}` }),
        })
      ).json()) as { id: string };
      sessionId = created.id;
      socket.send(JSON.stringify({ type: 'subscribe', sessionId }));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const response = await fetch(`${base}/api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, text, images, providers }),
      });
      if (!response.ok) {
        console.error(`投递失败 HTTP ${response.status}：${await response.text()}`);
        clearTimeout(timer);
        resolve();
        return;
      }
      const payload = (await response.json()) as { replies: { id: string; provider: Provider }[] };
      pending = payload.replies.length;
      for (const reply of payload.replies) {
        tracks.set(reply.id, { provider: reply.provider, chars: 0, status: 'pending' });
      }
      console.log(`→ 会话 ${sessionId}，已投递 ${pending} 条，等待流式回复…\n`);
    } catch (err) {
      console.error(`投递异常：${(err as Error).message}`);
      clearTimeout(timer);
      resolve();
    }
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const replyId = typeof message.replyId === 'string' ? message.replyId : undefined;
    switch (message.type) {
      case 'reply.status': {
        const track = replyId ? tracks.get(replyId) : undefined;
        if (track) track.status = String(message.status);
        break;
      }
      case 'reply.delta': {
        const track = replyId ? tracks.get(replyId) : undefined;
        if (!track) break;
        const full = String(message.full ?? '');
        // 每涨 40 字打一个点，避免刷屏
        if (Math.floor(full.length / 40) > Math.floor(track.chars / 40)) {
          console.log(`  ${stamp()} ${providerLabel(track.provider).padEnd(9)} 流式 ${full.length} 字`);
        }
        track.chars = full.length;
        break;
      }
      case 'reply.done': {
        const track = replyId ? tracks.get(replyId) : undefined;
        if (!track) break;
        track.status = 'done';
        track.chars = String(message.content ?? '').length;
        pending -= 1;
        console.log(
          `  ${stamp()} ${providerLabel(track.provider).padEnd(9)} ✅ 完成  ${track.chars} 字 / ` +
            `首字 ${message.firstTokenMs ?? '-'}ms / 总耗时 ${message.latencyMs}ms / ~${message.tokenEstimate} token`,
        );
        const content = String(message.content ?? '').replace(/\s+/g, ' ').trim();
        console.log(`            └ ${content.slice(0, 160)}${content.length > 160 ? '…' : ''}`);
        if (pending <= 0) {
          clearTimeout(timer);
          resolve();
        }
        break;
      }
      case 'reply.error': {
        const track = replyId ? tracks.get(replyId) : undefined;
        if (!track) break;
        track.status = 'error';
        pending -= 1;
        failed += 1;
        console.error(
          `  ${stamp()} ${providerLabel(track.provider).padEnd(9)} ❌ 失败（${message.kind}，retryable=${message.retryable}）：${message.error}`,
        );
        if (pending <= 0) {
          clearTimeout(timer);
          resolve();
        }
        break;
      }
      case 'auth.required':
        console.error(`  ${stamp()} ${providerLabel(String(message.provider) as Provider)} ⚠️ 需要人工介入：${message.hint}`);
        break;
      default:
        break;
    }
  });

  socket.addEventListener('error', () => {
    console.error('WebSocket 连接出错');
    clearTimeout(timer);
    resolve();
  });
});

await finished;
socket.close();
const done = [...tracks.values()].filter((track) => track.status === 'done').length;
const errored = [...tracks.values()].filter((track) => track.status === 'error').length;
console.log(`\n结果：${done} 成功 / ${errored} 失败 / ${providers.length} 应收（会话 ${sessionId}）`);
process.exit(done === providers.length ? 0 : 1);
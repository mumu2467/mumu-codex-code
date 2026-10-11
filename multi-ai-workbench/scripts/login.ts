#!/usr/bin/env node
/**
 * 命令行登录器：打开三家（或指定某几家）**真实浏览器窗口**，你扫码登录，然后自动保存登录态。
 *
 *   npm run login                  # 三家一起打开，逐个扫码
 *   npm run login -- deepseek      # 只登录 DeepSeek
 *   npm run login -- doubao kimi   # 指定两家
 *   npm run login -- --keep-open   # 登录完成后不关窗口
 *
 * 登录态写到 <storage>/.browser-profile/<provider>/（Chromium 持久化 profile），
 * 并额外导出 <storage>/browser/<provider>.json（storageState，便携备份）。
 *
 * ⚠️ 同一个 profile 同一时刻只能被一个进程占用：
 *    如果后端服务已经在运行并且开过窗口，请在应用界面里点「登录」，而不是跑这个脚本。
 */
import { PROVIDER_SITES, BrowserPool } from '../packages/server/src/browser/browser-pool.js';
import { LoginService, type LoginState } from '../packages/server/src/browser/login-service.js';
import { config } from '../packages/server/src/config.js';
import { createLogger } from '../packages/server/src/utils/logger.js';
import { PROVIDERS, isProvider, providerLabel } from '@maw/shared';

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const requested = args.filter((arg) => !arg.startsWith('--'));

const unknown = requested.filter((arg) => !isProvider(arg));
if (unknown.length > 0) {
  console.error(`不认识的项目：${unknown.join('、')}（可选：${PROVIDERS.join(' / ')}）`);
  process.exit(1);
}
const providers = requested.filter(isProvider);
if (providers.length === 0) providers.push(...PROVIDERS);

console.log('──────────────────────────────────────────────────────────');
console.log(`  即将登录：${providers.map(providerLabel).join('、')}`);
console.log('  浏览器窗口会依次弹出，请在每个窗口里完成登录（App 扫码 / 手机号 + 验证码）。');
console.log(`  等待上限 ${Math.round(config.loginTimeoutMs / 1000)}s，期间请不要关闭窗口。`);
console.log('──────────────────────────────────────────────────────────');

if (config.browser.headless) {
  console.warn('⚠️  当前 BROWSER_HEADLESS=true，浏览器不会显示窗口，扫码登录没法完成。');
  console.warn('   请把 .env 里的 BROWSER_HEADLESS 改成 false 后重试。\n');
}

const log = createLogger('login');
const pool = new BrowserPool(log);
const service = new LoginService({ pool, log });

/** 终态：出现任意一个就说明这一家不用再等了 */
const FINISHED = new Set<string>(['done', 'timeout', 'error', 'cancelled']);
const picked = (): LoginState[] => service.status().filter((state) => providers.includes(state.provider));

function describe(state: LoginState): string {
  const icon =
    state.phase === 'done' ? '✅' : state.phase === 'error' ? '❌' : state.phase === 'timeout' ? '⏰' : '⏳';
  return `  ${icon} ${state.label.padEnd(9)} ${state.message}`;
}

const startedAt = Date.now();
await service.start(providers);

// 每 800ms 打一次"阶段发生变化"的行，避免刷屏
const lastPhase = new Map<string, string>();
const lastUrl = new Map<string, string>();
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    for (const state of picked()) {
      const changed = lastPhase.get(state.provider) !== state.phase;
      const movedUrl = !!state.url && lastUrl.get(state.provider) !== state.url;
      if (changed || movedUrl) {
        lastPhase.set(state.provider, state.phase);
        if (state.url) lastUrl.set(state.provider, state.url);
        console.log(describe(state));
      }
    }
    const done = picked().every((state) => FINISHED.has(state.phase));
    const overtime = Date.now() - startedAt > config.loginTimeoutMs + 60_000;
    if (done || overtime) {
      clearInterval(timer);
      resolve();
    }
  }, 800);
});

console.log('\n──────────────────────────────────────────────────────────');
for (const state of picked()) console.log(describe(state));
const ok = picked().filter((state) => state.phase === 'done');
const bad = picked().filter((state) => state.phase !== 'done');

console.log('──────────────────────────────────────────────────────────');
console.log(`  登录成功 ${ok.length} 家，未完成 ${bad.length} 家。`);
console.log(`  持久化 profile：${config.browser.profileRoot}`);
console.log(`  storageState   ：${config.browser.stateDir}`);
if (bad.length > 0) {
  console.log('\n  未完成的原因与对策：');
  console.log('   · 需要验证码 / 滑块 → 在窗口里手动过；过完再跑一次本命令即可重新检测');
  console.log('   · 页面长时间没反应    → 在窗口里手动刷新一次');
  console.log('   · 扫码后一直不判定成功 → 选择器可能失效，跑 npm run probe -- <项目名> 校准');
}
console.log('');

for (const provider of providers) {
  log.debug(`${provider} 入口：${PROVIDER_SITES[provider]}`);
}

if (!keepOpen) {
  console.log('  正在关闭浏览器窗口…（加 --keep-open 可保留窗口）');
  await pool.closeAll();
} else {
  console.log('  窗口保持打开。按 Ctrl+C 结束本进程（窗口会一起关闭）。');
}
process.exit(bad.length > 0 ? 2 : 0);
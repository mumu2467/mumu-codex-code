#!/usr/bin/env node
/**
 * 选择器探针：把 `packages/server/src/adapters/selectors/*.json` 里的每个候选选择器
 * 在**真实页面**上的命中情况打出来，并可选地 dump 一份页面结构快照。
 *
 *   npm run probe                    # 三家都探（登录页即可，不需要登录态）
 *   npm run probe -- deepseek        # 只探一家
 *   npm run probe -- deepseek --deep # 额外输出结构快照，用于校准 assistantMessage 等
 *   npm run probe -- --close         # 探完自动关窗口（默认保留，便于你顺手登录）
 *
 * 快照会写到 <storage>/probe/<provider>.json，直接照着它改选择器 JSON 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserPool, PROVIDER_SITES } from '../packages/server/src/browser/browser-pool.js';
import { candidates, loadSelectors, selectorsFile } from '../packages/server/src/adapters/selectors/index.js';
import { config } from '../packages/server/src/config.js';
import { createLogger } from '../packages/server/src/utils/logger.js';
import { PROVIDERS, isProvider, providerLabel } from '@maw/shared';

const args = process.argv.slice(2);
const deep = args.includes('--deep');
const autoClose = args.includes('--close');
const requested = args.filter((arg) => !arg.startsWith('--')).filter(isProvider);
const providers = requested.length > 0 ? requested : [...PROVIDERS];

const log = createLogger('probe');
const pool = new BrowserPool(log);
const probeDir = path.join(config.storageDir, 'probe');
fs.mkdirSync(probeDir, { recursive: true });

/**
 * 页面结构采集脚本。
 *
 * 注意：这里刻意写成 **字符串** 而不是函数。tsx / esbuild 会给传给 evaluate 的
 * 函数注入 `__name` 之类的 helper，而那个 helper 在浏览器上下文里并不存在，
 * 结果就是 `ReferenceError: __name is not defined`。传字符串最稳。
 */
const COLLECT_SCRIPT = `
(function () {
  var brief = function (el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
      aria: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      role: el.getAttribute('role') || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      text: (el.textContent || '').trim().slice(0, 80) || undefined
    };
  };
  var pick = function (sel, limit) {
    var all = document.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < all.length && i < (limit || 8); i++) out.push(brief(all[i]));
    return out;
  };
  return {
    title: document.title,
    url: location.href,
    textareas: pick('textarea'),
    contentEditables: pick('[contenteditable="true"]'),
    textboxes: pick('[role="textbox"]'),
    inputs: pick('input', 12),
    fileInputs: pick('input[type="file"]'),
    markdownish: pick('[class*="markdown"]', 5),
    bubbleish: pick('[class*="message"], [class*="bubble"], [class*="chat-item"], [class*="segment"]', 10),
    buttons: pick('button, [role="button"]', 20)
  };
})()
`;

for (const provider of providers) {
  console.log(`\n══════════ ${providerLabel(provider)} ══════════`);
  const selectors = loadSelectors(provider, { reload: true });
  console.log(`选择器文件：${selectorsFile(provider)}`);
  try {
    const page = await pool.openWindow(provider);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    // SPA 首屏之后还会渲染一阵子，等一会儿再采样，否则拿到的是空壳
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    console.log(`  入口    ${PROVIDER_SITES[provider]}`);
    console.log(`  当前    ${page.url()}`);
    console.log(`  标题    ${(await page.title().catch(() => '')) || '(空)'}`);

    console.log('\n  字段              命中  候选');
    for (const [field, value] of Object.entries(selectors)) {
      if (typeof value !== 'string' || field === 'notes') continue;
      for (const [index, one] of candidates(value).entries()) {
        const count = await page.locator(one).count().catch(() => -1);
        const mark = count > 0 ? '✔' : count < 0 ? '?' : '✘';
        console.log(
          `  ${(index === 0 ? field : '').padEnd(17)} ${mark} ${String(count).padStart(3)}  ${one}`,
        );
      }
    }

    if (deep) {
      const snapshot = await page.evaluate(COLLECT_SCRIPT).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      const file = path.join(probeDir, `${provider}.json`);
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
      console.log(`\n  结构快照已保存：${file}`);
    }
  } catch (err) {
    console.log(`  ❌ 探测失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('\n提示：改完 selectors/*.json 后重新跑本命令即可验证，不需要重启服务（探针每次强制重读 JSON）。');
if (autoClose) {
  await pool.closeAll();
  process.exit(0);
}
console.log('浏览器窗口保持打开（加 --close 可自动关闭，Ctrl+C 退出）。');
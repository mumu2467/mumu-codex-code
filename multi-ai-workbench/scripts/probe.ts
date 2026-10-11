#!/usr/bin/env node
/**
 * 选择器探针：把 `packages/server/src/adapters/selectors/*.json` 里的每个候选选择器
 * 在**真实页面**上的命中情况打出来，并可选地 dump 页面结构快照。
 *
 *   npm run probe                          # 三家都探（登录页即可，不需要登录态）
 *   npm run probe -- deepseek              # 只探一家
 *   npm run probe -- deepseek --deep       # 额外输出结构快照，用于校准 assistantMessage 等
 *   npm run probe -- deepseek --send       # 真发一条探测消息，持续跟踪到回复稳定，再 dump 消息区
 *   npm run probe -- deepseek --send "自定义文本"
 *   npm run probe -- doubao --url "https://www.doubao.com/chat/xxx"   # 打开已有会话复盘（不新发消息）
 *   npm run probe -- kimi --deep --wait=20 # 采集前多等 20 秒（懒加载的会话页很有用）
 *   npm run probe -- doubao --image=D:\\pic.png  # 试一次图片上传并 dump 输入区（校准 fileInput）
 *   npm run probe -- --close               # 探完自动关窗口（默认保留，便于你顺手人工登录）
 *
 * 快照写到 <storage>/probe/：
 *   <provider>.json              —— --deep 的页面结构快照
 *   <provider>-after-send.json   —— --send 的消息区最终快照（含正文候选的 DOM 链与 HTML 片段）
 *
 * ⚠️ `--send` 会真的往你的账号里发一条消息（默认内容是"请只回复两个字：收到"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { BrowserPool, PROVIDER_SITES } from '../packages/server/src/browser/browser-pool.js';
import { candidates, loadSelectors, selectorsFile } from '../packages/server/src/adapters/selectors/index.js';
import { config } from '../packages/server/src/config.js';
import { createLogger } from '../packages/server/src/utils/logger.js';
import { PROVIDERS, isProvider, providerLabel } from '@maw/shared';

const DEFAULT_SEND_TEXT = '你好，请只回复两个字：收到';

const args = process.argv.slice(2);
const deep = args.includes('--deep');
const autoClose = args.includes('--close');

// --send / --send=文本 / --send 文本
const sendIdx = args.findIndex((arg) => arg === '--send' || arg.startsWith('--send='));
let sendText: string | undefined;
if (sendIdx >= 0) {
  const raw = args[sendIdx]!;
  if (raw.includes('=')) {
    sendText = raw.slice(raw.indexOf('=') + 1) || DEFAULT_SEND_TEXT;
  } else {
    const next = args[sendIdx + 1];
    sendText = next && !next.startsWith('--') ? next : DEFAULT_SEND_TEXT;
  }
}

// --url / --url=<地址>：直接打开指定会话页（用来复盘已存在的对话，不必再发消息）
const urlIdx = args.findIndex((arg) => arg === '--url' || arg.startsWith('--url='));
let targetUrl: string | undefined;
if (urlIdx >= 0) {
  const raw = args[urlIdx]!;
  if (raw.includes('=')) targetUrl = raw.slice(raw.indexOf('=') + 1) || undefined;
  else {
    const next = args[urlIdx + 1];
    if (next && !next.startsWith('--')) targetUrl = next;
  }
}

// --image=<本地路径>：在页面里试一次图片上传，并 dump 输入区结构（校准 fileInput 用）
const imageArg = args.find((arg) => arg.startsWith('--image='));
const imagePath = imageArg ? imageArg.slice('--image='.length) : undefined;

// --dump / --dump=<CSS>：把匹配该选择器的**每一行**的 outerHTML 打出来（校准消息行结构用）
const dumpIdx = args.findIndex((arg) => arg === '--dump' || arg.startsWith('--dump='));
let dumpSelector: string | undefined;
if (dumpIdx >= 0) {
  const raw = args[dumpIdx]!;
  if (raw.includes('=')) dumpSelector = raw.slice(raw.indexOf('=') + 1) || undefined;
  else {
    const next = args[dumpIdx + 1];
    if (next && !next.startsWith('--')) dumpSelector = next;
  }
}

// --wait / --wait=<秒>：采集前额外等待（懒加载会话页必备）
const waitIdx = args.findIndex((arg) => arg === '--wait' || arg.startsWith('--wait='));
let extraWaitMs = 0;
if (waitIdx >= 0) {
  const raw = args[waitIdx]!;
  const num = Number(raw.includes('=') ? raw.split('=')[1] : args[waitIdx + 1]);
  if (Number.isFinite(num) && num > 0) extraWaitMs = num * 1000;
}

const requested = args.filter((arg) => !arg.startsWith('--')).filter(isProvider);
const providers = requested.length > 0 ? requested : [...PROVIDERS];

const log = createLogger('probe');
const pool = new BrowserPool(log);
const probeDir = path.join(config.storageDir, 'probe');
fs.mkdirSync(probeDir, { recursive: true });

/**
 * 页面结构采集脚本（--deep）。
 *
 * 注意：这里刻意写成 **字符串** 而不是函数。tsx / esbuild 会给传给 evaluate 的
 * 函数注入 `__name` 之类的 helper，而那个 helper 在浏览器上下文里并不存在，
 * 结果就是 `ReferenceError: __name is not defined`。传字符串最稳。
 */
const COLLECT_SCRIPT = `
(function () {
  var clean = function (t) { return (t || '').replace(/\\s+/g, ' ').trim(); };
  var chainOf = function (el) {
    var parts = [];
    var node = el;
    for (var i = 0; i < 6 && node && node.tagName && node.tagName.toLowerCase() !== 'body'; i++) {
      var cls = typeof node.className === 'string' ? node.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      parts.unshift(node.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  var brief = function (el, max) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
      aria: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      role: el.getAttribute('role') || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      chain: chainOf(el),
      text: clean(el.textContent).slice(0, max || 80) || undefined
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
    // 正文候选：class 里带 markdown / message / segment / answer / reply / content
    // 且实际有内容的元素 —— 校准 assistantMessage 就靠这张表
    contentCandidates: (function () {
      var out = [];
      var sel = '[class*="markdown"], [class*="message"], [class*="segment"], [class*="answer"], [class*="reply"], [class*="content"]';
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length && out.length < 30; i++) {
        var el = els[i];
        var t = clean(el.textContent);
        if (t.length < 25) continue;
        out.push({ tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className.slice(0, 140) : '', chain: chainOf(el), len: t.length, text: t.slice(0, 160) });
      }
      return out;
    })(),
    bodyTail: clean(document.body.innerText).slice(-400)
  };
})()
`;

/**
 * 流式轮询脚本（--send）。
 * 返回：正文候选（含 DOM 链与 HTML 片段）+ 是否还在生成（停止按钮可见）+ 输入框残留文本。
 * 输入框残留文本用来判断"Enter 到底发出去没有"——ProseMirror 这类编辑器有时会吞掉回车。
 */
const SEND_DUMP_SCRIPT = `
(function () {
  var clean = function (t) { return (t || '').replace(/\\s+/g, ' ').trim(); };
  var chainOf = function (el) {
    var parts = [];
    var node = el;
    for (var i = 0; i < 6 && node && node.tagName && node.tagName.toLowerCase() !== 'body'; i++) {
      var cls = typeof node.className === 'string' ? node.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      parts.unshift(node.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  var visible = function (el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  var contentSel = '[class*="markdown"], [class*="message"], [class*="segment"], [class*="answer"], [class*="reply"], [class*="content"]';
  var els = document.querySelectorAll(contentSel);
  var items = [];
  var total = 0;
  for (var i = 0; i < els.length && items.length < 40; i++) {
    var el = els[i];
    var t = clean(el.textContent);
    if (t.length < 2) continue;
    total += t.length;
    items.push({
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
      chain: chainOf(el),
      len: t.length,
      kids: el.children.length,
      text: t.slice(0, 220),
      html: (el.outerHTML || '').slice(0, 700)
    });
  }
  var stopEls = document.querySelectorAll('[aria-label], [title], button, [class*="stop"], [data-testid*="stop"]');
  var stopVisible = 0;
  var stopCandidates = [];
  for (var j = 0; j < stopEls.length; j++) {
    var s = stopEls[j];
    var label = (s.getAttribute('aria-label') || '') + ' / ' + (s.getAttribute('title') || '') + ' / ' + clean(s.textContent);
    if (!/(停止|stop|中止|interrupt)/i.test(label)) continue;
    if (!visible(s)) continue;
    stopVisible += 1;
    if (stopCandidates.length < 12) {
      stopCandidates.push({
        tag: s.tagName.toLowerCase(),
        cls: typeof s.className === 'string' ? s.className.slice(0, 160) : '',
        testid: s.getAttribute('data-testid') || undefined,
        aria: s.getAttribute('aria-label') || undefined,
        title: s.getAttribute('title') || undefined,
        text: clean(s.textContent).slice(0, 40),
        chain: chainOf(s)
      });
    }
  }
  // 可点击元素清单：校准"发送/停止"按钮最直接的手段（图标按钮往往没有文字，只能靠 aria-label / title 认）
  var clickables = [];
  // 只扫"输入框附近"的按钮：全页扫描会被侧边栏几百个按钮淹没，真正想要的发送/停止按钮在输入区
  var boxForScope = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  var scope = boxForScope;
  for (var up = 0; up < 6 && scope && scope.parentElement; up++) scope = scope.parentElement;
  var clickEls = (scope || document).querySelectorAll('button, [role="button"], [class*="btn"], [class*="button"]');
  for (var k = 0; k < clickEls.length && clickables.length < 30; k++) {
    var c = clickEls[k];
    if (!visible(c)) continue;
    var ctext = clean(c.textContent).slice(0, 24);
    var caria = c.getAttribute('aria-label') || '';
    var ctitle = c.getAttribute('title') || '';
    if (!ctext && !caria && !ctitle) continue;
    clickables.push({ tag: c.tagName.toLowerCase(), cls: (typeof c.className === 'string' ? c.className : '').slice(0, 120), aria: caria || undefined, title: ctitle || undefined, testid: c.getAttribute('data-testid') || undefined, text: ctext || undefined });
  }
  // 定向选择器体检：把一批"可能是发送/停止按钮"的候选逐个报出命中数与可见数。
  // 生成过程中调一次，就能看出按钮是从"发送"变成了"停止"还是根本换了结构。
  var probeSels = ['[class*="send-button"]','[class*="stop"]','[class*="send-btn"]','[class*="stop-btn"]','[data-testid*="send"]','[data-testid*="stop"]','[aria-label*="停止"]','[aria-label*="发送"]','[class*="editor"] button','[class*="input"] button'];
  var selReport = [];
  for (var q = 0; q < probeSels.length; q++) {
    var hit = document.querySelectorAll(probeSels[q]);
    var visN = 0;
    for (var h = 0; h < hit.length; h++) if (visible(hit[h])) visN += 1;
    if (hit.length > 0) {
      selReport.push({ sel: probeSels[q], count: hit.length, visible: visN, firstCls: typeof hit[0].className === 'string' ? hit[0].className.slice(0, 120) : '' });
    }
  }
  var box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  var boxText = '';
  if (box) boxText = clean(box.tagName === 'TEXTAREA' ? box.value : box.textContent);
  return {
    url: location.href,
    title: document.title,
    stopVisible: stopVisible,
    stopCandidates: stopCandidates,
    clickables: clickables,
    selReport: selReport,
    inputLeft: boxText.slice(0, 60),
    totalLen: total,
    bodyLen: (document.body.innerText || '').length,
    bodyTail: clean(document.body.innerText).slice(-300),
    items: items
  };
})()
`;

for (const provider of providers) {
  console.log(`\n══════════ ${providerLabel(provider)} ══════════`);
  const selectors = loadSelectors(provider, { reload: true });
  console.log(`选择器文件：${selectorsFile(provider)}`);
  try {
    const page = await pool.openWindow(provider, targetUrl ?? PROVIDER_SITES[provider]);
    if (targetUrl) {
      // 明确指定了地址就直接导航（openWindow 只在空白页时才会自己导航）
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    // SPA 首屏之后还会渲染一阵子，等一会儿再采样，否则拿到的是空壳
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    // 打开历史会话时要多等一会儿：正文是懒加载的，太早采样只会拿到空壳
    await page.waitForTimeout((targetUrl ? 10_000 : 3_000) + extraWaitMs);
    console.log(`  入口    ${PROVIDER_SITES[provider]}`);
    console.log(`  当前    ${page.url()}`);
    console.log(`  标题    ${(await page.title().catch(() => '')) || '(空)'}`);

    console.log('\n  字段              命中  候选');
    for (const [field, value] of Object.entries(selectors)) {
      if (typeof value !== 'string' || field === 'notes') continue;
      for (const [index, one] of candidates(value).entries()) {
        const count = await page.locator(one).count().catch(() => -1);
        const mark = count > 0 ? '✔' : count < 0 ? '?' : '✘';
        console.log(`  ${(index === 0 ? field : '').padEnd(17)} ${mark} ${String(count).padStart(3)}  ${one}`);
      }
    }

    if (imagePath) {
      console.log(`\n  ── 图片上传演练：${imagePath} ──`);
      const fileInputs = page.locator('input[type="file"]');
      const inputCount = await fileInputs.count().catch(() => 0);
      console.log(`  页面上有 ${inputCount} 个 input[type=file]`);
      for (let index = 0; index < inputCount; index += 1) {
        const one = fileInputs.nth(index);
        const meta = await one
          .evaluate(
            `(function (el) { return { cls: el.className, accept: el.accept, multiple: el.multiple, hidden: el.hidden }; })()`,
          )
          .catch(() => ({ cls: '?', accept: '?', multiple: '?', hidden: '?' }));
        console.log(`    #${index + 1} cls="${(meta as { cls: string }).cls}" accept="${(meta as { accept: string }).accept}" multiple=${String((meta as { multiple: boolean }).multiple)}`);
        try {
          await one.setInputFiles(imagePath, { timeout: 15_000 });
          console.log(`    #${index + 1} setInputFiles 成功`);
        } catch (err) {
          console.log(`    #${index + 1} setInputFiles 失败：${(err as Error).message}`);
        }
        await page.waitForTimeout(2_500);
        const probe = await page
          .evaluate(
            `(function () {
              var boxes = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
              var scope = boxes[0];
              for (var i = 0; i < 7 && scope && scope.parentElement; i++) scope = scope.parentElement;
              var imgs = document.querySelectorAll('img');
              var thumbs = [];
              for (var k = 0; k < imgs.length; k++) {
                var r = imgs[k].getBoundingClientRect();
                if (r.width > 20 && r.height > 20 && r.top > window.innerHeight * 0.4) {
                  thumbs.push({ src: (imgs[k].src || '').slice(0, 90), w: Math.round(r.width), h: Math.round(r.height) });
                }
              }
              return { thumbs: thumbs.slice(0, 8), inputArea: scope ? scope.outerHTML.slice(0, 2600) : '' };
            })()`,
          )
          .catch(() => null);
        const file = path.join(probeDir, `${provider}-upload.json`);
        fs.writeFileSync(file, JSON.stringify(probe, null, 2), 'utf8');
        console.log(`    输入区快照 → ${file}`);
      }
    }

    if (dumpSelector) {
      // 逐行 dump：把每一行的 class 与 outerHTML 片段写盘。
      // 校准"消息行 / 助手正文"这种嵌在虚拟列表里的结构，看这个文件最快。
      const rows = (await page
        .evaluate(
          `(function () {
            var els = document.querySelectorAll(${JSON.stringify(dumpSelector)});
            var out = [];
            for (var i = 0; i < els.length && i < 12; i++) {
              var el = els[i];
              out.push({
                index: i,
                cls: typeof el.className === 'string' ? el.className : '',
                len: (el.textContent || '').replace(/\\s+/g, ' ').trim().length,
                html: (el.outerHTML || '').slice(0, 4000)
              });
            }
            return out;
          })()`,
        )
        .catch((err: unknown) => [{ error: err instanceof Error ? err.message : String(err) }])) as unknown[];
      const file = path.join(probeDir, `${provider}-rows.json`);
      fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
      console.log(`\n  行 dump（${dumpSelector}）：${rows.length} 行 → ${file}`);
    }

    if (deep) {
      const snapshot = await page.evaluate(COLLECT_SCRIPT).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      const file = path.join(probeDir, `${provider}.json`);
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
      console.log(`\n  结构快照已保存：${file}`);
    }

    if (sendText) {
      console.log(`\n  ── 真发一条探测消息：「${sendText}」 ──`);
      await sendAndDump(page, provider, selectors.input, selectors.sendButton, sendText);
    }
  } catch (err) {
    console.log(`  ❌ 探测失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 往输入框打字并发送，然后**持续跟踪直到回复长度不再增长**，再 dump 消息区结构。
 *
 * 输入框分两类：textarea（DeepSeek）用 fill；contenteditable（豆包 / Kimi）用真实键盘输入，
 * 因为 ProseMirror / tiptap 这类编辑器只认真实 key 事件，直接改 value 它不理你。
 *
 * 稳定性判据（踩过的坑）：只看"文本不再变化"会误判——模型还在「深度思考」时正文本来就不长，
 * 会提前退出。所以必须先看到总长度**增长过若干次**，再要求连续 N 次不变，才认为生成结束。
 */
async function sendAndDump(
  page: Page,
  provider: string,
  inputSelector: string,
  sendButtonSelector: string | undefined,
  text: string,
): Promise<void> {
  const input = page.locator(inputSelector).first();
  await input.waitFor({ state: 'visible', timeout: 25_000 });
  await input.click();

  const editable = await input.getAttribute('contenteditable').catch(() => null);
  if (editable === 'true') {
    await page.keyboard.type(text, { delay: 25 });
  } else {
    await input.fill('');
    await input.fill(text);
  }
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');

  // 兜底：有些编辑器把 Enter 当成换行，输入框里还留着原文 → 改点发送按钮
  await page.waitForTimeout(1_500);
  const afterEnter = (await page.evaluate(SEND_DUMP_SCRIPT).catch(() => null)) as { inputLeft?: string } | null;
  const leftover = afterEnter?.inputLeft ?? '';
  if (leftover.trim().length > 0 && sendButtonSelector) {
    console.log(`  ⚠️ Enter 之后输入框里还剩「${leftover}」，改点发送按钮…`);
    const btn = page.locator(sendButtonSelector).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 5_000 }).catch(() => undefined);
    }
  }
  console.log('  已发送，开始跟踪回复（最多 180s）…');

  const TICK_MS = 1_500;
  const MAX_TICKS = 120;
  // 归一化：忽略空白差异，用来判断"这条候选是不是用户发出去的那句话"
  const normalize = (value: string) => (value || '').replace(/\s+/g, '');
  const sent = normalize(text);
  const file = path.join(probeDir, `${provider}-after-send.json`);
  let lastSignature = '';
  let previousLen = -1;
  let growthTicks = 0;
  let stable = 0;
  let appeared = false;
  let lastSnap: unknown = null;
  // 生成过程中出现过的"停止按钮"候选（跨 tick 累积，用来离线校准 stopButton 选择器）
  const stopSeen = new Map<string, unknown>();

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    await page.waitForTimeout(TICK_MS);
    const snap = (await page.evaluate(SEND_DUMP_SCRIPT).catch(() => null)) as
      | { stopVisible: number; totalLen: number; items: { cls: string; len: number; text: string }[]; inputLeft?: string }
      | null;
    if (!snap) continue;
    if (!lastSnap) fs.writeFileSync(path.join(probeDir, `${provider}-streaming.json`), JSON.stringify(snap, null, 2), 'utf8');
    lastSnap = snap;
    for (const cand of (snap as { stopCandidates?: unknown[] }).stopCandidates ?? []) {
      stopSeen.set(JSON.stringify(cand), cand);
    }

    // 签名只看结构 + 各候选长度，避免同一个字被重排时白刷一次
    const signature = JSON.stringify(snap.items.map((item) => `${item.cls}#${item.len}`));
    if (snap.totalLen > previousLen) growthTicks += 1;
    previousLen = Math.max(previousLen, snap.totalLen);

    if (signature !== lastSignature) {
      stable = 0;
      lastSignature = signature;
      fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
      console.log(
        `    [${Math.round((tick + 1) * TICK_MS / 1000)}s] 候选 ${snap.items.length} 个 / 总字数 ${snap.totalLen} / ` +
          `生成中=${snap.stopVisible > 0 ? '是' : '否'} → 已写入 ${path.basename(file)}`,
      );
    } else {
      stable += 1;
    }

    // 收尾判据：① 已经出现"不是用户那句话"的正文候选（助手气泡已挂载）
    //          ② 不再处于生成中（停止按钮消失） ③ 连续 3 次（≈4.5s）内容一字未变。
    // 短回复（例如"收到"）不会再增长，所以不能只靠长度增长判断，否则会一直等到超时。
    if (snap.items.some((item) => item.len >= 1 && normalize(item.text) !== sent)) appeared = true;
    if (appeared && snap.stopVisible === 0 && stable >= 3) {
      console.log(`  ✅ 回复已稳定（约 ${Math.round((tick + 1) * TICK_MS / 1000)}s，增长 ${growthTicks} 次）`);
      break;
    }
  }

  if (!appeared) {
    console.log('  ⚠️ 结束时仍未看到助手正文：可能发送没成功、命中了验证码，或选择器需要重新校准。');
  }
  const finalSnap = lastSnap ?? (await page.evaluate(SEND_DUMP_SCRIPT).catch(() => null));
  if (finalSnap) {
    fs.writeFileSync(file, JSON.stringify(finalSnap, null, 2), 'utf8');
    console.log(`  最终结构：${file}`);
  }
  if (stopSeen.size > 0) {
    const stopFile = path.join(probeDir, `${provider}-stop-candidates.json`);
    fs.writeFileSync(stopFile, JSON.stringify([...stopSeen.values()], null, 2), 'utf8');
    console.log(`  停止按钮候选（${stopSeen.size} 个）：${stopFile}`);
  }
}

console.log('\n提示：改完 selectors/*.json 后重新跑本命令即可验证，不需要重启服务（探针每次强制重读 JSON）。');
if (autoClose) {
  await pool.closeAll();
  process.exit(0);
}
console.log('浏览器窗口保持打开（加 --close 可自动关闭，Ctrl+C 退出）。');
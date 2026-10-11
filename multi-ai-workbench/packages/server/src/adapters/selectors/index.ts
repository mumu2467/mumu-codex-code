/**
 * 网页版选择器（外置 JSON）。
 *
 * 为什么外置：三家网页版都是 SPA，改版频繁；选择器一旦失效，
 * 只需要改这里的 JSON，不用碰任何逻辑代码。
 *
 * 写法约定：每个字段都可以填**多个候选**（CSS 选择器列表，逗号分隔），
 * Playwright 会取第一个命中的元素——单条失效不至于整体崩掉。
 *
 * 校准方式：`npm run probe -- <provider>` 会把每个候选在真实页面上的命中情况打出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Provider } from '@maw/shared';
import { AdapterError } from '../../utils/errors.js';

const SelectorSchema = z.object({
  /** 页面就绪判定（出现它 = SPA 首屏已渲染） */
  ready: z.string(),
  /** 已登录判定（出现它 = 登录态有效） */
  loggedIn: z.string(),
  /** 未登录判定（可选）。与 loggedIn 配合，避免登录页里也有同款元素造成误判 */
  loggedOut: z.string().optional(),
  /** 未登录时的地址特征（正则字符串，可选）。比选择器更可靠，例如 DeepSeek 会跳到 /sign_in */
  loggedOutUrl: z.string().optional(),
  /** 输入框（textarea 或 contenteditable） */
  input: z.string(),
  /**
   * 输入框类型：
   *  - textarea ：直接 fill() 就行（DeepSeek）
   *  - editable ：contenteditable / ProseMirror，必须用键盘事件喂进去（豆包 / Kimi）
   * 默认 editable —— 因为它对 textarea 也基本能用（多一层回退而已），反之则不行。
   */
  inputKind: z.enum(['textarea', 'editable']).default('editable'),
  /** 发送按钮（可选；没有就靠 Enter 发送） */
  sendButton: z.string().optional(),
  /** 停止生成按钮（可选；有它才能"停止生成"） */
  stopButton: z.string().optional(),
  /** 助手消息容器：取**最后一个**即为当前这条回复 */
  assistantMessage: z.string(),
  /**
   * 「正在生成」标志（可选）：命中且可见 = 还在流式输出。
   * 有它就能一边流式一边放心地判定结束；没有就只能靠"文本静默一段时间"来兜底。
   */
  streaming: z.string().optional(),
  /** 用户消息容器：用来确认消息确实发出去了 */
  userMessage: z.string(),
  /** 新建对话按钮（可选） */
  newChat: z.string().optional(),
  /** 上传图片用的 file input（可选） */
  fileInput: z.string().optional(),
  /** 风控 / 验证码提示（可选） */
  blocked: z.string().optional(),
  /** 正文在容器内的子选择器（可选；不给就取容器全文） */
  body: z.string().optional(),
  /** 备注：这份选择器是什么时候、基于什么页面结构写的 */
  notes: z.string().optional(),
});

export type WebSelectors = z.infer<typeof SelectorSchema>;

const selectorsDir = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<Provider, WebSelectors>();

export function selectorsFile(provider: Provider): string {
  return path.join(selectorsDir, `${provider}.json`);
}

/** 读取某家的选择器；默认带缓存，reload=true 时重新读盘（改 JSON 后不必重启） */
export function loadSelectors(provider: Provider, options?: { reload?: boolean }): WebSelectors {
  if (!options?.reload) {
    const cached = cache.get(provider);
    if (cached) return cached;
  }
  const file = selectorsFile(provider);
  if (!fs.existsSync(file)) {
    throw new AdapterError(`缺少 ${provider} 的选择器文件：${file}`, 'selector', false);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AdapterError(`解析 ${file} 失败：${(err as Error).message}`, 'selector', false);
  }
  const parsed = SelectorSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new AdapterError(`${file} 内容不合法：${detail}`, 'selector', false);
  }
  cache.set(provider, parsed.data);
  return parsed.data;
}

/** 把「多候选」字段拆成数组，方便探针逐个报告命中情况 */
export function candidates(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
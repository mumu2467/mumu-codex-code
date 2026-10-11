/** 纯文本工具：token 估算与标题截取（前后端共用同一套口径） */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * token 估算（启发式）：
 * 中日韩字符约 1 token/字，其余按 3.6 字符/token 折算。
 * 只用于 UI 展示的数量级参考，不参与计费。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 3.6));
}

/** 用首条用户消息生成会话标题 */
export function titleFromText(text: string, max = 20): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '新会话';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 毫秒格式化：1234 -> "1.23s"，456 -> "456ms" */
export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
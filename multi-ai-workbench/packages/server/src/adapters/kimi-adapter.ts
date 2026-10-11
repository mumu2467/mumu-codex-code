/**
 * Kimi 网页版（www.kimi.com）适配器。
 *
 * 实测要点（这家最容易踩坑）：
 *   - 输入框是 div.chat-input-editor（role=textbox）；
 *   - **思考链也会渲染进 DOM**（div.markdown-container.toolcall-content-text），
 *     正式回答是 div.markdown-container 但不带 toolcall-content-text ——
 *     选择器必须 :not() 掉，否则会把思考过程当成回复内容（已在 selectors/kimi.json 里处理）；
 *   - 生成中发送按钮会变成 div.send-button-container.stop，可直接当"生成中"标志；
 *   - 长文本用 insertText 一次性插入，逐字敲太慢（1000 字要 12 秒以上）。
 */
import type { BrowserPool } from '../browser/browser-pool.js';
import type { Logger } from '../utils/logger.js';
import { BaseWebAdapter } from './base-web-adapter.js';

export class KimiWebAdapter extends BaseWebAdapter {
  constructor(pool: BrowserPool, log: Logger) {
    super('kimi', pool, log, {
      firstTokenTimeoutMs: 60_000,
      overallTimeoutMs: 6 * 60_000,
      idleMs: 1_800,
    });
  }
}
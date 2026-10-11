/**
 * 豆包网页版（www.doubao.com）适配器。
 *
 * 实测要点：
 *   - 输入框是 TipTap 的 div.ProseMirror，**只认真实键盘事件**，改 textContent 无效；
 *   - 助手消息 data-testid=receive_message、正文 data-testid=message_text_content；
 *   - 生成中正文元素会带 data-streaming="true"，是全站最可靠的"还在输出"信号 → 结束判定很准；
 *   - 会话地址形如 /chat/<id>，早期版本会给 local_* 的本地临时会话（刷新即丢），
 *     所以本适配器**不刷新页面**，只在自己这一页里连续对话。
 */
import type { BrowserPool } from '../browser/browser-pool.js';
import type { Logger } from '../utils/logger.js';
import { BaseWebAdapter } from './base-web-adapter.js';

export class DoubaoWebAdapter extends BaseWebAdapter {
  constructor(pool: BrowserPool, log: Logger) {
    super('doubao', pool, log, {
      firstTokenTimeoutMs: 60_000,
      overallTimeoutMs: 6 * 60_000,
      idleMs: 1_500,
    });
  }
}
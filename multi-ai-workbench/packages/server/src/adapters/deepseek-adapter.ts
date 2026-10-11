/**
 * DeepSeek 网页版（chat.deepseek.com）适配器。
 *
 * 这家的"坑"最少，通用基类基本够用，这里只调参数 + 记录实测到的事实：
 *   - 输入框是普通 textarea，fill() 可用，回车即可发送，回车后输入框自己清空；
 *   - 助手正文容器 div.ds-assistant-message-main-content **只含正文**，
 *     「深度思考」的内容在别的元素里，不会被误抓（这是选它的关键理由）；
 *   - 消息区是虚拟列表，只有可见项在 DOM 里；
 *   - 开启深度思考时首字可能要等几十秒，所以首字超时给到 90s。
 */
import type { BrowserPool } from '../browser/browser-pool.js';
import type { Logger } from '../utils/logger.js';
import { BaseWebAdapter } from './base-web-adapter.js';

export class DeepSeekWebAdapter extends BaseWebAdapter {
  constructor(pool: BrowserPool, log: Logger) {
    super('deepseek', pool, log, {
      firstTokenTimeoutMs: 90_000,
      overallTimeoutMs: 8 * 60_000,
      // DeepSeek 没有可用的"生成中"标志，只能靠静默判定，给保守一点
      idleMsNoStreamingFlag: 3_500,
    });
  }
}
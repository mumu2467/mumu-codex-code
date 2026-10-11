/**
 * 网页版适配器工厂：provider → 具体适配器。
 *
 * 加第五家 AI 时，只需要：
 *   1. 在 packages/shared 的 PROVIDERS 里加枚举
 *   2. 加一个 selectors/<provider>.json
 *   3. 加一个 <provider>-adapter.ts（继承 BaseWebAdapter，只写差异）
 *   4. 在这里加一个 case
 * 其余编排、WebSocket、前端全都不用动。
 */
import type { Provider } from '@maw/shared';
import type { BrowserPool } from '../browser/browser-pool.js';
import type { Logger } from '../utils/logger.js';
import { DeepSeekWebAdapter } from './deepseek-adapter.js';
import { DoubaoWebAdapter } from './doubao-adapter.js';
import { KimiWebAdapter } from './kimi-adapter.js';
import type { ChatAdapter } from './types.js';

export function createWebAdapter(provider: Provider, pool: BrowserPool, log: Logger): ChatAdapter {
  switch (provider) {
    case 'deepseek':
      return new DeepSeekWebAdapter(pool, log);
    case 'doubao':
      return new DoubaoWebAdapter(pool, log);
    case 'kimi':
      return new KimiWebAdapter(pool, log);
    default: {
      const never: never = provider;
      throw new Error(`没有为 ${String(never)} 实现网页版适配器`);
    }
  }
}
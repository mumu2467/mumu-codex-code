/**
 * 浏览器池 —— Playwright 通道的基础设施层。
 *
 * 设计要点：
 *  1. 每个 provider 一个**持久化** user-data-dir（`<storage>/.browser-profile/<provider>`）。
 *     cookie / localStorage / IndexedDB / Service Worker 全部由 Chromium 自己维护，
 *     比"手动导出 storageState 再导入"更不容易掉登录态。
 *  2. 同时把 storageState 导出为 JSON（`<storage>/browser/<provider>.json`），
 *     用于备份、迁移到 Docker 卷、换机器时复用。
 *  3. 上下文与窗口**懒创建**：只有真正用到某一家时才启动它的浏览器；一个 provider 一个进程，
 *     互不影响（一家的风控/崩溃不会拖垮另外两家）。
 *  4. 默认 headed（打开真实窗口）。三家登录都要扫码或人工过验证码，无头模式根本没法登录。
 *
 * 安全：`.browser-profile/` 与 `browser/*.json` 里都是登录凭据，
 * 仓库根 .gitignore 已按 `**​/.browser-profile/` 忽略，`storage/` 整体也在忽略范围内，禁止入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserProfileStatus, Provider } from '@maw/shared';
import { PROVIDERS, providerLabel } from '@maw/shared';
import { config } from '../config.js';
import { AdapterError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

/** 三家网页版入口（未登录时访问会自动跳转到各自的登录页） */
export const PROVIDER_SITES: Record<Provider, string> = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/chat/',
  kimi: 'https://www.kimi.com/',
};

/**
 * playwright 与 playwright-extra 的 chromium 在"持久化启动"这一项上签名一致；
 * 这里只声明用得到的那一个方法，避免为一个可选依赖把类型搞复杂。
 */
interface ChromiumLike {
  launchPersistentContext(
    userDataDir: string,
    options?: Record<string, unknown>,
  ): Promise<BrowserContext>;
}

export class BrowserPool {
  private readonly contexts = new Map<Provider, BrowserContext>();
  private readonly launching = new Map<Provider, Promise<BrowserContext>>();
  private chromiumPromise?: Promise<ChromiumLike>;
  private closing = false;

  constructor(private readonly log: Logger) {}

  // ------------------------------------------------------------- 路径

  profileDir(provider: Provider): string {
    return path.join(config.browser.profileRoot, provider);
  }

  stateFile(provider: Provider): string {
    return path.join(config.browser.stateDir, `${provider}.json`);
  }

  // ------------------------------------------------------------- 内核

  /**
   * 优先加载 playwright-extra + stealth 插件。
   * 三家都会做自动化特征检测（navigator.webdriver、CDP 痕迹等），原生 Playwright
   * 很容易在登录环节就被拦；插件不可用时自动退回原生实现并打警告，不影响功能。
   */
  private chromium(): Promise<ChromiumLike> {
    if (!this.chromiumPromise) {
      this.chromiumPromise = (async (): Promise<ChromiumLike> => {
        try {
          const extra = (await import('playwright-extra')) as unknown as {
            chromium: ChromiumLike & { use(plugin: unknown): void };
          };
          const stealth = (await import('puppeteer-extra-plugin-stealth')) as unknown as {
            default: () => unknown;
          };
          extra.chromium.use(stealth.default());
          this.log.info('浏览器内核：playwright-extra + stealth（已启用反自动化检测补丁）');
          return extra.chromium;
        } catch (err) {
          this.log.warn(`stealth 插件不可用，回退到原生 playwright：${(err as Error).message}`);
          const pw = (await import('playwright')) as unknown as { chromium: ChromiumLike };
          return pw.chromium;
        }
      })();
    }
    return this.chromiumPromise;
  }

  // ------------------------------------------------------------- 生命周期

  /** 取得（必要时创建）某个 provider 的持久化上下文 */
  async contextFor(provider: Provider): Promise<BrowserContext> {
    if (this.closing) throw new AdapterError('浏览器池正在关闭', 'unknown', false);
    const existing = this.contexts.get(provider);
    if (existing) return existing;
    const inflight = this.launching.get(provider);
    if (inflight) return inflight;

    const task = this.launch(provider);
    this.launching.set(provider, task);
    try {
      return await task;
    } finally {
      this.launching.delete(provider);
    }
  }

  /**
   * 决定用哪个浏览器内核。
   * 优先级：显式配置 BROWSER_CHANNEL > Playwright 自带 Chromium（已安装时） > 本机 Edge / Chrome。
   * 这样即使 `npx playwright install chromium` 还没跑完（或网速下不动），
   * 只要机器上装了 Edge / Chrome 就能立刻开工——Windows 一般自带 Edge。
   */
  private async resolveChannel(): Promise<string | undefined> {
    if (this.channelPromise) return this.channelPromise;
    this.channelPromise = this.detectChannel();
    return this.channelPromise;
  }

  private channelPromise?: Promise<string | undefined>;

  private async detectChannel(): Promise<string | undefined> {
    if (config.browser.channel) return config.browser.channel;

    try {
      const pw = (await import('playwright')) as unknown as {
        chromium: { executablePath(): string };
      };
      const bundled = pw.chromium.executablePath();
      if (bundled && fs.existsSync(bundled)) return undefined;
    } catch {
      /* 自带内核未安装，继续探测系统浏览器 */
    }

    const candidates: { channel: string; exe: string }[] = [
      { channel: 'msedge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
      { channel: 'msedge', exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
      { channel: 'chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { channel: 'chrome', exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate.exe)) {
        this.log.info(`未找到 Playwright 自带内核，改用本机浏览器：${candidate.channel}`);
        return candidate.channel;
      }
    }

    throw new AdapterError(
      '没找到可用的浏览器内核：Playwright 自带 Chromium 未安装，本机也没有 Chrome / Edge。\n' +
        '任选其一即可：① 执行 npx playwright install chromium；② 安装 Chrome 或 Edge。',
      'unknown',
      false,
    );
  }

  private async launch(provider: Provider): Promise<BrowserContext> {
    const chromium = await this.chromium();
    const channel = await this.resolveChannel();
    const userDataDir = this.profileDir(provider);
    fs.mkdirSync(userDataDir, { recursive: true });
    this.log.info(
      `启动浏览器：${providerLabel(provider)}（${config.browser.headless ? 'headless' : 'headed'}，内核 ${channel ?? 'chromium'}）`,
    );

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: config.browser.headless,
        channel,
        slowMo: config.browser.slowMo,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        acceptDownloads: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
    } catch (err) {
      throw this.decorateLaunchError(provider, err);
    }

    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    context.on('close', () => {
      this.contexts.delete(provider);
      this.log.info(`${providerLabel(provider)} 浏览器已关闭`);
    });
    this.contexts.set(provider, context);
    return context;
  }

  /** 把底层报错翻译成"人话 + 可操作步骤"，这是这套系统能不能自助排障的关键 */
  private decorateLaunchError(provider: Provider, err: unknown): AdapterError {
    const message = (err as Error)?.message ?? String(err);
    if (/Executable doesn't exist|run the following command to download/i.test(message)) {
      return new AdapterError(
        '浏览器内核尚未安装。请执行 npx playwright install chromium，或安装 Chrome / Edge 后把 BROWSER_CHANNEL 设为 chrome / msedge。',
        'unknown',
        false,
      );
    }
    if (/ProcessSingleton|SingletonLock|already (running|in use)|profile.*in use|user data directory/i.test(message)) {
      return new AdapterError(
        `${providerLabel(provider)} 的浏览器 profile 正被另一个进程占用（后端服务可能已经在运行）。` +
          '请改用应用界面里的「登录」按钮，或先停掉服务再运行登录脚本。',
        'unknown',
        false,
      );
    }
    return new AdapterError(`启动 ${providerLabel(provider)} 浏览器失败：${message}`, 'unknown', true);
  }

  /** 拿到该 provider 的一个可用页面（优先复用已开的窗口，避免越开越多） */
  async pageFor(provider: Provider): Promise<Page> {
    const context = await this.contextFor(provider);
    const pages = context.pages().filter((page) => !page.isClosed());
    return pages[pages.length - 1] ?? (await context.newPage());
  }

  /** 打开 / 聚焦该 provider 的窗口；只有在尚未导航到站点时才做一次导航 */
  async openWindow(provider: Provider, url = PROVIDER_SITES[provider]): Promise<Page> {
    const page = await this.pageFor(provider);
    if (!/^https?:/i.test(page.url())) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    await page.bringToFront().catch(() => undefined);
    return page;
  }

  /** 导出 storageState（备份 / 迁移用） */
  async saveState(provider: Provider): Promise<string> {
    const context = this.contexts.get(provider);
    if (!context) {
      throw new AdapterError(`${providerLabel(provider)} 的浏览器尚未启动，无法导出登录态`, 'unknown', false);
    }
    const file = this.stateFile(provider);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await context.storageState({ path: file });
    return file;
  }

  async close(provider: Provider): Promise<void> {
    const context = this.contexts.get(provider);
    if (!context) return;
    this.contexts.delete(provider);
    await context.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    try {
      await Promise.all(PROVIDERS.map((provider) => this.close(provider)));
    } finally {
      this.closing = false;
    }
  }

  // ------------------------------------------------------------- 状态

  status(): BrowserProfileStatus[] {
    return PROVIDERS.map((provider) => ({
      provider,
      label: providerLabel(provider),
      url: PROVIDER_SITES[provider],
      hasProfile: fs.existsSync(this.profileDir(provider)),
      hasStateFile: fs.existsSync(this.stateFile(provider)),
      windowOpen: this.contexts.has(provider),
    }));
  }
}
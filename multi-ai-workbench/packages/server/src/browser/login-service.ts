/**
 * 登录服务：打开三家真实浏览器窗口 → 人工扫码 / 输手机号 / 过验证码 → 检测到登录后落盘。
 *
 * 为什么必须人工：三家在新设备 / 异地登录时都会要求短信验证码或 App 扫码，
 * 这是它们风控的一部分。任何"全自动登录"本质上都是在绕过风控，既不稳定也不合规。
 * 所以这里的定位是「人工登录 + 自动化保存 + 自动化复用」：
 * 你只在第一次（或登录态过期时）扫一次码，之后所有自动请求都复用这份 profile。
 */
import type { LoginPhase, LoginState, Provider } from '@maw/shared';
import { PROVIDERS, providerLabel } from '@maw/shared';
import { loadSelectors } from '../adapters/selectors/index.js';
import { config } from '../config.js';
import { sleep } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { BrowserPool } from './browser-pool.js';

export interface LoginServiceDeps {
  pool: BrowserPool;
  log: Logger;
  /** 等待人工登录的超时，默认取 LOGIN_TIMEOUT_MS */
  timeoutMs?: number;
  /** 登录状态轮询间隔 */
  pollMs?: number;
}

/** 仍然"进行中"的阶段——只有这些阶段可以被取消 */
const ACTIVE_PHASES = new Set<LoginPhase>(['opening', 'waiting', 'saving']);

/**
 * 连续命中多少次"已登录"才判定成功。
 *
 * 为什么需要它：SPA 首屏是分批渲染的——输入框往往先出来、"登录"按钮后出来，
 * 中间那一两秒看起来"输入框在、未登录标记不在"，会被误判成登录成功。
 * 要求连续若干次轮询都成立，就能把这种竞态过滤掉（实测 Kimi 就是栽在这里）。
 */
const REQUIRED_CONFIRM_STREAK = 3;

/**
 * 没见过登出态时的要求：更长的稳定期。
 *
 * 场景：profile 里本来就有登录态（比如上次已经登过），页面从头到尾都不显示登录入口。
 * 这时不能只看一眼就拍板，但也不该逼用户每次手点——要求"连续 6 次轮询都稳定处于登录态"
 * （约 9 秒）已经足以排除首屏渲染竞态。真拿不准还有「我已登录」按钮兜底。
 */
const REQUIRED_STABLE_STREAK = 6;

export class LoginService {
  private readonly states = new Map<Provider, LoginState>();
  private readonly running = new Map<Provider, Promise<LoginState>>();
  private readonly cancelled = new Set<Provider>();
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: LoginServiceDeps) {
    this.timeoutMs = deps.timeoutMs ?? config.loginTimeoutMs;
    this.pollMs = deps.pollMs ?? 1500;
  }

  status(): LoginState[] {
    return PROVIDERS.map((provider) => this.stateOf(provider));
  }

  /**
   * 打开（或复用）指定 provider 的登录窗口，并在后台轮询登录结果。
   *
   * 注意：这里 **不等待** 轮询循环结束。开窗口可能要十几秒、等人扫码可能要几分钟，
   * 阻塞住请求只会让前端转圈转到超时。正确姿势是立刻返回，前端轮询 /api/login/status。
   */
  async start(providers: Provider[] = [...PROVIDERS]): Promise<LoginState[]> {
    for (const provider of providers) {
      void this.ensureWatching(provider).catch(() => undefined);
    }
    return this.status();
  }

  /**
   * 手动确认「我已经登录好了」：跳过自动检测，直接把当前 profile 存一份 storageState。
   * 选择器失效时（平台改版、灰度页面结构不同）这是最可靠的兜底，
   * 不要因为自动检测不准就把人卡死在这。
   */
  async confirm(provider: Provider): Promise<LoginState> {
    const startedAt = this.states.get(provider)?.updatedAt ?? Date.now();
    try {
      const file = await this.deps.pool.saveState(provider);
      this.cancelled.add(provider);
      this.set(provider, startedAt, {
        phase: 'done',
        message: `已手动确认登录，登录态保存到 ${file}`,
      });
    } catch (err) {
      this.set(provider, startedAt, {
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return this.stateOf(provider);
  }

  /** 取消等待。不关窗口——你可以继续手动登录，只是我们不再轮询 */
  cancel(providers: Provider[] = [...PROVIDERS]): LoginState[] {
    for (const provider of providers) {
      const state = this.states.get(provider);
      if (!state || !ACTIVE_PHASES.has(state.phase)) continue;
      this.cancelled.add(provider);
      this.states.set(provider, {
        ...state,
        phase: 'cancelled',
        message: '已取消等待（窗口保持打开，可继续手动登录）',
        updatedAt: Date.now(),
      });
    }
    return this.status();
  }

  // ------------------------------------------------------------- 内部

  private stateOf(provider: Provider): LoginState {
    return (
      this.states.get(provider) ?? {
        provider,
        label: providerLabel(provider),
        phase: 'idle',
        message: '未开始',
        elapsedMs: 0,
        updatedAt: Date.now(),
      }
    );
  }

  private ensureWatching(provider: Provider): Promise<LoginState> {
    const existing = this.running.get(provider);
    if (existing) return existing;
    this.cancelled.delete(provider);
    const task = this.watch(provider).finally(() => this.running.delete(provider));
    this.running.set(provider, task);
    return task;
  }

  private set(
    provider: Provider,
    startedAt: number,
    patch: { phase: LoginPhase; message: string; url?: string },
  ): void {
    this.states.set(provider, {
      provider,
      label: providerLabel(provider),
      url: patch.url ?? this.states.get(provider)?.url,
      phase: patch.phase,
      message: patch.message,
      elapsedMs: Date.now() - startedAt,
      updatedAt: Date.now(),
    });
  }

  private async watch(provider: Provider): Promise<LoginState> {
    const startedAt = Date.now();
    const label = providerLabel(provider);
    try {
      this.set(provider, startedAt, { phase: 'opening', message: '正在打开浏览器窗口…' });
      const page = await this.deps.pool.openWindow(provider);
      const selectors = loadSelectors(provider);
      let loggedOutUrlRe: RegExp | undefined;
      if (selectors.loggedOutUrl) {
        try {
          loggedOutUrlRe = new RegExp(selectors.loggedOutUrl, 'i');
        } catch {
          this.deps.log.warn(`${label} 的 loggedOutUrl 不是合法正则，已忽略：${selectors.loggedOutUrl}`);
        }
      }
      this.set(provider, startedAt, {
        phase: 'waiting',
        url: page.url(),
        message: `请在刚打开的窗口里完成${label}登录（App 扫码 / 手机号 + 验证码）`,
      });

      let confirmStreak = 0;
      // 是否亲眼见过"未登录"形态。没见过的"已登录"一律不信——
      // 三种页面在首屏分批渲染时都可能短暂地"像已登录"，实测就是在这里误判的。
      let sawLoggedOut = false;
      let reportedDetected = false;

      while (Date.now() - startedAt < this.timeoutMs) {
        if (this.cancelled.has(provider)) return this.stateOf(provider);
        if (page.isClosed()) {
          this.set(provider, startedAt, {
            phase: 'error',
            message: '窗口被关闭，登录未完成（可重新发起登录）',
          });
          return this.stateOf(provider);
        }

        const currentUrl = page.url();
        const [loggedIn, loggedOut, blocked] = await Promise.all([
          page.locator(selectors.loggedIn).first().isVisible().catch(() => false),
          selectors.loggedOut
            ? page.locator(selectors.loggedOut).first().isVisible().catch(() => false)
            : Promise.resolve(false),
          selectors.blocked
            ? page.locator(selectors.blocked).first().isVisible().catch(() => false)
            : Promise.resolve(false),
        ]);

        const onLoginUrl = loggedOutUrlRe ? loggedOutUrlRe.test(currentUrl) : false;
        const looksLoggedOut = loggedOut || onLoginUrl;

        if (looksLoggedOut) {
          // 还在登录页 / 还看得到登录入口 → 用户还没登录完
          sawLoggedOut = true;
          confirmStreak = 0;
        } else if (loggedIn) {
          confirmStreak += 1;
          // 见过登出态 → 属于"刚刚扫码成功"，短确认就够；
          // 没见过 → 可能 profile 里本来就有登录态，要求更长的稳定期。
          const needed = sawLoggedOut ? REQUIRED_CONFIRM_STREAK : REQUIRED_STABLE_STREAK;
          if (confirmStreak >= needed) {
            this.set(provider, startedAt, {
              phase: 'saving',
              url: currentUrl,
              message: '检测到登录成功，正在保存登录态…',
            });
            const file = await this.deps.pool.saveState(provider);
            this.deps.log.info(`${label} 登录态已保存：${file}`);
            this.set(provider, startedAt, {
              phase: 'done',
              url: currentUrl,
              message: `登录成功，登录态已持久化到 ${file}`,
            });
            return this.stateOf(provider);
          }
          this.set(provider, startedAt, {
            phase: 'waiting',
            url: currentUrl,
            message: sawLoggedOut
              ? `刚刚登录成功，正在复核（${confirmStreak}/${needed}）…`
              : `确认登录态是否稳定（${confirmStreak}/${needed}）…`,
          });
          await sleep(this.pollMs);
          continue;
        }
        confirmStreak = 0;
        if (!reportedDetected && Date.now() - startedAt > 15_000) {
          // 既没有登录入口、也没有输入框：要么页面还没加载完，要么选择器需要重新校准。
          // 不替用户拍板，给一句可执行的指引。
          reportedDetected = true;
          this.set(provider, startedAt, {
            phase: 'detected',
            url: currentUrl,
            message: `页面结构没认出来，可能还在加载，也可能选择器要校准（npm run probe -- ${provider} --deep）。确认已登录就点「我已登录」。`,
          });
        }

        this.set(provider, startedAt, {
          phase: 'waiting',
          url: currentUrl,
          message: blocked
            ? '检测到验证码 / 风控提示，请在窗口里手动完成'
            : `等待登录中…（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）`,
        });

        await sleep(this.pollMs);
      }

      this.set(provider, startedAt, {
        phase: 'timeout',
        message:
          `等待超时（${Math.round(this.timeoutMs / 1000)}s）。窗口仍然开着，` +
          '如果之后登录成功了，再点一次「登录」即可重新检测。',
      });
      return this.stateOf(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn(`${label} 登录流程失败：${message}`);
      this.set(provider, startedAt, { phase: 'error', message });
      return this.stateOf(provider);
    }
  }
}
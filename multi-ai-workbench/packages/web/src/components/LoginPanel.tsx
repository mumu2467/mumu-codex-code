/**
 * 登录面板：给三家各开一个**真实浏览器窗口**，你在窗口里扫码 / 输验证码登录。
 *
 * 为什么不是 iframe：三家网页版都带 X-Frame-Options / CSP，且同源策略决定了
 * 父页面读不到 iframe 里的 DOM，所以"嵌入登录"从技术上就不成立。
 * 这里改成由后端 Playwright 打开真实窗口 —— 你看到的就是原版页面，
 * 扫码、滑块、短信验证码全都能正常用；登录态由后端持久化保存。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoginPhase, LoginStatusResponse, Provider } from '@maw/shared';
import { LOGIN_PHASE_LABEL, PROVIDERS, PROVIDER_META } from '@maw/shared';
import { api } from '../lib/api';

/** 各阶段的圆点颜色：绿=已完成，黄=进行中，红=失败，灰=未开始 */
const PHASE_COLOR: Record<LoginPhase, string> = {
  idle: '#64748b',
  opening: '#fbbf24',
  waiting: '#fbbf24',
  saving: '#60a5fa',
  detected: '#38bdf8',
  done: '#34d399',
  timeout: '#fb923c',
  error: '#f87171',
  cancelled: '#64748b',
};

export function LoginPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<LoginStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.loginStatus();
      if (alive.current) setStatus(next);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // 面板打开期间轮询登录进度；关掉就停，不打扰后端
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const start = async (providers?: Provider[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.startLogin(providers);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportState = async (provider: Provider) => {
    setError(null);
    try {
      const res = await api.exportLoginState(provider);
      setError(`已导出登录态：${res.file}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-[430px] rounded-xl border border-white/10 bg-[#0b1020]/95 p-3.5 shadow-2xl backdrop-blur-xl">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold text-slate-100">登录三家网页版</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            会弹出真实浏览器窗口，请在每个窗口里用 App 扫码 / 手机号登录。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-white/10 px-1.5 py-0.5 text-[12px] text-slate-400 transition hover:bg-white/10 hover:text-white"
          title="关闭面板"
        >
          ✕
        </button>
      </div>

      {status?.headless ? (
        <div className="mb-2.5 rounded-[9px] border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          当前是 headless 模式，浏览器不会显示窗口，没法扫码。
          请把 <code className="rounded bg-black/40 px-1">.env</code> 里的{' '}
          <code className="rounded bg-black/40 px-1">BROWSER_HEADLESS</code> 改成 <code className="rounded bg-black/40 px-1">false</code> 后重启服务。
        </div>
      ) : null}

      <div className="space-y-1.5">
        {PROVIDERS.map((provider: Provider) => {
          const meta = PROVIDER_META[provider];
          const state = status?.providers.find((item) => item.provider === provider);
          const profile = status?.profiles.find((item) => item.provider === provider);
          const phase: LoginPhase = state?.phase ?? 'idle';
          const color = PHASE_COLOR[phase];
          return (
            <div
              key={provider}
              className="rounded-[9px] border border-white/8 bg-white/[0.03] px-2.5 py-2"
              style={{ borderLeft: `3px solid ${meta.color}` }}
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                <span className="text-[12.5px] font-medium text-slate-200">{meta.label}</span>
                <span className="text-[11px]" style={{ color }}>
                  {LOGIN_PHASE_LABEL[phase]}
                </span>
                {profile?.hasProfile ? (
                  <span className="text-[10.5px] text-slate-500">· 已有本地 profile</span>
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy || !profile?.windowOpen}
                    onClick={() => {
                      setError(null);
                      void api
                        .confirmLogin(provider)
                        .then(refresh)
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        );
                    }}
                    className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-200 transition enabled:hover:bg-emerald-400/20 disabled:opacity-35"
                    title="自动检测不准时：确认我已经在窗口里登录好了，直接保存登录态"
                  >
                    我已登录
                  </button>
                  <button
                    type="button"
                    disabled={busy || !profile?.hasProfile}
                    onClick={() => void exportState(provider)}
                    className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-300 transition enabled:hover:bg-white/10 disabled:opacity-35"
                    title="导出 storageState 备份（已有本地 profile 才可用）"
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void start([provider])}
                    className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-200 transition enabled:hover:bg-white/15 disabled:opacity-50"
                  >
                    {profile?.windowOpen ? '重新检测' : '打开窗口'}
                  </button>
                </div>
              </div>
              <p className="mt-1 pl-4 text-[11px] leading-relaxed text-slate-500">
                {state?.message ?? '尚未开始'}
              </p>
            </div>
          );
        })}
      </div>

      {error ? (
        <div className="mt-2.5 rounded-[9px] border border-rose-400/30 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed break-all text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || status?.headless}
          onClick={() => void start()}
          className="rounded-[9px] bg-gradient-to-br from-[#4F6BFF] to-[#8B5CF6] px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:brightness-110 disabled:opacity-50"
        >
          打开三家的登录窗口
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void api.cancelLogin().then(refresh).catch(() => undefined);
          }}
          className="rounded-[9px] border border-white/10 px-3 py-1.5 text-[12px] text-slate-300 transition enabled:hover:bg-white/10 disabled:opacity-50"
        >
          停止检测
        </button>
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-slate-600">
        登录态保存在后端 storage 目录（Chromium 持久化 profile），下次启动自动复用，不用重复扫码。
        同一 profile 只能被一个进程占用：如果服务在跑，请用这里的按钮，而不是命令行。
      </p>
    </div>
  );
}
/** 顶栏：品牌 + 全局 AI 开关 + 会话切换 + 连接状态 */
import type { CSSProperties } from 'react';
import type { Provider } from '@maw/shared';
import { PROVIDERS, PROVIDER_META } from '@maw/shared';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function TopBar() {
  const wsStatus = useAppStore((s) => s.wsStatus);
  const enabled = useAppStore((s) => s.enabled);
  const toggleProvider = useAppStore((s) => s.toggleProvider);
  const sessions = useAppStore((s) => s.sessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const removeSession = useAppStore((s) => s.removeSession);

  const connection = {
    open: { text: '已连接', color: '#34d399' },
    connecting: { text: '连接中', color: '#fbbf24' },
    closed: { text: '未连接', color: '#f87171' },
  }[wsStatus];

  return (
    <header className="glass-strong sticky top-0 z-20 shrink-0 border-x-0 border-t-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-gradient-to-br from-[#4F6BFF] via-[#8B5CF6] to-[#12B5C9] text-[12px] font-bold text-white">
            聚
          </div>
          <div className="leading-tight">
            <h1 className="text-[13.5px] font-semibold text-slate-100">多 AI 聚合工作台</h1>
            <p className="text-[10.5px] text-slate-500">一条消息 · 三家并发</p>
          </div>
        </div>

        {/* 全局开关 */}
        <div className="flex items-center gap-1.5" role="group" aria-label="选择要发送的 AI">
          {PROVIDERS.map((provider: Provider) => {
            const meta = PROVIDER_META[provider];
            const on = enabled[provider];
            return (
              <button
                key={provider}
                type="button"
                onClick={() => toggleProvider(provider)}
                aria-pressed={on}
                title={`${on ? '取消勾选' : '勾选'} ${meta.label}`}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                  on ? 'text-slate-100' : 'border-white/8 text-slate-500'
                }`}
                style={
                  {
                    borderColor: on ? `color-mix(in srgb, ${meta.color} 55%, transparent)` : undefined,
                    background: on ? `color-mix(in srgb, ${meta.color} 16%, transparent)` : 'rgba(255,255,255,0.03)',
                  } as CSSProperties
                }
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: on ? meta.color : '#475569' }}
                />
                {meta.label}
                <span className={`text-[10px] ${on ? 'text-emerald-300' : 'text-slate-600'}`}>{on ? '✓' : '○'}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/5 px-2.5 py-1 text-[11.5px]">
            <span className={`h-1.5 w-1.5 rounded-full ${wsStatus !== 'open' ? 'pulse' : ''}`} style={{ background: connection.color }} />
            <span className="text-slate-400">{connection.text}</span>
          </div>

          <select
            value={currentSessionId ?? ''}
            onChange={(e) => {
              if (e.target.value) void selectSession(e.target.value);
            }}
            className="max-w-[190px] rounded-[9px] border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-slate-200 outline-none"
            title="切换会话"
          >
            {sessions.length === 0 ? <option value="">（暂无会话）</option> : null}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void createSession()}
            className="rounded-[9px] border border-white/10 bg-white/5 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            新建
          </button>

          {currentSessionId ? (
            <>
              <a
                href={api.exportUrl(currentSessionId, 'md')}
                className="rounded-[9px] border border-white/10 bg-white/5 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                title="把当前会话导出为 Markdown"
              >
                导出
              </a>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('删除当前会话？该操作不可撤销。')) void removeSession(currentSessionId);
                }}
                className="rounded-[9px] border border-white/10 bg-white/5 px-2.5 py-1.5 text-[12px] text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200"
                title="删除当前会话"
              >
                删除
              </button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
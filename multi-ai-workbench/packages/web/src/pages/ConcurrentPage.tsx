/**
 * 页面 1 · 三窗并发
 *   ≥1280px：三列等宽
 *   768–1280px：两列（第三列占满第二行）
 *   <768px：Tab 切换，一次只显示一个窗口
 */
import { useState } from 'react';
import type { Provider } from '@maw/shared';
import { PROVIDERS, PROVIDER_META } from '@maw/shared';
import { Composer } from '../components/Composer';
import { ProviderPane } from '../components/ProviderPane';
import { useAppStore } from '../store/appStore';
import { useMediaQuery } from '../hooks/useMediaQuery';

export function ConcurrentPage() {
  const isWide = useMediaQuery('(min-width: 768px)');
  const [activeTab, setActiveTab] = useState<Provider>('deepseek');
  const replies = useAppStore((s) => s.replies);
  const enabled = useAppStore((s) => s.enabled);

  /** Tab 上的小圆点：该 provider 是否有正在生成的回复 / 是否失败 */
  const tabState = (provider: Provider): 'idle' | 'busy' | 'error' => {
    const mine = Object.values(replies).filter((r) => r.provider === provider);
    if (mine.some((r) => r.status === 'streaming' || r.status === 'pending')) return 'busy';
    const latest = mine[mine.length - 1];
    if (latest?.status === 'error') return 'error';
    return 'idle';
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Composer />

      {isWide ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PROVIDERS.map((provider, index) => (
            <ProviderPane
              key={provider}
              provider={provider}
              // 中屏两列时，第三个窗口独占第二行，避免留下半列空白
              className={index === 2 ? 'md:col-span-2 xl:col-span-1' : ''}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="card glass flex shrink-0 gap-1 p-1" role="tablist">
            {PROVIDERS.map((provider) => {
              const meta = PROVIDER_META[provider];
              const active = provider === activeTab;
              const state = tabState(provider);
              return (
                <button
                  key={provider}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(provider)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[12.5px] transition ${
                    active ? 'text-white' : 'text-slate-400'
                  }`}
                  style={active ? { background: `color-mix(in srgb, ${meta.color} 22%, transparent)` } : undefined}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${state === 'busy' ? 'pulse' : ''}`}
                    style={{
                      background: !enabled[provider]
                        ? '#475569'
                        : state === 'busy'
                          ? meta.color
                          : state === 'error'
                            ? '#f87171'
                            : '#34d399',
                    }}
                  />
                  {meta.label}
                </button>
              );
            })}
          </div>
          <ProviderPane provider={activeTab} className="min-h-0 flex-1" />
        </>
      )}
    </div>
  );
}
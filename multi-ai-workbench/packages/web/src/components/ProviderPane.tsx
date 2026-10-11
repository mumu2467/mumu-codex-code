/** 单个 AI 的独立聊天窗：自己的滚动、自己的状态、自己的停止/清空/新会话 */
import { useMemo } from 'react';
import type { Provider, Reply } from '@maw/shared';
import { PROVIDER_META, REPLY_STATUS_LABEL, formatMs } from '@maw/shared';
import { useAppStore } from '../store/appStore';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { AssistantBubble, UserBubble } from './MessageBubble';

interface Props {
  provider: Provider;
  className?: string;
}

export function ProviderPane({ provider, className = '' }: Props) {
  const meta = PROVIDER_META[provider];
  const messages = useAppStore((s) => s.messages);
  const replies = useAppStore((s) => s.replies);
  const routeInfo = useAppStore((s) => s.routeInfo[provider]);
  const enabled = useAppStore((s) => s.enabled[provider]);
  const stopReply = useAppStore((s) => s.stopReply);
  const retryReply = useAppStore((s) => s.retryReply);
  const clearProvider = useAppStore((s) => s.clearProvider);
  const newProviderSession = useAppStore((s) => s.newProviderSession);

  // 用户消息 × 本 provider 的回复，组成一条条"轮次"
  const turns = useMemo(() => {
    const byUserMessage = new Map<string, Reply>();
    for (const reply of Object.values(replies)) {
      if (reply.provider === provider) byUserMessage.set(reply.userMessageId, reply);
    }
    return messages
      .filter((m) => m.role === 'user')
      .map((message) => ({ message, reply: byUserMessage.get(message.id) }));
  }, [messages, replies, provider]);

  const running = turns.find((t) => t.reply && (t.reply.status === 'streaming' || t.reply.status === 'pending'));
  const lastReply = [...turns].reverse().find((t) => t.reply)?.reply;
  const streamedChars = turns.reduce((sum, t) => sum + (t.reply?.content.length ?? 0), 0);

  // 只有本窗口的内容变化才触发本窗口的滚动（三窗滚动互不影响）
  const scrollRef = useAutoScroll<HTMLDivElement>([turns.length, streamedChars, provider]);

  const statusChip = (() => {
    if (!enabled) return { text: '已取消勾选', tone: 'muted' as const };
    if (routeInfo && !routeInfo.ok) return { text: '通道不可用', tone: 'error' as const };
    if (running) return { text: REPLY_STATUS_LABEL[running.reply!.status], tone: 'busy' as const };
    if (lastReply?.status === 'error') return { text: '上次失败', tone: 'error' as const };
    return { text: '就绪', tone: 'idle' as const };
  })();

  return (
    <section
      className={`card glass flex min-h-0 flex-col overflow-hidden ${className}`}
      style={{ ['--brand' as string]: meta.color }}
      aria-label={`${meta.label} 聊天窗`}
    >
      {/* ---------------------------------------------------------- 头部 */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-white/8 px-3 py-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[12px] font-semibold text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
        >
          {meta.avatar}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[13.5px] font-semibold text-slate-100">{meta.label}</h2>
            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-[1px] text-[10px] text-slate-400">
              {routeInfo?.route ?? 'mock'}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
            <StatusDot tone={statusChip.tone} color={meta.color} />
            <span className="text-slate-400">{statusChip.text}</span>
            {lastReply?.status === 'done' ? (
              <span className="text-slate-600">
                · 首字 {formatMs(lastReply.firstTokenMs)} / 耗时 {formatMs(lastReply.latencyMs)}
                {lastReply.tokenEstimate ? ` / ≈${lastReply.tokenEstimate} token` : ''}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <PaneButton
            title="停止本窗正在进行的生成"
            disabled={!running}
            onClick={() => running?.reply && void stopReply(running.reply.id)}
          >
            停止
          </PaneButton>
          <PaneButton
            title="清空本窗在当前会话里的全部回复"
            disabled={turns.every((t) => !t.reply)}
            onClick={() => {
              if (window.confirm(`清空 ${meta.label} 在本会话里的全部回复？`)) void clearProvider(provider);
            }}
          >
            清空
          </PaneButton>
          <PaneButton
            title="让该 AI 忘掉上下文，开一个全新对话"
            disabled={!enabled}
            onClick={() => void newProviderSession(provider)}
          >
            新会话
          </PaneButton>
        </div>
      </header>

      {/* ---------------------------------------------------------- 消息区 */}
      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <EmptyState provider={provider} enabled={enabled} />
        ) : (
          turns.map(({ message, reply }) => (
            <div key={message.id} className="space-y-2">
              <UserBubble message={message} />
              <AssistantBubble provider={provider} reply={reply} onRetry={(id) => void retryReply(id)} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PaneButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick(): void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded-[8px] border border-white/10 bg-white/5 px-2 py-1 text-[11.5px] text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-white/5"
    >
      {children}
    </button>
  );
}

function StatusDot({ tone, color }: { tone: 'idle' | 'busy' | 'error' | 'muted'; color: string }) {
  if (tone === 'busy') return <span className="pulse h-1.5 w-1.5 rounded-full" style={{ background: color }} />;
  if (tone === 'error') return <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />;
  if (tone === 'muted') return <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />;
}

function EmptyState({ provider, enabled }: { provider: Provider; enabled: boolean }) {
  const meta = PROVIDER_META[provider];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div
        className="flex h-10 w-10 items-center justify-center rounded-[12px] text-[14px] font-semibold text-white opacity-80"
        style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
      >
        {meta.avatar}
      </div>
      <p className="text-[12.5px] text-slate-400">{meta.blurb}</p>
      <p className="text-[11.5px] text-slate-600">
        {enabled ? '在上面输入框里发一条消息试试' : '该 AI 已被取消勾选，不会收到新消息'}
      </p>
    </div>
  );
}
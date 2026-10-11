/** 气泡组件：用户消息（右侧）与 AI 回复（左侧，含流式光标 / 指标 / 错误重试） */
import type { Message, Provider, Reply } from '@maw/shared';
import { ERROR_KIND_LABEL, PROVIDER_META, REPLY_STATUS_LABEL, formatMs } from '@maw/shared';

export function UserBubble({ message }: { message: Message }) {
  const images = message.images ?? [];
  return (
    <div className="flex justify-end fade-up">
      <div className="max-w-[92%] rounded-card rounded-br-[4px] bg-white/[0.09] border border-white/10 px-3 py-2">
        {message.content ? (
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-slate-100">
            {message.content}
          </p>
        ) : null}
        {images.length > 0 ? (
          <div className={`mt-2 grid gap-1.5 ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {images.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                <img
                  src={url}
                  alt="附件"
                  loading="lazy"
                  className="max-h-40 w-full rounded-[8px] border border-white/10 object-cover"
                />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface AssistantBubbleProps {
  provider: Provider;
  reply?: Reply;
  onRetry(replyId: string): void;
}

export function AssistantBubble({ provider, reply, onRetry }: AssistantBubbleProps) {
  const meta = PROVIDER_META[provider];

  // 该条消息没发给这个 AI（发送时未勾选）
  if (!reply) {
    return (
      <div className="pl-1 text-[11.5px] text-slate-500">本条未发送给 {meta.label}（发送时未勾选）</div>
    );
  }

  const streaming = reply.status === 'streaming' || reply.status === 'pending';

  return (
    <div className="fade-up">
      <div
        className="rounded-card rounded-bl-[4px] border px-3 py-2"
        style={{
          borderColor: `color-mix(in srgb, ${meta.color} 30%, transparent)`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${meta.color} 9%, transparent), rgba(255,255,255,0.02))`,
        }}
      >
        {streaming && !reply.content ? (
          <ThinkingDots color={meta.color} />
        ) : (
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-slate-100">
            {reply.content}
            {streaming ? <span className="caret" style={{ ['--brand' as string]: meta.color }} /> : null}
          </p>
        )}

        {reply.status === 'error' ? (
          <div className="mt-2 rounded-[8px] border border-rose-400/30 bg-rose-500/10 px-2.5 py-2">
            <p className="text-[12px] font-medium text-rose-200">
              {reply.errorKind ? ERROR_KIND_LABEL[reply.errorKind] : '生成失败'}
            </p>
            <p className="mt-0.5 break-words text-[12px] leading-relaxed text-rose-100/80">{reply.error}</p>
            <div className="mt-2 flex items-center gap-2">
              {reply.retryable ? (
                <button
                  type="button"
                  onClick={() => onRetry(reply.id)}
                  className="rounded-[8px] border border-rose-300/40 bg-rose-400/15 px-2.5 py-1 text-[12px] text-rose-100 transition hover:bg-rose-400/25"
                >
                  ↻ 重试
                </button>
              ) : (
                <span className="text-[11.5px] text-rose-100/70">
                  该错误需要人工处理（例如登录失效 / 验证码），自动重试无用
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <ReplyFooter reply={reply} />
    </div>
  );
}

function ReplyFooter({ reply }: { reply: Reply }) {
  const items: string[] = [];

  if (reply.status === 'done') {
    items.push(`首字 ${formatMs(reply.firstTokenMs)}`);
    items.push(`耗时 ${formatMs(reply.latencyMs)}`);
    if (reply.tokenEstimate) items.push(`≈${reply.tokenEstimate} token`);
    items.push(`${reply.route} 通道`);
    if (reply.stopped) items.push('已停止');
  } else if (reply.status === 'error') {
    items.push(REPLY_STATUS_LABEL.error);
    if (reply.latencyMs) items.push(`耗时 ${formatMs(reply.latencyMs)}`);
  } else {
    items.push(REPLY_STATUS_LABEL[reply.status]);
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 text-[11px] text-slate-500">
      {items.map((item, i) => (
        <span key={item} className="flex items-center gap-2">
          {i > 0 ? <span className="text-slate-700">·</span> : null}
          <span className={item === '已停止' ? 'text-amber-300/80' : undefined}>{item}</span>
        </span>
      ))}
    </div>
  );
}

/** 思考中：三个跳动的点 */
function ThinkingDots({ color }: { color: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="flex items-end gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="pulse block h-1.5 w-1.5 rounded-full"
            style={{ background: color, animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
      <span className="text-[12px] text-slate-400">思考中…</span>
    </div>
  );
}
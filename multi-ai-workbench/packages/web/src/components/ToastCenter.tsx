/** 全局提示与"需要人工介入"引导条 */
import { useAppStore } from '../store/appStore';
import { PROVIDER_META, providerLabel } from '@maw/shared';

export function ToastCenter() {
  const notices = useAppStore((s) => s.notices);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  const authPrompts = useAppStore((s) => s.authPrompts);
  const dismissAuthPrompt = useAppStore((s) => s.dismissAuthPrompt);

  const tone = {
    info: 'border-sky-400/30 bg-sky-500/15 text-sky-100',
    warn: 'border-amber-400/30 bg-amber-500/15 text-amber-100',
    error: 'border-rose-400/30 bg-rose-500/15 text-rose-100',
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2">
      {/* 降级阶梯 L1：需要人工介入（登录失效 / 验证码） */}
      {authPrompts.map((prompt) => (
        <div
          key={prompt.provider}
          className="glass-strong card pointer-events-auto border-amber-400/40 p-3 text-[12.5px] text-amber-100 shadow-2xl"
        >
          <div className="flex items-start gap-2">
            <span
              className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: PROVIDER_META[prompt.provider].color }}
            />
            <div className="flex-1">
              <p className="font-medium">
                {providerLabel(prompt.provider)} 需要人工处理（{prompt.reason === 'login' ? '登录失效' : '人机验证'}）
              </p>
              <p className="mt-1 leading-relaxed text-amber-100/80">{prompt.hint}</p>
              <p className="mt-1 text-[11.5px] text-amber-100/60">
                Step 3 接入 Playwright 通道后，这里会提供"打开有头浏览器窗口"按钮，手动过一次即可自动恢复。
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismissAuthPrompt(prompt.provider)}
              className="shrink-0 text-amber-100/60 transition hover:text-amber-100"
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {notices.map((notice) => (
        <button
          key={notice.id}
          type="button"
          onClick={() => dismissNotice(notice.id)}
          className={`glass-strong card pointer-events-auto border p-2.5 text-left text-[12.5px] shadow-2xl ${tone[notice.kind]}`}
        >
          {notice.text}
        </button>
      ))}
    </div>
  );
}
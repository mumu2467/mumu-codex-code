/**
 * 顶部输入区：文字 + 图片混合发送。
 * 图片支持 拖拽 / 粘贴 / 点选 三种入口，统一在前端压缩后转 data URL。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Provider } from '@maw/shared';
import { PROVIDERS, PROVIDER_META } from '@maw/shared';
import { useAppStore } from '../store/appStore';
import {
  compressImage,
  formatBytes,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
  type PendingImage,
} from '../lib/image';

const MAX_IMAGES = 8;

export function Composer() {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [compressing, setCompressing] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const enabled = useAppStore((s) => s.enabled);
  const sending = useAppStore((s) => s.sending);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const notify = useAppStore((s) => s.notify);
  const createSession = useAppStore((s) => s.createSession);

  const activeProviders = PROVIDERS.filter((p) => enabled[p]);
  const canSend = (text.trim().length > 0 || images.length > 0) && activeProviders.length > 0 && !sending;

  // 自适应高度（最多 8 行左右）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, [text]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      const room = MAX_IMAGES - images.length;
      if (room <= 0) {
        notify('warn', `最多只能带 ${MAX_IMAGES} 张图片`);
        return;
      }

      setCompressing((n) => n + imageFiles.length);
      for (const file of imageFiles.slice(0, room)) {
        try {
          const compressed = await compressImage(file);
          setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, compressed]));
        } catch (err) {
          notify('error', (err as Error).message);
        } finally {
          setCompressing((n) => Math.max(0, n - 1));
        }
      }
    },
    [images.length, notify],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSend) return;
    const payloadText = text;
    const payloadImages = images.map((i) => i.dataUrl);
    // 先清空输入区，避免等待期间用户重复提交同一份内容
    setText('');
    setImages([]);
    await sendMessage(payloadText, payloadImages);
    textareaRef.current?.focus();
  }, [canSend, images, sendMessage, text]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter 发送；单独 Enter 换行
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      className={`card glass shrink-0 p-3 transition ${dragging ? 'ring-2 ring-sky-400/60' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // 只有真正离开容器时才取消高亮，避免子元素冒泡抖动
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(imageFilesFromDataTransfer(e.dataTransfer));
      }}
    >
      {/* 图片预览 */}
      {images.length > 0 || compressing > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((image) => (
            <div key={image.id} className="group relative">
              <img
                src={image.dataUrl}
                alt={image.name}
                className="h-16 w-16 rounded-[10px] border border-white/12 object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
                title="移除这张图片"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-slate-900/90 text-[11px] text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-500/80 hover:text-white"
              >
                ✕
              </button>
              <div className="mt-0.5 max-w-16 truncate text-[10px] text-slate-500" title={image.name}>
                {formatBytes(image.size)}
                {image.originalSize > image.size ? (
                  <span className="text-emerald-400/70"> ↓{Math.round((1 - image.size / image.originalSize) * 100)}%</span>
                ) : null}
              </div>
            </div>
          ))}
          {compressing > 0 ? (
            <div className="flex h-16 w-16 items-center justify-center rounded-[10px] border border-white/10 text-[10px] text-slate-400">
              <span className="shimmer h-full w-full rounded-[10px]" />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = imageFilesFromClipboard(e.nativeEvent);
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder="输入消息，同时发给「已勾选」的 AI…（Enter 换行，Ctrl/Cmd + Enter 发送，可粘贴或拖入图片）"
          className="max-h-[190px] min-h-[46px] flex-1 resize-none rounded-[10px] border border-white/10 bg-black/25 px-3 py-2.5 text-[13.5px] leading-relaxed text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50"
        />

        <button
          type="button"
          title="选择图片（也可直接拖拽或粘贴）"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-[46px] w-[46px] items-center justify-center rounded-[10px] border border-white/10 bg-white/5 text-[16px] text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          ＋
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSend}
          className="h-[46px] shrink-0 rounded-[10px] px-4 text-[13.5px] font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background:
              activeProviders.length === 0
                ? 'rgba(255,255,255,0.08)'
                : `linear-gradient(135deg, ${PROVIDER_META[activeProviders[0]!].from}, ${PROVIDER_META[activeProviders[activeProviders.length - 1]!].to})`,
          }}
        >
          {sending ? '发送中…' : `发送给 ${activeProviders.length} 个 AI`}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          将发送给：
          {activeProviders.length === 0 ? (
            <span className="text-amber-300">未勾选任何 AI</span>
          ) : (
            activeProviders.map((p) => PROVIDER_META[p].label).join(' / ')
          )}
        </span>
        <span className="text-slate-700">|</span>
        <span>图片最多 {MAX_IMAGES} 张，发送前会自动压缩</span>
        <span className="text-slate-700">|</span>
        <button type="button" onClick={() => void createSession()} className="underline decoration-dotted hover:text-slate-300">
          开始新会话
        </button>
        <span className="text-slate-700">|</span>
        <span className="text-slate-600">
          演练：消息里带 <code className="text-slate-400">#fail</code> 触发失败（重试即成功），带{' '}
          <code className="text-slate-400">#captcha</code> 触发需人工介入的错误
        </span>
      </div>
    </div>
  );
}
import { useEffect, useRef } from 'react';

/**
 * 独立的自动滚动：只有在用户本来就贴着底部时才跟着新内容滚动，
 * 用户手动往上翻历史时不会被打断（三窗滚动互不同步的关键实现）。
 */
export function useAutoScroll<T extends HTMLElement>(deps: unknown[], threshold = 64) {
  const ref = useRef<T>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [threshold]);

  useEffect(() => {
    const el = ref.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
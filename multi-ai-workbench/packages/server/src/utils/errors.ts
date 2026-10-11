/** 跨 adapter 复用的错误类型与工具 */
import type { ErrorKind } from '@maw/shared';

/** adapter 主动抛出的可分类错误：kind 决定前端给什么降级提示 */
export class AdapterError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;

  constructor(message: string, kind: ErrorKind = 'unknown', retryable = true) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** 用户主动停止（Esc / 点停止按钮）时抛出的错误 */
export class AbortedError extends Error {
  constructor(message = '已中止生成') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AbortedError || (err instanceof Error && err.name === 'AbortError');
}

/** 可被 AbortSignal 打断的 sleep —— 所有"模拟/等待平台响应"的地方都用它 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 把任意异常归类成 (kind, retryable, message) */
export function classifyError(err: unknown): { kind: ErrorKind; retryable: boolean; message: string } {
  if (err instanceof AdapterError) {
    return { kind: err.kind, retryable: err.retryable, message: err.message };
  }
  if (err instanceof Error) {
    return { kind: 'unknown', retryable: true, message: err.message };
  }
  return { kind: 'unknown', retryable: true, message: String(err) };
}

/** 随机整数 [min, max] */
export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
/** 极简结构化日志：带时间戳、级别、模块作用域，可直接 grep */
import { config } from '../config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

const threshold = ORDER[config.logLevel] ?? 20;

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function render(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${extra.message}`;
  if (typeof extra === 'string') return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, extra?: unknown) => {
    if ((ORDER[level] ?? 20) < threshold) return;
    const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${render(extra)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: (inner) => createLogger(`${scope}:${inner}`),
  };
}
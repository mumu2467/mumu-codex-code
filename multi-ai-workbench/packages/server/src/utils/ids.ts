import { randomUUID } from 'node:crypto';

/** 短 id：前缀 + 时间戳(36 进制) + 随机后缀，便于日志里一眼看出类型 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 需要全局唯一（跨重启也不撞）时使用 */
export function uuid(): string {
  return randomUUID();
}
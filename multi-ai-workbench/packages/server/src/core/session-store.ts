/**
 * SQLite 持久化层（使用 Node 24 内置的 node:sqlite，无需任何原生编译）。
 * 只对外暴露领域对象，不让 SQL 细节泄漏到上层。
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  AdapterRoute,
  ErrorKind,
  Message,
  Provider,
  Reply,
  ReplyStatus,
  Session,
  VoteValue,
} from '@maw/shared';
import { titleFromText } from '@maw/shared';
import { config } from '../config.js';
import { newId } from '../utils/ids.js';

/** 建表语句：幂等，每次启动都执行 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  images      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS replies (
  id               TEXT PRIMARY KEY,
  user_message_id  TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL,
  latency_ms       INTEGER,
  first_token_ms   INTEGER,
  token_estimate   INTEGER,
  error            TEXT,
  error_kind       TEXT,
  retryable        INTEGER,
  route            TEXT NOT NULL DEFAULT 'mock',
  vote             TEXT,
  stopped          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_session ON replies(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_user_msg ON replies(user_message_id);
`;

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const bool = (v: unknown): boolean => Number(v ?? 0) !== 0;

export interface CreateMessageInput {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface CreateReplyInput {
  userMessageId: string;
  sessionId: string;
  provider: Provider;
  route: AdapterRoute;
}

export interface ReplyPatch {
  status?: ReplyStatus;
  content?: string;
  latencyMs?: number;
  firstTokenMs?: number;
  tokenEstimate?: number;
  error?: string | null;
  errorKind?: ErrorKind | null;
  retryable?: boolean;
  route?: AdapterRoute;
  vote?: VoteValue;
  stopped?: boolean;
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = config.dbPath) {
    this.db = new DatabaseSync(dbPath);
    // WAL 模式：读写并发更友好，本地单进程场景也更抗崩溃
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- sessions

  listSessions(query?: string): Session[] {
    const q = query?.trim();
    const rows = q
      ? this.db
          .prepare(
            'SELECT * FROM sessions WHERE title LIKE ? ORDER BY pinned DESC, updated_at DESC LIMIT 200',
          )
          .all(`%${q}%`)
      : this.db.prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC LIMIT 200').all();
    return (rows as Row[]).map(rowToSession);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToSession(row) : undefined;
  }

  createSession(title?: string, id?: string): Session {
    const now = Date.now();
    const session: Session = {
      id: id ?? newId('ses'),
      title: title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
    this.db
      .prepare('INSERT INTO sessions (id, title, created_at, updated_at, pinned) VALUES (?, ?, ?, ?, 0)')
      .run(session.id, session.title, session.createdAt, session.updatedAt);
    return session;
  }

  /** 会话不存在则创建；存在则按需用首条消息补标题（"新会话" 才补） */
  ensureSession(sessionId: string | undefined, firstText: string): Session {
    if (sessionId) {
      const existing = this.getSession(sessionId);
      if (existing) {
        const patch: { title?: string } = {};
        if ((existing.title === '新会话' || !existing.title) && firstText.trim()) {
          patch.title = titleFromText(firstText);
        }
        return this.updateSession(existing.id, patch) ?? existing;
      }
      // 传了 id 但库里没有：按该 id 建，保证前端切换时不丢引用
      return this.createSession(firstText ? titleFromText(firstText) : undefined, sessionId);
    }
    return this.createSession(firstText ? titleFromText(firstText) : undefined);
  }

  updateSession(id: string, patch: { title?: string; pinned?: boolean }): Session | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const next: Session = {
      ...current,
      title: patch.title?.trim() || current.title,
      pinned: patch.pinned ?? current.pinned,
      updatedAt: Date.now(),
    };
    this.db
      .prepare('UPDATE sessions SET title = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.pinned ? 1 : 0, next.updatedAt, id);
    return next;
  }

  /** 有新消息时刷新 updatedAt（列表按活跃度排序） */
  touchSession(id: string): Session | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const updatedAt = Date.now();
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    return { ...current, updatedAt };
  }

  deleteSession(id: string): boolean {
    const info = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM replies WHERE session_id = ?').run(id);
    return Number(info.changes) > 0;
  }

  // ---------------------------------------------------------------- messages

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId);
    return (rows as Row[]).map(rowToMessage);
  }

  addMessage(input: CreateMessageInput): Message {
    const message: Message = {
      id: newId(input.role === 'user' ? 'msg' : 'amsg'),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: Date.now(),
    };
    if (input.images && input.images.length > 0) message.images = input.images;
    this.db
      .prepare('INSERT INTO messages (id, session_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.images ? JSON.stringify(message.images) : null,
        message.createdAt,
      );
    return message;
  }

  getMessage(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  // ----------------------------------------------------------------- replies

  listReplies(sessionId: string): Reply[] {
    const rows = this.db
      .prepare('SELECT * FROM replies WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId);
    return (rows as Row[]).map(rowToReply);
  }

  listRepliesByUserMessage(userMessageId: string): Reply[] {
    const rows = this.db
      .prepare('SELECT * FROM replies WHERE user_message_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(userMessageId);
    return (rows as Row[]).map(rowToReply);
  }

  getReply(id: string): Reply | undefined {
    const row = this.db.prepare('SELECT * FROM replies WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToReply(row) : undefined;
  }

  createReply(input: CreateReplyInput): Reply {
    const reply: Reply = {
      id: newId('rep'),
      userMessageId: input.userMessageId,
      sessionId: input.sessionId,
      provider: input.provider,
      content: '',
      status: 'pending',
      route: input.route,
      vote: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO replies (id, user_message_id, session_id, provider, content, status, route, created_at) VALUES (?, ?, ?, ?, \'\', \'pending\', ?, ?)',
      )
      .run(reply.id, reply.userMessageId, reply.sessionId, reply.provider, reply.route, reply.createdAt);
    return reply;
  }

  updateReply(id: string, patch: ReplyPatch): Reply | undefined {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    const push = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) push('status', patch.status);
    if (patch.content !== undefined) push('content', patch.content);
    if (patch.latencyMs !== undefined) push('latency_ms', Math.round(patch.latencyMs));
    if (patch.firstTokenMs !== undefined) push('first_token_ms', Math.round(patch.firstTokenMs));
    if (patch.tokenEstimate !== undefined) push('token_estimate', Math.round(patch.tokenEstimate));
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.errorKind !== undefined) push('error_kind', patch.errorKind);
    if (patch.retryable !== undefined) push('retryable', patch.retryable ? 1 : 0);
    if (patch.route !== undefined) push('route', patch.route);
    if (patch.vote !== undefined) push('vote', patch.vote);
    if (patch.stopped !== undefined) push('stopped', patch.stopped ? 1 : 0);

    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE replies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.getReply(id);
  }

  /**
   * 重试前把这条回复重置回 pending：内容、指标、错误全部清空，
   * 避免上一次的残留在前端看起来像"没重试成功"。
   */
  resetReply(id: string): Reply | undefined {
    this.db
      .prepare(
        `UPDATE replies
            SET status = 'pending', content = '', latency_ms = NULL, first_token_ms = NULL,
                token_estimate = NULL, error = NULL, error_kind = NULL, retryable = NULL, stopped = 0
          WHERE id = ?`,
      )
      .run(id);
    return this.getReply(id);
  }

  /** 清空某会话里某个 provider 的全部回复（三窗页"清空本窗"） */
  deleteRepliesByProvider(sessionId: string, provider: Provider): number {
    const info = this.db
      .prepare('DELETE FROM replies WHERE session_id = ? AND provider = ?')
      .run(sessionId, provider);
    return Number(info.changes);
  }

  /**
   * 启动时调用：把上次进程退出时仍处于 pending/streaming 的回复标记为失败，
   * 否则前端会永远显示"生成中"。
   */
  markStaleReplies(): number {
    const info = this.db
      .prepare(
        `UPDATE replies
            SET status = 'error',
                error = '服务重启导致生成中断，可点击重试',
                error_kind = 'unknown',
                retryable = 1
          WHERE status IN ('pending', 'streaming')`,
      )
      .run();
    return Number(info.changes);
  }
}

// ------------------------------------------------------------------ 行映射

function rowToSession(row: Row): Session {
  return {
    id: str(row.id),
    title: str(row.title),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    pinned: bool(row.pinned),
  };
}

function rowToMessage(row: Row): Message {
  const message: Message = {
    id: str(row.id),
    sessionId: str(row.session_id),
    role: str(row.role) === 'assistant' ? 'assistant' : 'user',
    content: str(row.content),
    createdAt: num(row.created_at),
  };
  const rawImages = optStr(row.images);
  if (rawImages) {
    try {
      const parsed = JSON.parse(rawImages);
      if (Array.isArray(parsed) && parsed.length > 0) message.images = parsed.map(String);
    } catch {
      /* 脏数据忽略即可 */
    }
  }
  return message;
}

function rowToReply(row: Row): Reply {
  const reply: Reply = {
    id: str(row.id),
    userMessageId: str(row.user_message_id),
    sessionId: str(row.session_id),
    provider: str(row.provider) as Provider,
    content: str(row.content),
    status: str(row.status) as ReplyStatus,
    route: (str(row.route) || 'mock') as AdapterRoute,
    vote: (optStr(row.vote) as VoteValue) ?? null,
    createdAt: num(row.created_at),
  };
  const latency = optNum(row.latency_ms);
  if (latency !== undefined && !Number.isNaN(latency)) reply.latencyMs = latency;
  const firstToken = optNum(row.first_token_ms);
  if (firstToken !== undefined && !Number.isNaN(firstToken)) reply.firstTokenMs = firstToken;
  const tokens = optNum(row.token_estimate);
  if (tokens !== undefined && !Number.isNaN(tokens)) reply.tokenEstimate = tokens;
  const error = optStr(row.error);
  if (error) reply.error = error;
  const errorKind = optStr(row.error_kind);
  if (errorKind) reply.errorKind = errorKind as ErrorKind;
  if (row.retryable !== null && row.retryable !== undefined) reply.retryable = bool(row.retryable);
  if (bool(row.stopped)) reply.stopped = true;
  return reply;
}
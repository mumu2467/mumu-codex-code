/**
 * 领域模型：前后端共用。
 * 这里只放"纯类型 + 常量 + 纯函数"，不放任何依赖浏览器或 Node 的实现。
 */

/** 三家 AI 平台标识 */
export type Provider = 'deepseek' | 'doubao' | 'kimi';

export const PROVIDERS = ['deepseek', 'doubao', 'kimi'] as const;

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** 合法化一个 provider 数组（去重 + 过滤非法值，保持稳定顺序） */
export function normalizeProviders(input: unknown): Provider[] {
  const list = Array.isArray(input) ? input : [];
  const picked = PROVIDERS.filter((p) => list.includes(p));
  return picked.length > 0 ? [...picked] : [...PROVIDERS];
}

/** 前端展示用的品牌元信息（Task 要求：DeepSeek 蓝紫 / 豆包 蓝绿 / Kimi 深灰紫） */
export interface ProviderMeta {
  label: string;
  /** 头像里的字符 */
  avatar: string;
  /** 品牌主色，用于边框、圆点、按钮 */
  color: string;
  /** 头像/渐变起点 */
  from: string;
  /** 渐变终点 */
  to: string;
  /** 一句话说明，用于空态文案 */
  blurb: string;
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  deepseek: {
    label: 'DeepSeek',
    avatar: 'DS',
    color: '#5B7CFA',
    from: '#4F6BFF',
    to: '#8B5CF6',
    blurb: '擅长推理与代码，回答结构清晰',
  },
  doubao: {
    label: '豆包',
    avatar: '豆',
    color: '#14B8C4',
    from: '#12B5C9',
    to: '#22C55E',
    blurb: '响应快，口语化，适合日常问答',
  },
  kimi: {
    label: 'Kimi',
    avatar: 'K',
    color: '#8B7BD8',
    from: '#6B6486',
    to: '#A78BFA',
    blurb: '长文本理解强，适合读文档',
  },
};

export function providerLabel(provider: Provider): string {
  return PROVIDER_META[provider]?.label ?? provider;
}

/** 回复的生命周期状态 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'error';

/** 错误分类：决定 UI 上给什么处置建议（对应降级阶梯 L1-L4） */
export type ErrorKind = 'auth' | 'captcha' | 'selector' | 'network' | 'unknown';

/** 实际执行通道：mock（本地假数据）/ playwright（真实网页版）/ api（官方 API） */
export type AdapterRoute = 'mock' | 'playwright' | 'api';

export type VoteValue = 'up' | 'best' | null;

/** 会话：页面 2 左侧历史列表的数据单位 */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

/** 一条消息（用户或助手；助手侧的具体内容在 Reply 里按 provider 拆分） */
export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** 图片 URL（形如 /uploads/2026-10-12/xxx.png）或 base64 data URL */
  images?: string[];
  createdAt: number;
}

/**
 * 针对某条用户消息、由某个 provider 产出的一条回复。
 * 相对任务书原定义，这里补充了几个字段（均为实现所需，注释说明用途）：
 *  - sessionId   ：便于前端按会话过滤/重连对账
 *  - firstTokenMs：首字延迟
 *  - tokenEstimate：token 估算
 *  - errorKind   ：错误分类，用于降级提示
 *  - route       ：该条回复实际走的通道（mock/playwright/api），降级可见性
 *  - vote        ：点赞 / 采纳为最佳答案
 *  - stopped     ：是否被用户中途停止（保留半截内容）
 */
export interface Reply {
  id: string;
  userMessageId: string;
  sessionId: string;
  provider: Provider;
  content: string;
  status: ReplyStatus;
  latencyMs?: number;
  firstTokenMs?: number;
  tokenEstimate?: number;
  error?: string;
  errorKind?: ErrorKind;
  retryable?: boolean;
  route: AdapterRoute;
  vote: VoteValue;
  stopped?: boolean;
  createdAt: number;
}

/**
 * POST /api/send 的响应体。
 * 带上创建好的用户消息，前端就不必再拉一次全量会话——否则"重拉"可能覆盖
 * 已经在 WebSocket 上流过来的增量内容。
 */
export interface SendResponse {
  messageId: string;
  message: Message;
  replies: Reply[];
}

/** 一次会话的完整数据（重连对账、导出都用它） */
export interface SessionBundle {
  session: Session;
  messages: Message[];
  replies: Reply[];
}

/** GET /api/providers 的响应体 */
export interface ProviderStatus {
  provider: Provider;
  label: string;
  route: AdapterRoute;
  ok: boolean;
  reason?: string;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  uptimeMs: number;
  providers: Record<Provider, { route: AdapterRoute; ok: boolean; reason?: string }>;
}

/** UI 侧：三窗页里"一列"的数据聚合 */
export interface PaneModel {
  provider: Provider;
  /** 是否被顶部开关勾选（未勾选则不接收新消息） */
  enabled: boolean;
}

export const REPLY_STATUS_LABEL: Record<ReplyStatus, string> = {
  pending: '排队中',
  streaming: '生成中',
  done: '已完成',
  error: '失败',
};

export const ERROR_KIND_LABEL: Record<ErrorKind, string> = {
  auth: '登录态失效',
  captcha: '需要人工验证',
  selector: '页面结构变化',
  network: '网络/限流',
  unknown: '未知错误',
};
// ---------------------------------------------------------------- 登录（Playwright 通道）

/** 登录流程的阶段 */
export type LoginPhase =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'saving'
  | 'detected'
  | 'done'
  | 'timeout'
  | 'error'
  | 'cancelled';

export const LOGIN_PHASE_LABEL: Record<LoginPhase, string> = {
  idle: '未开始',
  opening: '正在打开窗口',
  waiting: '等待登录',
  saving: '保存登录态',
  detected: '疑似已登录',
  done: '已登录',
  timeout: '等待超时',
  error: '失败',
  cancelled: '已取消',
};

/** 某一家当前这一轮登录的进度 */
export interface LoginState {
  provider: Provider;
  label: string;
  phase: LoginPhase;
  /** 当前窗口地址 */
  url?: string;
  /** 面向用户的中文提示 */
  message: string;
  /** 从本轮开始等待至今的毫秒数 */
  elapsedMs: number;
  updatedAt: number;
}

/** 某一家浏览器 profile 的落盘情况 */
export interface BrowserProfileStatus {
  provider: Provider;
  label: string;
  url: string;
  /** 本地是否已有 profile（说明至少打开过一次） */
  hasProfile: boolean;
  /** 是否已导出 storageState 备份 */
  hasStateFile: boolean;
  /** 此刻是否有窗口开着 */
  windowOpen: boolean;
}

/** GET /api/login/status 的响应体 */
export interface LoginStatusResponse {
  ok: boolean;
  /** 是否无头模式（无头模式下无法弹窗扫码） */
  headless: boolean;
  profileRoot: string;
  stateDir: string;
  providers: LoginState[];
  profiles: BrowserProfileStatus[];
}
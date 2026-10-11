/**
 * 环境变量集中解析（zod 校验），启动即失败，避免跑到一半才发现配置错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const srcDir = path.dirname(fileURLToPath(import.meta.url)); // packages/server/src
export const serverRoot = path.resolve(srcDir, '..'); // packages/server
export const projectRoot = path.resolve(serverRoot, '..', '..'); // multi-ai-workbench

// 支持项目根目录下的 .env（Node 内置，不引入 dotenv 依赖）
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[config] .env 解析失败，已忽略：${(err as Error).message}`);
  }
}

const routeEnum = z.enum(['mock', 'playwright', 'api']);

/**
 * 只认 "1"/"true" 为真。
 * 注意不能直接用 z.coerce.boolean()：它底层是 Boolean(value)，字符串 "false" 会被判成 true。
 */
const boolString = z
  .enum(['1', '0', 'true', 'false', 'TRUE', 'FALSE', 'True', 'False'])
  .default('false')
  .transform((value) => value === '1' || value.toLowerCase() === 'true');

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65535).default(8787),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  STORAGE_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
  MOCK_SPEED: z.coerce.number().positive().default(1),
  ADAPTER_DEEPSEEK: routeEnum.default('mock'),
  ADAPTER_DOUBAO: routeEnum.default('mock'),
  ADAPTER_KIMI: routeEnum.default('mock'),

  // ---------- Playwright 浏览器通道 ----------
  /** 是否无头运行。默认 false：打开真实窗口，扫码登录 / 人工过验证码都靠它 */
  BROWSER_HEADLESS: boolString,
  /** 浏览器内核：留空用 Playwright 自带 Chromium；也可填 "chrome"（复用本机已装 Chrome，更接近真人环境） */
  BROWSER_CHANNEL: z.string().optional(),
  /** 每个动作后额外等待的毫秒数，调试选择器时有用 */
  BROWSER_SLOWMO: z.coerce.number().int().min(0).default(0),
  /** 等待人工完成登录的超时（毫秒） */
  LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] 环境变量校验失败：');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const env = parsed.data;

const storageDir = path.resolve(env.STORAGE_DIR?.trim() ? env.STORAGE_DIR.trim() : path.join(projectRoot, 'storage'));

export const config = {
  name: 'multi-ai-workbench',
  version: '0.1.0',
  host: env.HOST,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  projectRoot,
  storageDir,
  /** 用户上传图片落盘目录 */
  uploadDir: path.join(storageDir, 'uploads'),
  /** SQLite 文件 */
  dbPath: path.join(storageDir, 'app.db'),
  /** 单张图片大小上限 */
  maxUploadBytes: Math.floor(env.MAX_UPLOAD_MB * 1024 * 1024),
  /** mock 通道语速倍率 */
  mockSpeed: env.MOCK_SPEED,
  /** 各 provider 的执行通道（可用 /api/providers/route 运行时热切换） */
  routes: {
    deepseek: env.ADAPTER_DEEPSEEK,
    doubao: env.ADAPTER_DOUBAO,
    kimi: env.ADAPTER_KIMI,
  },
  /** Playwright 浏览器通道 */
  browser: {
    headless: env.BROWSER_HEADLESS,
    channel: env.BROWSER_CHANNEL?.trim() ? env.BROWSER_CHANNEL.trim() : undefined,
    slowMo: env.BROWSER_SLOWMO,
    /** 每个 provider 一个持久化 user-data-dir（Chromium 自己管 cookie / IndexedDB） */
    profileRoot: path.join(storageDir, '.browser-profile'),
    /** storageState 导出目录（备份 / 迁移到 Docker 卷用） */
    stateDir: path.join(storageDir, 'browser'),
  },
  /** 等待人工登录的超时 */
  loginTimeoutMs: env.LOGIN_TIMEOUT_MS,
} as const;

export type AppConfig = typeof config;

fs.mkdirSync(config.uploadDir, { recursive: true });
// storageState 备份目录先建好；profileRoot 交给 Chromium 自己按需创建
fs.mkdirSync(config.browser.stateDir, { recursive: true });
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
} as const;

export type AppConfig = typeof config;

fs.mkdirSync(config.uploadDir, { recursive: true });
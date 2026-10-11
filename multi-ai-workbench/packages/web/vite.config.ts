import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（multi-ai-workbench/），.env 就放在这里 */
const projectRoot = path.resolve(here, '..', '..');

export default defineConfig(({ mode }) => {
  // 同时读 .env 与 shell 环境变量：这样只要在 .env 里写一句 PORT=8877，
  // 后端起 8877、Vite 也自动反代到 8877，不用改两处。
  const env: Record<string, string | undefined> = {
    ...loadEnv(mode, projectRoot, ''),
    ...process.env,
  };
  const serverPort = env.MAW_SERVER_PORT?.trim() || env.PORT?.trim() || '8787';
  const webPort = Number(env.MAW_WEB_PORT?.trim() || 5173);
  const apiTarget = `http://127.0.0.1:${serverPort}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // 共享包直接引用 TS 源码，免去构建步骤（前后端类型天然一致）
        '@maw/shared': path.resolve(here, '../shared/src/index.ts'),
      },
    },
    server: {
      port: webPort,
      strictPort: false,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/uploads': { target: apiTarget, changeOrigin: true },
        '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
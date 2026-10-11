# multi-ai-workbench · 多 AI 聚合工作台

把一条消息（**文字 + 图片**）一次性**同时**投递给 DeepSeek / 豆包 / Kimi，并提供两种查看方式：

- **页面 1 · 三窗并发**（Step 1-2 已交付）：三列等宽聊天窗，各自独立流式输出、独立滚动、独立停止 / 清空 / 新会话。
- **页面 2 · 聚合对话**（Step 5）：单列 IM 风格，三家回复聚合在左侧同一区域，可分段切换、可并排对比、可投票采纳、可导出。

---

## 一、方案选型结论（先说清楚为什么不能 iframe）

三家 C 端网页版都有 `X-Frame-Options` / CSP 限制，**无法直接 iframe 嵌入**；而且即使想办法绕过响应头，浏览器**同源策略**也决定了父页面只能"显示"iframe 的像素，**读不到里面的 DOM 文本**——所以"前端 iframe + 读内容"这条路在技术上根本不成立。

因此本项目选定：

> **路线 C（= 路线 A 为主 + 路线 B 兜底）**
> 默认用 **Playwright 驱动三个真实浏览器上下文**跑网页版（路线 A）；把三家**官方 API** 封装成同一套接口作为兜底（路线 B）。
> 两者实现同一个 `ChatAdapter` 契约，可在运行时按 provider 热切换，前端无感知。

| 维度 | 路线 A（Playwright 真机） | 路线 B（官方 API） |
|---|---|---|
| 体验 | 就是 C 端窗口，能力/上下文与你在浏览器里用的一致 | 自研 UI |
| 稳定性 | 受登录风控 / 验证码 / 页面改版影响 | 高，有 SLA |
| 多模态 | 取决于页面是否支持上传 | 部分模型支持 |
| 成本 | 免费（用你自己的账号） | 按 token 计费 |
| 落地阶段 | Step 3-4 | Step 7 |

完整论证、数据流图、接口契约、降级阶梯见 **`docs/01-方案选型与架构设计.md`**。

---

## 二、当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 设计 | 方案选型 / 架构 / 数据流 / 接口契约 | ✅ `docs/01-方案选型与架构设计.md` |
| **Step 1** | monorepo 脚手架 + 后端编排 + SQLite + WebSocket + `ChatAdapter` + Mock 全链路 | ✅ 已交付 |
| **Step 2** | 前端三窗并发页（响应式、图片混合发送、独立控制、指标） | ✅ 已交付 |
| Step 3 | Playwright 基础层 + 登录态持久化 + DeepSeek 真机通道 | ⏳ 下一步 |
| Step 4 | 豆包 / Kimi 真机通道 | ⏳ |
| Step 5 | 聚合对话页（切换 / 并排 / 投票 / 导出 / 会话侧边栏） | ⏳ |
| Step 6 | 画面流（CDP screencast，默认关）+ 人工介入 + `docker-compose.yml` | ⏳ |
| Step 7 | 官方 API 兜底适配器 | ⏳ |

> 现在跑起来，三家走的是 **mock 通道**：不联网、不需要登录，用可复现的假数据把"并发投递 → 流式回显 → 停止 / 重试 / 错误态 → 落库 → 导出"整条链路打通，方便先验收交互。

---

## 三、快速开始

### 环境要求

- **Node.js >= 20.11**（本仓库实测 `v24.21.0`）。推荐 Node 22 / 24。
  存储用 Node 内置的 `node:sqlite`，**无需任何原生模块编译**。
- Windows / macOS / Linux 均可。Windows 下 `npm` 请用 `npm.cmd`（PowerShell 执行策略会拦截 `npm.ps1`）。

### 启动

```bash
cd multi-ai-workbench
npm install          # 根目录执行一次即可（npm workspaces 会装好三个子包）
cp .env.example .env # 可选：Windows 用 copy .env.example .env
npm run dev          # 并行启动 server(8787) + web(5173)
```

打开 <http://localhost:5173> 即可看到三窗并发页。

> `npm run dev` 默认走 **单端口代理**模式：浏览器只连 `5173`，Vite 把 `/api`、`/uploads`、`/ws` 反代到 `8787`。
> 生产形态下 server 会直接托管 `packages/web/dist`，只暴露 `8787` 一个端口。

### 可用脚本（都在 `multi-ai-workbench/` 下执行）

| 命令 | 作用 |
|---|---|
| `npm run dev` | 并行启动 server + web（输出带 `[server]` / `[web]` 前缀） |
| `npm run dev:server` | 只起后端（`tsx watch`，改代码自动重启） |
| `npm run dev:web` | 只起前端（Vite HMR） |
| `npm run build` | 构建前端到 `packages/web/dist` |
| `npm run typecheck` | 三个包统一类型检查（shared → server → web） |
| `npm run smoke` | 端到端冒烟测试：自带服务端生命周期，26 项断言 |

`npm run smoke` 是最快的验收方式，覆盖：并发投递、流式增量、图片落盘 + 静态访问、错误注入 + 一键重试、停止保留半截内容、Markdown / JSON 导出。

---

## 四、目录结构

```
multi-ai-workbench/
├─ package.json                 # npm workspaces 根：scripts 聚合入口
├─ tsconfig.base.json           # 三个包共享的 TS 编译基线
├─ .env.example                 # 环境变量模板（复制为 .env）
├─ scripts/
│  ├─ dev.mjs                   # 并行拉起 server + web（原生 child_process，无额外依赖）
│  └─ smoke.mjs                 # 端到端冒烟测试（自带服务端生命周期）
├─ docs/01-方案选型与架构设计.md  # 选型结论 / 架构 / 数据流 / 降级阶梯
├─ storage/                     # 运行时产物（git 忽略）：app.db、uploads/
└─ packages/
   ├─ shared/                   # 前后端共享的领域类型 + WS 事件协议（单一事实来源）
   │  └─ src/{types,events,text,index}.ts
   ├─ server/                   # Fastify + @fastify/websocket + node:sqlite
   │  └─ src/
   │     ├─ config.ts           # 环境变量集中解析（zod 校验，错就启动失败）
   │     ├─ index.ts            # 组装：存储 → 适配器注册表 → 编排器 → 路由 / WS
   │     ├─ core/
   │     │  ├─ orchestrator.ts  # 并发投递、流式聚合、停止/重试、指标统计
   │     │  ├─ session-store.ts # SQLite 持久化（会话 / 消息 / 回复）
   │     │  ├─ image-store.ts   # 图片落盘（base64 → storage/uploads/<日期>/）
   │     │  └─ event-bus.ts     # 进程内事件总线
   │     ├─ adapters/
   │     │  ├─ types.ts         # ★ ChatAdapter 契约（新接一家 AI 只需实现它）
   │     │  ├─ registry.ts      # 按 provider 解析通道 + 运行时热切换 + 会话键
   │     │  └─ mock-adapter.ts  # Mock 通道（本地假数据，支持故障注入）
   │     ├─ http/routes.ts      # REST 接口
   │     └─ ws/hub.ts           # WebSocket 连接管理 + 会话订阅 + 广播
   └─ web/                      # React 18 + Vite 6 + Tailwind v4 + zustand
      └─ src/
         ├─ App.tsx · main.tsx
         ├─ store/appStore.ts       # zustand 全局状态 + WS 事件归约
         ├─ lib/{api,ws,image}.ts   # REST 客户端 / WS 客户端 / 图片压缩
         ├─ hooks/{useAutoScroll,useMediaQuery}.ts
         ├─ components/{TopBar,Composer,ProviderPane,MessageBubble,ToastCenter}.tsx
         └─ pages/ConcurrentPage.tsx
```

---

## 五、环境变量

全部可选，`.env.example` 里有注释版模板。

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址（要局域网访问改 `0.0.0.0`） |
| `PORT` | `8787` | 后端端口 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `STORAGE_DIR` | `<项目根>/storage` | 运行时数据目录（SQLite、上传图片、浏览器登录态） |
| `MAX_UPLOAD_MB` | `20` | 单张图片上传上限 |
| `ADAPTER_DEEPSEEK` | `mock` | 该家的执行通道：`mock` / `playwright` / `api` |
| `ADAPTER_DOUBAO` | `mock` | 同上 |
| `ADAPTER_KIMI` | `mock` | 同上 |
| `MOCK_SPEED` | `1` | Mock 通道语速倍率，调大更快 |
| `DEEPSEEK_API_KEY` | 空 | 路线 B，Step 7 用 |
| `ARK_API_KEY` | 空 | 火山方舟（豆包），Step 7 用 |
| `MOONSHOT_API_KEY` | 空 | Moonshot（Kimi），Step 7 用 |

通道也可以在**运行时热切换**，不必重启：

```
POST /api/providers/route
{ "provider": "deepseek", "route": "playwright" }
```

---

## 六、接口契约

### REST

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查，含三家通道状态 |
| `GET` | `/api/providers` | 三家的 label / 通道 / 可用性 |
| `POST` | `/api/providers/route` | 热切换某家的执行通道 |
| `POST` | `/api/providers/new-session` | 让某家开一个新会话（对应窗口的"新会话"按钮） |
| `GET` | `/api/sessions?q=` | 会话列表（支持搜索） |
| `POST` | `/api/sessions` | 新建会话 |
| `GET` | `/api/sessions/:id` | 会话详情（含 messages + replies，用于重连对账） |
| `PATCH` | `/api/sessions/:id` | 重命名 / 置顶 |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `GET` | `/api/sessions/:id/messages` | 会话消息 |
| `POST` | `/api/send` | **核心**：`{ sessionId?, text, images[], providers[] }` → `{ messageId, message, replies[] }` |
| `POST` | `/api/stop` | 停止生成：`{ replyId }` 或 `{ sessionId, provider }` |
| `POST` | `/api/retry` | 重试：`{ replyId }` |
| `POST` | `/api/replies/clear` | 清空某窗口：`{ sessionId, provider }` |
| `POST` | `/api/replies/:id/vote` | 点赞 / 采纳为最佳答案 |
| `POST` | `/api/upload` | 图片上传（multipart），返回 `/uploads/...` URL |
| `GET` | `/api/export/:sessionId?format=md\|json` | 导出会话 |

`POST /api/send` 会**顺带返回已创建的用户消息**，这样前端不必再拉一次全量会话——否则"重拉"可能覆盖已经在 WebSocket 上流过来的增量内容。图片支持三种来源：前端压缩后的 base64 data URL、`/uploads/...` URL、或先走 `/api/upload` 再传 URL。

### WebSocket `/ws`

一次连接全局复用；切换会话时重新发 `subscribe` 即可（重连后也用它恢复）。

**服务端 → 客户端**

| 事件 | 说明 |
|---|---|
| `hello` | 建连握手，附三家当前通道状态 |
| `reply.status` | 状态机流转：`pending → streaming → done \| error` |
| `reply.delta` | 流式增量，`{ delta, full }`；`full` 是截至当前的**完整快照**，乱序/丢包时可自我修复 |
| `reply.done` | 完成，带 `latencyMs` / `firstTokenMs` / `tokenEstimate`；`stopped=true` 表示被中途停止 |
| `reply.error` | 失败，带 `kind`（`auth`/`captcha`/`selector`/`network`/`unknown`）与 `retryable` |
| `auth.required` | 需要人工介入（登录失效 / 验证码），前端据此弹引导 |
| `session.updated` | 会话元信息变化（标题 / 时间 / 置顶） |
| `reply.vote` | 某条回复的点赞 / 采纳变化 |
| `pong` | 心跳应答 |

**客户端 → 服务端**

| 事件 | 说明 |
|---|---|
| `subscribe` | `{ sessionId }` 订阅某会话的事件流 |
| `ping` | `{ t }` 心跳 |

---

## 七、Mock 通道演练指令

在输入框里写下面这些"暗号"，可以复现各种异常场景（仅 mock 通道有效）：

| 输入含 | 效果 |
|---|---|
| `#fail` | 抛 `selector` 类错误（模拟页面改版）。**只失败第一次**，点"重试"即成功 |
| `#captcha` | 抛 `captcha` 类错误（模拟验证码），**持续失败**，用于演练人工介入流程 |

---

## 八、数据与存储

全部落在 `storage/`（已在 `.gitignore` 中忽略，**不要提交**）：

- `storage/app.db` —— SQLite（`node:sqlite`，WAL 模式），存会话 / 消息 / 回复 / 投票。
- `storage/uploads/<YYYY-MM-DD>/img_xxx.png` —— 上传的图片；数据库里只存 `/uploads/...` 这种 URL，静态资源由后端托管。
- `storage/browser/` —— **Step 3 起**放三家网页版的 `storageState`（登录态）。

**图片处理链路**：前端 canvas 压缩（长边 ≤ 1568、webp 质量 0.82）→ base64 data URL 预览 → 随消息发给后端 → 后端落盘 → DB 只存 URL。这样既避免大图撑爆请求体，也避免把 base64 塞进数据库。

---

## 九、登录态怎么保存与刷新（Step 3）

> 这三家网页版都需要登录，且都有风控。Step 3 会交付 `scripts/login.ts`：**弹出真实浏览器窗口**，你手动完成登录（含验证码），脚本把 `storageState`（cookie + localStorage）落盘到 `storage/browser/<provider>.json`，之后所有自动请求复用这份登录态。

要点与注意事项：

- **登录态会过期**。失效时后端发 `auth.required` 事件，前端弹窗提示你重新跑一次 `scripts/login.ts`，而不是让请求静默失败。
- **可能触发验证码 / 滑块**。这类无法自动绕过，脚本会给出手动接管的入口（headed 模式 + `scripts/probe.ts` 探针），必要时降级到 Step 7 的官方 API。
- **不要提交 `storage/`**。`storageState` 里含 cookie / session token，入库等于泄露凭据。仓库根 `.gitignore` 已忽略 `**/.browser-profile/`，本项目 `.gitignore` 额外忽略 `storage/`。
- **不要高频、并发地跑自动请求**。容易被风控也容易触发限流；适配层会对同一 provider 串行化（同一时刻只跑一条），并对失败做分类与退避。

---

## 十、常见问题

| 现象 | 处理 |
|---|---|
| PowerShell 里 `npm` 报"无法加载文件 …npm.ps1" | 执行策略拦截，改用 `npm.cmd` |
| 端口被占用 | 改 `.env` 的 `PORT`；Vite 侧若 5173 被占会自动 +1（`strictPort: false`），看启动日志里的实际地址 |
| 页面能开但消息没反应 | 看浏览器控制台有没有 WebSocket 连接报错；再确认 `8787` 是否活着（`GET /api/health`） |
| 引用了内置 `node:sqlite` 但启动报错 | Node 版本太低，需 >= 20.11（推荐 22/24） |
| 想清空全部数据重来 | 停掉服务，删掉 `storage/` 目录再启动 |
| `npm install` 时提示 esbuild 等 postinstall 待批准 | 正常，`tsx` / `vite` 无需该脚本即可运行 |

---

## 十一、版本

本项目改动遵循仓库根 `AGENTS.md` 的「对话即版本」规则，每次对话提交、打 tag 并推送；版本记录见仓库根 `RELEASES.md`。
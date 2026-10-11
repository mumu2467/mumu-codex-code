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
| **Step 3a** | 浏览器池 + 三家登录态持久化（弹**真实浏览器窗口**扫码登录，已实测通） | ✅ 已交付 |
| **Step 3b** | 网页版「投递 → 收流」适配器：**把消息（含图片）真发到三家 C 端并抓流式回复** | ✅ 已交付并实测通 |
| Step 4 | 多模态与并发打磨（多图 / 长文 / 停止生成校准 / 压测） | ⏳ |
| Step 5 | 聚合对话页（切换 / 并排 / 投票 / 导出 / 会话侧边栏） | ⏳ |
| Step 6 | 画面流（CDP screencast，默认关）+ 人工介入 + `docker-compose.yml` | ⏳ |
| Step 7 | 官方 API 兜底适配器 | ⏳ |

> 默认（不写 `.env`）三家走 **mock 通道**：不联网、不需要登录，用可复现的假数据把"并发投递 → 流式回显 → 停止 / 重试 / 错误态 → 落库 → 导出"整条链路打通，方便先验收交互。
>
> 想**真的**发到 C 端？把 `.env` 里三家改成 `playwright` 即可驱动真实网页版 —— 见 §十「真实发消息（网页版通道）」。

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
| `npm run login` | **弹出三家真实浏览器窗口**，你扫码登录，登录态自动落盘 |
| `npm run login -- deepseek` | 只登录某一家（`deepseek` / `doubao` / `kimi`） |
| `npm run login -- --keep-open` | 登录完成后不关窗口 |
| `npm run probe -- deepseek --deep` | 选择器探针：把候选选择器在真实页面上的命中情况 + 结构快照打出来 |
| `npm run probe -- deepseek --send` | **真发一条消息**给某家并持续跟踪，dump 出回复区的真实 DOM（校准选择器最强手段） |
| `npm run e2e -- "你的问题"` | 端到端联调：给三家真发一条消息，实时打印 WebSocket 事件流（首字/耗时/token） |
| `npm run e2e -- --image=p.png "看图说话"` | 同上，但走「文字 + 图片」多模态那条路 |

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
│  ├─ smoke.mjs                 # 端到端冒烟测试（自带服务端生命周期）
│  ├─ login.ts                  # 命令行登录：弹三家真实窗口，扫码后落盘登录态
│  ├─ e2e-send.ts               # 端到端联调：三家（或指定家）真发一条消息，打印 WS 事件流
│  └─ probe.ts                  # 选择器探针：校准 selectors/*.json（支持 --send / --dump / --image）
├─ docs/01-方案选型与架构设计.md  # 选型结论 / 架构 / 数据流 / 降级阶梯
├─ storage/                     # 运行时产物（git 忽略）：app.db、uploads/
└─ packages/
   ├─ shared/                   # 前后端共享的领域类型 + WS 事件协议（单一事实来源）
   │  └─ src/{types,events,text,index}.ts
   ├─ server/                   # Fastify + @fastify/websocket + node:sqlite
   │  └─ src/
   │     ├─ config.ts           # 环境变量集中解析（zod 校验，错就启动失败）
   │     ├─ index.ts            # 组装：存储 → 适配器注册表 → 编排器 → 路由 / WS
   │     ├─ browser/            # ★ Playwright 基础设施
   │     │  ├─ browser-pool.ts      # 每 provider 一个持久化 BrowserContext（懒启动 + 内核自动探测）
   │     │  └─ login-service.ts     # 开窗口 → 等扫码 → 判定登录 → 导出 storageState
   │     ├─ core/
   │     │  ├─ orchestrator.ts  # 并发投递、流式聚合、停止/重试、指标统计
   │     │  ├─ session-store.ts # SQLite 持久化（会话 / 消息 / 回复）
   │     │  ├─ image-store.ts   # 图片落盘（base64 → storage/uploads/<日期>/）
   │     │  └─ event-bus.ts     # 进程内事件总线
   │     ├─ adapters/
   │     │  ├─ types.ts         # ★ ChatAdapter 契约（新接一家 AI 只需实现它）
   │     │  ├─ registry.ts      # 按 provider 解析通道 + 运行时热切换 + 会话键
   │     │  ├─ selectors/       # ★ 三家网页版的选择器（外置 JSON + zod 校验）
   │     │  │  ├─ index.ts          # 加载器（带缓存 / 可热重载）
   │     │  │  ├─ deepseek.json
   │     │  │  ├─ doubao.json
   │     │  │  └─ kimi.json
   │     │  ├─ base-web-adapter.ts   # ★ 网页版通用引擎（打开→传图→打字→发送→收流→判结束）
   │     │  ├─ deepseek-adapter.ts   # 只写参数与平台怪癖，逻辑全在基类
   │     │  ├─ doubao-adapter.ts
   │     │  ├─ kimi-adapter.ts
   │     │  ├─ web-adapters.ts       # provider → 具体适配器的工厂（加第五家只动这里）
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
| `BROWSER_HEADLESS` | `false` | 是否无头。**默认 false**：要弹真实窗口才能扫码 / 过验证码 |
| `BROWSER_CHANNEL` | 空 | 浏览器内核。留空=自动探测（Playwright 自带 Chromium → 本机 Edge / Chrome）；也可填 `chrome` / `msedge` |
| `BROWSER_SLOWMO` | `0` | 每个动作后额外等待毫秒数，调试选择器时很好用 |
| `LOGIN_TIMEOUT_MS` | `300000` | 等待人工登录的超时 |
| `MAW_SERVER_PORT` | `8787` | 仅前端用：Vite 反代到哪个后端端口（同机跑多个项目时改它） |
| `MAW_WEB_PORT` | `5173` | 仅前端用：Vite 自己监听的端口 |
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
| `GET` | `/api/login/status` | 登录进度 + 各家浏览器 profile 概览 |
| `POST` | `/api/login` | **打开真实浏览器窗口**登录：`{ providers?: [] }`，立即返回，之后轮询 status |
| `POST` | `/api/login/confirm` | 手动确认已登录并落盘：`{ provider }`（选择器不准时的兜底） |
| `POST` | `/api/login/cancel` | 停止轮询登录状态（窗口保持打开） |
| `POST` | `/api/login/export` | 导出某家 storageState 备份：`{ provider }` |

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
- `storage/.browser-profile/<provider>/` —— 三家的 **Chromium 持久化 profile**（主登录态，cookie / localStorage / IndexedDB 都在里面）。
- `storage/browser/<provider>.json` —— 三家的 `storageState` 快照（便携备份，可拷到别的机器 / Docker 卷）。
- `storage/probe/<provider>.json` —— `npm run probe -- --deep` 生成的页面结构快照，用来校准选择器。

**图片处理链路**：前端 canvas 压缩（长边 ≤ 1568、webp 质量 0.82）→ base64 data URL 预览 → 随消息发给后端 → 后端落盘 → DB 只存 URL。这样既避免大图撑爆请求体，也避免把 base64 塞进数据库。

---

## 九、登录三家网页版（扫码登录怎么做的）

### 为什么是"真实浏览器窗口"

三家 C 端都有 `X-Frame-Options` / CSP，iframe 嵌不进来；就算硬绕，同源策略也让你**读不到 iframe 里的 DOM**。所以唯一的正路是：**后端用 Playwright 开真实窗口**（你看到的就是原版页面，扫码 / 滑块 / 短信验证码全都能用），后端再复用这份登录态去投递和收流。

### 两种登录方式

**方式一：在应用里点「登录三家」（推荐）**

右上角「🔑 登录三家」→ 面板里点「打开三家的登录窗口」→ 三个真实窗口弹出 → 用 App 扫码（或手机号+验证码）→ 面板里每家的状态点会自动变绿。

**方式二：命令行**

```bash
npm run login                 # 三家一起
npm run login -- deepseek     # 只登一家
npm run login -- --keep-open  # 登完不关窗口
```

> ⚠️ 同一个 profile 同一时刻只能被一个进程占用。**服务在跑时请用方式一**；方式二适合服务没起、或者你在 Docker/服务器上单独刷登录态。

### 登录态存在哪、怎么刷新

| 位置 | 内容 | 说明 |
|---|---|---|
| `storage/.browser-profile/<provider>/` | Chromium 持久化 profile | **主存储**。cookie / localStorage / IndexedDB 全在里面，重启自动复用，不用重复扫码 |
| `storage/browser/<provider>.json` | `storageState` 快照 | 便携备份，可拷贝到别的机器 / Docker 卷 |

**登录失效了怎么办**：后端会推 `auth.required` 事件，界面弹提示，重新点一次「登录三家」即可 —— 不会静默失败。

### 判定逻辑（这里踩过坑，说明一下）

后端**不会**只看一眼选择器就宣布"登录成功"，而是要求同时满足：

1. 出现过"未登录"形态（登录页 URL，或页面上还看得到登录入口）；
2. 之后连续 3 次轮询都处于登录态（约 4.5 秒）。

如果 profile 里本来就有登录态（页面从头到尾不显示登录页），要求连续 **6** 次稳定（约 9 秒）才算数。

> 为什么要这么绕：SPA 是分批渲染的，输入框往往先出来、登录按钮后出来，中间那一两秒"看着像已登录"，实测就会误判。真拿不准时，面板里的**「我已登录」**按钮可以跳过自动检测直接落盘。

### 平台限制，以及对应的降级方案

| 限制 | 表现 | 降级方案 |
|---|---|---|
| 新设备 / 异地登录风控 | 要求短信验证码或 App 扫码 | 只能人工过；窗口就是给你干这个的 |
| 图形验证码 / 滑块 | 发送或登录时弹出 | 同上，人工过一次即可；`blocked` 选择器命中时界面会提示 |
| 页面改版导致选择器失效 | 卡在"等待登录"或抓不到回复 | `npm run probe -- <provider> --deep` 打印真实 DOM 快照，照着改 `selectors/*.json`；改完不用重启服务 |
| 高频请求触发限流 | 回复变慢 / 报错 | 同一 provider 串行化（一次只跑一条），失败按 `kind` 分类并提示；必要时切到 Step 7 的官方 API |
| 平台明确禁止自动化 | 账号可能被限制 | 这是路线 A 的固有风险。正式生产建议走**路线 B（官方 API）**，把 Playwright 通道当兜底 |

### 安全提醒

- **不要提交 `storage/`**。里面是 cookie / session token，入库等于泄露凭据。仓库根 `.gitignore` 已忽略 `**/.browser-profile/`，本项目 `.gitignore` 额外忽略整个 `storage/`。
- `.env` 同样不要入库（含 API Key）。

---

## 十、真实发消息（网页版通道 / Step 3b）

把 `.env` 里三家改成 `playwright`（或调 `POST /api/providers/route`）之后，后端就**不再走 mock**，
而是真的在三个浏览器窗口里替你打字、点发送、读回复：

```bash
# .env
ADAPTER_DEEPSEEK=playwright
ADAPTER_DOUBAO=playwright
ADAPTER_KIMI=playwright
BROWSER_HEADLESS=false      # 必须 headed：扫码 / 过验证码都靠这扇窗
```

```bash
npm run e2e -- "请用一句话解释什么是 WebSocket"          # 三家并发真发，打印事件流
npm run e2e -- --image=doc/示例.png "这张图里有什么？"    # 文字 + 图片
npm run e2e -- --providers deepseek,kimi "只发两家"
```

### 通用引擎：一条流水线伺候三家

核心在 `packages/server/src/adapters/base-web-adapter.ts`，三家共用同一条流水线：

1. 打开 / 复用该家的浏览器窗口（持久化 profile，登录态由 Chromium 自己维护，不用手动灌 cookie）
2. **工作台会话变了 → 先在平台上开一个全新对话**，两个会话的上下文不互相污染
3. 上传图片：`setInputFiles` 喂本地绝对路径（绕开系统文件选择框）→ **等缩略图真的出现**再继续
4. 输入文字：`textarea` 直接 `fill()`；`ProseMirror` / `chat-input-editor` 这类富文本只认键盘事件，用 `insertText` 一次性插入，编辑器不吃就回退逐字敲
5. 提交：优先 `Enter`；如果编辑器把回车当换行（读输入框发现还有残留），自动回退点发送按钮
6. 轮询「最后一条助手消息」的文本 → 增量 diff → `sink.delta()`
7. 结束判定：平台自己的「生成中」标志消失 **且** 文本静默满 `idleMs`；另有首字超时和整体硬超时兜底

差异部分全部外置：`selectors/<provider>.json`（选择器）+ `<provider>-adapter.ts`（只写参数和平台怪癖）。
加第五家 AI 只需要：加枚举 → 加 JSON → 加一个继承 `BaseWebAdapter` 的文件 → 在 `web-adapters.ts` 加一个 `case`。

### 三家实测到的事实（2026-10-12，真发消息验证）

| | 输入框 | 正文容器 | 「生成中」标志 | 图片 |
|---|---|---|---|---|
| DeepSeek | `textarea`（`fill` 可用，回车即发） | `div.ds-assistant-message-main-content` —— **只含正文**，「深度思考」在别的元素里 | 无（靠静默判定，给到 3.5s） | `input[type=file]` → blob 缩略图 |
| 豆包 | `div.ProseMirror`（TipTap，只认键盘事件） | `[data-testid=receive_message] [data-testid=message_text_content]` | ✅ `data-streaming="true"`，最可靠的信号 | `input[type=file]`（2 个，取第一个能用的） |
| Kimi | `div.chat-input-editor`（contenteditable） | `.chat-content-item-assistant .markdown-container:not(.toolcall-content-text)` | ✅ 发送按钮变成 `.send-button-container.stop` | `input.hidden-input` |

> ⚠️ **Kimi 的坑**：它会把「思考链」也渲染进 DOM（`div.markdown-container.toolcall-content-text`）。
> 选择器里必须 `:not()` 掉，否则你会把模型的内心独白当成正式回答。

### 实测结果（`npm run e2e`，三家并发）

```text
→ 会话 ses_mv44810h38q0h6，已投递 3 条，等待流式回复…

  +   4.6s DeepSeek  流式 48 字
  +   5.9s 豆包        流式 73 字
  +   7.3s Kimi      流式 48 字
  +   7.7s 豆包        ✅ 完成  73 字 / 首字 4706ms / 总耗时 7308ms / ~61 token
  +   8.3s DeepSeek  ✅ 完成  48 字 / 首字 4235ms / 总耗时 7880ms / ~36 token
  +   9.8s Kimi      ✅ 完成  72 字 / 首字 6919ms / 总耗时 9384ms / ~56 token
```

带图那条同样三家全通（都正确说出图里的四种颜色），首字 6.9 / 8.3 / 12.3 秒。

### 「停止生成」的边界（说清楚，不糊弄）

- **一定能停止的**：后端立刻停止读取，已产出的半截内容保留并落库（`reply.done` + `stopped=true`），前端状态立即变回可交互。
- **尽力而为的**：点平台自己的停止按钮。Kimi 有明确的 `.send-button-container.stop`；DeepSeek / 豆包当前没抓到稳定的停止按钮选择器，
  会退化成按 `Esc` 并**在日志里明说"平台可能在后台继续生成"**。
- 想补上：真发一条长文，用 `npm run probe -- <provider> --send "写一篇 1000 字长文…"` 观察生成期间出现的
  `stopCandidates` / `clickables`（探针会把它们存到 `storage/probe/<provider>-stop-candidates.json`），然后把选择器填进对应的 JSON。

### 平台限制与降级阶梯

| 情况 | 表现 | 降级方案 |
|---|---|---|
| 登录态失效 | 抛 `AdapterError('auth')`，WS 推 `auth.required` | 前端弹引导 → 点顶栏「登录三家」重新扫码（L1） |
| 人机验证 / 风控 | 抛 `AdapterError('captcha')`，同上 | 切到浏览器窗口人工过一次再重发（L1） |
| 页面改版 | 抛 `AdapterError('selector')` | `npm run probe -- <provider> --send` 重新校准 `selectors/*.json`，**改完不用重启**（探针每次强制重读，适配器构造时也 reload）（L2） |
| 平台限流 / 排队 | 首字超时或长时间无内容 | 错误可一键重试；降低并发频率（L3） |
| 通道整体不可用 | — | 把该家 `ADAPTER_*` 切回 `mock`，或切 `api` 走官方 Key（L4） |

> ⚠️ **务必知道**：网页版通道是「用自动化模拟真人操作你自己的账号」，不是官方接口。
> 它受三家风控约束，也可能因为改版而失效。请克制使用频率，不要用来刷量或做批量业务。

---

## 十一、常见问题

| 现象 | 处理 |
|---|---|
| PowerShell 里 `npm` 报"无法加载文件 …npm.ps1" | 执行策略拦截，改用 `npm.cmd` |
| 端口被占用 | 改 `.env` 的 `PORT`；Vite 侧若 5173 被占会自动 +1（`strictPort: false`），看启动日志里的实际地址 |
| 页面能开但消息没反应 | 看浏览器控制台有没有 WebSocket 连接报错；再确认 `8787` 是否活着（`GET /api/health`） |
| 引用了内置 `node:sqlite` 但启动报错 | Node 版本太低，需 >= 20.11（推荐 22/24） |
| 想清空全部数据重来 | 停掉服务，删掉 `storage/` 目录再启动 |
| `npm install` 时提示 esbuild 等 postinstall 待批准 | 正常，`tsx` / `vite` 无需该脚本即可运行 |
| `EADDRINUSE 8787` | 端口被别的项目占了。改 `PORT`（后端）+ `MAW_SERVER_PORT`（前端反代）即可，例如都用 `8877` |
| 点「登录三家」没反应 / 报 409 | 说明当前是 headless 模式。把 `BROWSER_HEADLESS` 设为 `false` 再重启 |
| `Executable doesn't exist` | Playwright 自带 Chromium 没装。执行 `npx playwright install chromium`，或把 `BROWSER_CHANNEL` 设为 `msedge` / `chrome` 直接复用本机浏览器 |
| 窗口开了但一直「等待登录」 | 选择器可能失效：先点「我已登录」手动落盘；再用 `npm run probe -- <provider> --deep` 校准 `selectors/*.json` |
| profile 被占用 | 同一个 profile 只能被一个进程用。关掉命令行登录脚本，或先停服务 |

---

## 十二、版本

本项目改动遵循仓库根 `AGENTS.md` 的「对话即版本」规则，每次对话提交、打 tag 并推送；版本记录见仓库根 `RELEASES.md`。
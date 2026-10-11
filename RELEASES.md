# 版本记录（RELEASES）

本仓库遵循「对话即版本」的同步规则：每次对话产生的修改都会提交、打 tag 并推送到
<https://github.com/mumu2467/mumu-codex-code>。

## 版本命名规则

```
v<N>-<YYMMDD>-<HH：MM>
```

| 片段 | 含义 | 示例 |
|---|---|---|
| `v<N>` | 对话版本号，从 1 起递增 | `v1`、`v2`、`v3` |
| `<YYMMDD>` | 打 tag 当天的日期 | `261012` |
| `<HH：MM>` | 打 tag 当时的时间 | `00：17` |

完整示例：`v1-261012-00：17`（2026-10-12 00:17 的第 1 版）

> 时间分隔用全角冒号 `：`。半角 `:` 在 git tag 与 Windows 文件名中均非法。

只涉及单个项目的版本，可用带项目名的形式：

```
<项目名>-v<N>-<YYMMDD>-<HH：MM>
```

## 版本列表

| Tag | 时间 | 主要内容 |
|---|---|---|
| `v1-261012-00：17` | 2026-10-12 00:17 | 建立仓库与版本同步机制：初始化 git、接入 GitHub、制定忽略规则、写入 `AGENTS.md` 版本同步规范 |
| `multi-ai-workbench-v2-261012-00：31` | 2026-10-12 00:31 | 新建 `multi-ai-workbench` 项目并输出设计稿：路线 A(Playwright 驱动真实网页版) 为主 + 路线 B(官方 API) 兜底统一到 `ChatAdapter`；含 iframe/同源策略破题、三路对比、目录结构、数据流图、接口契约、降级阶梯与分步实施计划（设计阶段，待确认） |
| `multi-ai-workbench-v3-261012-00：42` | 2026-10-12 00:42 | 交付 Step 1-2：npm workspaces 脚手架（shared/server/web 三包，shared 以 TS 源码直引做单一事实来源）+ Fastify 编排后端（node:sqlite 落盘、WebSocket 流式事件协议、`ChatAdapter` 契约 + Mock 通道 + 注册表热切换、故障注入/停止/重试/一键导出）+ React 18 三窗并发页（≥1280 三列 / 768-1280 两列 / <768 Tab，文字+图片混合发送、独立停止清空新会话、耗时/首字延迟/token 指标）+ `npm run dev` 一键启动与 26 项端到端冒烟测试，并补齐可用的 README |
| `multi-ai-workbench-v4-261012-01：10` | 2026-10-12 01:10 | 交付 Step 3a —— Playwright 浏览器通道的**登录链路并实测通过**：`browser-pool`（每 provider 一个持久化 BrowserContext、懒启动、内核自动探测，本机无 Chromium 时自动改用 Edge/Chrome、`playwright-extra`+stealth 反检测）+ `login-service`（开真实窗口等人工扫码，先见过登出态再连续确认才判定成功，含「我已登录」手动兜底）+ 三家选择器外置 JSON（按真实 DOM 校准）+ `scripts/login.ts` / `scripts/probe.ts` + `/api/login*` 接口与顶栏「登录三家」面板；另修 `start()` 阻塞请求、端口冲突（`PORT` 自动贯穿前端反代）等问题 |
| `multi-ai-workbench-v5-261012-01：51` | 2026-10-12 01:51 | 交付 Step 3b —— **把消息（含图片）真发到 DeepSeek / 豆包 / Kimi 的 C 端网页并抓流式回复，三家全部实测通过**：新增 `base-web-adapter` 通用引擎（打开/复用窗口 → 上传图片并等缩略图真的出现 → 输入文字（textarea 用 fill、富文本用 insertText，不吃就回退逐字敲）→ Enter 优先、输入框有残留就回退点发送按钮 → 轮询最后一条助手正文做增量 diff → 按平台「生成中」标志 + 静默时长判结束，含首字/整体硬超时与 auth / captcha / selector 分类错误，登录失效自动映射为 `auth.required`）+ 三家薄适配器与 `web-adapters` 工厂 + 按真实 DOM 校准的三份 `selectors/*.json`（含 Kimi 必须 `:not(.toolcall-content-text)` 排除思考链、豆包 `data-streaming="true"` 结束标志、DeepSeek 只用 `ds-assistant-message-main-content` 以免混入深度思考）+ 注册表接入 `playwright` 通道并把体检做成"不主动开浏览器" + 新增 `scripts/e2e-send.ts` 端到端联调脚本 + 把 `probe.ts` 升级为支持 `--send / --url / --dump / --image / --wait` 以校准真实 DOM |
| `multi-ai-workbench-v6-261012-02：01` | 2026-10-12 02:01 | 交付 Windows 一键启动器 `启动工作台.exe` —— 双击即起服务 + 自动开浏览器，关窗即停。新增 `tools/launcher/`：C# WinForms 小窗（22KB，用 Windows 自带 `csc.exe` 编译，**不需要 .NET SDK / VS**）+ `build.ps1` 一键重编 + `make-icon.mjs` 生成品牌色图标。启动链路：探测 Node（缺失给友好提示）→ 缺 `node_modules` 自动 `npm install` → 缺 `packages/web/dist` 自动 `npm run build` → 起后端（`npm run start --workspace @maw/server`）→ 轮询 `/api/health` 就绪后自动开页面；端口从 `.env` 的 `PORT` 解析、不写死；关窗走 `taskkill /T` 停整棵进程树 + 按端口兜底清理监听，不留后台进程；日志统一落 `logs/launcher.log`（已屏蔽 ANSI 色码，`logs/` 加入忽略）。README 增「一键启动（Windows，双击 exe）」章节 + 2 条 FAQ。 |

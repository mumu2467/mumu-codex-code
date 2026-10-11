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

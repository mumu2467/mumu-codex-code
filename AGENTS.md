# MUMU codex code — 工作区约定

## 仓库

- GitHub 仓库：<https://github.com/mumu2467/mumu-codex-code>
- 本工作区根目录（`D:\MUMUcode\MUMU codex code\`）即仓库根目录
- 所有项目以子文件夹形式共存在此 monorepo 中

## 目录规范（必须遵守）

1. 每开始一个新项目，先在根目录下单独建立一个子文件夹，该项目所有文件（源码、依赖、构建产物）都生成在该子文件夹内。
2. 不要把项目文件直接放在仓库根目录；根目录只保留 `AGENTS.md`、`README.md`、`RELEASES.md`、`.gitignore` 和各项目文件夹。
3. 每个项目自成一体系，依赖与产物不跨项目共享。
4. 同名同日期的文件夹视为同一个项目，直接在原文件夹继续开发，不另建副本。

## 版本同步规范（必须遵守）

每次对话产生的修改，都要提交、打 tag 并推送到 GitHub。

### 版本号格式

```
v<N>-<YYMMDD>-<HH：MM>
```

| 片段 | 含义 | 示例 |
|---|---|---|
| `v<N>` | 对话版本号，从 1 起递增 | `v1`、`v2`、`v3` |
| `<YYMMDD>` | 打 tag 当天的日期 | `261012` |
| `<HH：MM>` | 打 tag 当时的时间 | `00：17` |

- 完整示例：`v1-261012-00：17`（2026-10-12 00:17 的第 1 版）
- 只涉及单个项目的版本，可带项目名前缀：`<项目名>-v<N>-<YYMMDD>-<HH：MM>`
- 时间分隔用全角冒号 `：`；半角 `:` 在 git tag 与 Windows 文件名中均非法

### 每轮对话的执行要求

1. 改动完成后依次执行：`git add` → `git commit` → 按上述格式打 **annotated tag** → `git push` 到 `origin main`（并推送 tag）
2. 同时在 `RELEASES.md` 的版本表中追加一行记录
3. 不要使用 `--force` 推送；历史只增不改

## 禁止入库的内容

| 路径 | 原因 |
|---|---|
| `**/node_modules/` | 依赖，可重新安装 |
| `**/.browser-profile/` | 浏览器登录态，含 cookie / session token，入库即泄露凭据 |
| `.env`、`*.key`、`*.pem`、`*.pfx` 等 | 密钥与凭据 |
| 单个超过 100MB 的文件 | 超出 GitHub 单文件硬上限 |

## 网络

本机访问 GitHub 需经代理 `127.0.0.1:10808`，已写入 git 全局配置 `http.https://github.com/.proxy`，仅对 github.com 生效。
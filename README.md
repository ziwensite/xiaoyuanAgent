# 小元 Agent · XiaoyuanAgent

多 Agent AI 助手，把 AI 深度集成到 Obsidian 的笔记工作流。
A multi-agent AI assistant that brings AI into your Obsidian note workflow.

[中文](#中文) · [English](#english)

| 项目 | 值 |
|------|-----|
| 版本 / Version | 0.1.0 |
| 许可证 / License | MIT |
| 平台 / Platform | 仅桌面端 / Desktop only |
| 最低 Obsidian 版本 / Min app version | 1.5.0 |

---

# 中文

## 简介

小元 Agent 采用**可扩展的多 Agent 注册表**：内置两个 Agent——小A（API 通道）与小C（OpenCode 通道），
你也可以自由添加任意数量的 Agent。每个 Agent 拥有独立的通道、模型、头像与系统提示词。

两种协作方式：

- **群聊**：一条会话里所有 Agent 都在场，用 `@名字` 点名由谁回答。
- **独立对话**：为某个 Agent 单独开一条会话线，上下文互不干扰。

群聊时，每个 Agent 的系统提示词末尾会自动注入当前成员名单（含通道、当前模式与能力简介），
因此 Agent 知道其他成员擅长什么，可以主动把任务 `@` 给合适的同伴。

## 功能特性

- **多 Agent**：增删、改名、换头像、改通道与提示词；能力简介自动进入群聊名单。
- **`@` 路由**：消息里 `@小C 帮我看看项目结构` 直接由该 Agent 回复。
- **后台委托**：前台 Agent 在回复中 `@同伴 任务` 时，插件在后台并发执行（最多 3 个，单项 5 分钟超时），完成后结果自动冒泡。
- **双通道同时在线**：
  - `API`：直连任意 OpenAI 兼容接口，支持多个提供商分组管理。
  - `OpenCode`：连接本地 `opencode serve`，可读写文件、执行命令、跑项目任务。
- **工作区切换**：默认库根目录，也可切到任意目录作为 AI 的工作区；记住最近 5 个。
- **模型选择**：按供应商分组折叠；API 提供商可在线拉取模型列表。
- **输入框工具栏**：附件、Agent 切换、模型、思考强度、当前笔记 chip、上下文用量。
- **当前笔记上下文**：一键把当前打开的笔记内容（截断至 2000 字符）随消息发给 AI。
- **上下文管理**：显示 token 用量百分比，支持压缩与重置上下文。
- **流式回复**：实时流式输出，推理过程单独展示。
- **文件变更预览**：Diff 预览，回复中出现的库内文件路径可直接点击打开。
- **选中文本操作**：润色、总结、补全、扩写、翻译（中/英）、续写。
- **技能系统**：基于 `AGENTS.md`，`/skillName` 调用，支持定时自动执行（每小时 / 6 小时 / 每天 / 每周）。
- **中英双语界面**、深色/浅色主题自适应。

## 安装

### 手动安装

1. 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `<你的库>/.obsidian/plugins/xiaoyuanAgent/`。
3. 重启或重载 Obsidian，在 **设置 → 第三方插件** 中启用「XiaoyuanAgent / 小元 Agent」。

### 从源码构建

```bash
git clone https://github.com/ziwensite/xiaoyuanAgent.git
cd xiaoyuanAgent
npm install
npm run build
```

构建产物 `main.js` 会输出到插件目录，配合 `manifest.json`、`styles.css` 即可使用。

> 插件依赖 Node.js / Electron API（`fs`、`child_process`、Electron `net`）来启动本地 OpenCode 服务，**仅支持桌面端**。

## 快速上手

1. 打开聊天面板：命令面板执行「切换小元 Agent 聊天面板」，或点击左侧功能区的机器人图标。
2. 配置一条通道：
   - **API**：设置 → API 设置，新增提供商，填 Base URL、API Key，再添加或在线拉取模型。
   - **OpenCode**：安装 [opencode](https://opencode.ai) v2；设置 → CLI 设置确认路径，开启「自动启动」。
3. 在输入框里直接提问；需要指定 Agent 时输入 `@`，需要调用技能时输入 `/`。

## 界面导览

### 顶栏

从左到右依次为：**工作区**、**聊天记录**、**Agent 切换器**，右侧为 **API 状态灯**、**OpenCode 状态灯** 与 **设置**。

- 工作区 chip 显示当前工作区（默认「库根目录」，自定义时显示目录名并高亮）。
- 点击聊天记录进入会话菜单：按 Agent 分组、可搜索；**每个分组的第一行是「＋ 新建」**，群聊组建群聊，Agent 组直接新建该 Agent 的独立对话。
- 点击 Agent 切换器在群里切换下一条消息由谁回答。
- 两盏状态灯分别检测 API 通道与本地 OpenCode 服务；点击 OpenCode 灯可查看/关闭服务器。

### 输入框

- 输入 `@`：弹出所有启用的 Agent。
- 输入 `/`：弹出 `AGENTS.md` 中定义的技能。
- 工具栏：附件（图片、PDF、txt/md/csv/json/yaml/xml）、Agent 工具、模型、思考强度、当前笔记 chip、上下文进度、发送/停止。

### 工作区

工作区决定 AI（尤其是 OpenCode 通道）实际读写的目录，默认是库根目录。

- 切换方式：点顶栏工作区 chip → 选择库根目录、最近使用过的目录，或「浏览文件夹…」。
- 切换后会清空当前会话与服务端绑定，并停止 OpenCode 服务；**下一条消息会自动以新目录重启服务**，首次可能等待几秒。
- 已知限制：工作区在库外时，Diff 预览中的文件双链无法跳转（文件不在库里）。

### 会话

- 群聊是默认会话；独立对话按 Agent 单独存放。
- 切换前台 Agent 只改变下一条消息的回复者，不会切换当前会话内容。
- 「话题分段」只做视觉分隔，不影响发送给模型的上下文。
- 聊天记录默认存放在 `_xiaoyuanAgent/chatHistory/`（每会话一个 Markdown 文件），路径可在设置中修改。

## 通道说明

### API 通道

- 兼容 OpenAI 的 `chat/completions` 接口，支持自定义 Base URL。
- 提供商分组：一个提供商共享 Base URL 与 API Key，其下可维护多个模型；模型列表按名称排序，点击整行选中。
- 状态灯反映真实调用或探测结果。

### OpenCode 通道

- 通过本地 `opencode serve` 的 HTTP 服务（`/api/*`）执行，可读写文件、运行命令。
- 连接策略：复用已运行服务 → 读取服务注册文件 → 尝试配置端口 → 自建 `opencode serve`。
- 默认主机 `127.0.0.1`、端口 `16226`；端口被占用时自动顺延并提示。
- 鉴权使用 `Basic opencode:<password>`，密码来自服务注册文件或 `OPENCODE_SERVER_PASSWORD`。
- 已验证版本 2.1.x（当前标记 2.1.2）；设置页状态卡片会显示实际版本，主版本非 2 时给出提示。
- 接口自检：CLI 设置页提供逐项探测（服务信息 / Agent / 模型 / Provider / 事件流 / 会话增删 / Diff），聊天异常时先跑自检。

## 设置面板

| Tab | 内容 |
|-----|------|
| 通用 | 默认 Agent、代理、启动行为、聊天记录路径、Diff / 思考显示等 |
| CLI 设置 | OpenCode 路径、自动启动、Host / Port、模型、Agent、思考强度、文件权限、接口自检 |
| API 设置 | 多提供商管理、模型列表（支持在线获取）、思考强度 / 温度 / 最大 Token |
| Agents | Agent 卡片：名称、头像、通道、模型、能力简介、系统提示词、启用 / 默认 / 恢复默认 |
| Skills | 生成或编辑 `AGENTS.md`、同步技能列表、定时执行间隔 |
| Prompt 模板 | 内置模板恢复默认，自定义模板增删 |
| 关于 | 版本、作者、协议、依赖 |

## 命令

| 命令 | 说明 |
|------|------|
| 切换小元 Agent 聊天面板 | 打开/聚焦聊天视图 |
| 新建 AI 对话 | 建立新会话 |
| 用当前笔记开启 AI 对话 | 把当前笔记内容作为首条消息 |
| `/技能名` 命令 | 每个已同步技能自动注册一条命令，把 `/技能名 ` 填入输入框 |

> 快捷键未预置，请在 **设置 → 快捷键** 中自行绑定。

## 隐私与网络

- **不会收集任何使用数据**，也不包含遥测。
- API Key 保存在插件配置文件 `data.json`（位于你的库内），不会上传到作者或第三方。
- 网络请求只发往：你自己配置的 API 地址，或本机运行的 OpenCode 服务。
- OpenCode 通道会在本机启动子进程（`opencode serve`），仅在你启用该通道时发生。
- 对话记录以 Markdown 形式存放在库内，随你的库同步策略走。

## 已知限制

- 仅支持桌面端（依赖 Node.js / Electron）。
- OpenCode 通道需要自行安装 `opencode` v2，插件不打包该二进制。
- 工作区在库外时，Diff 预览里的文件双链不可点击。
- 后台委托最多 3 个并发，单项 5 分钟超时。
- 内置 Agent（小A / 小C）可改名、改配置，但不可删除。

## 开发

```bash
npm install      # 安装依赖
npm run dev      # 开发模式（watch）
npm run build    # 生产构建（lint + tsc + esbuild）
npm run lint     # 仅 lint
```

目录结构：

```
src/
  main.ts                插件入口、命令、后台委托队列、设置迁移
  chat-view.ts           聊天视图装配
  chat/
    header-view.ts       顶栏、会话菜单、状态灯
    input-view.ts        输入框、笔记 chip、@ / 技能弹层
    stream-controller.ts 流式请求与事件处理
    renderer.ts          消息渲染、Diff、文件路径双链
    session-controller.ts 会话持久化与切换
  agent-registry.ts      Agent 注册表、默认提示词、群聊名单
  ai.ts                  通道编排（API / OpenCode）
  api-client.ts          OpenAI 兼容客户端（流式）
  opencode-*.ts          OpenCode 服务端管理、配置、探测、同步
  toolbar.ts             输入区工具栏与工作区 chip
  model-picker.ts        模型选择弹层
  popup.ts               通用弹层
  context-control.ts     上下文状态、压缩、重置
  settings/              设置面板各 Tab
  locales/{zh,en}.json   中英文案
```

更多设计细节见 [DESIGN.md](./DESIGN.md)。

## 反馈

问题与建议请提交到 GitHub Issues：<https://github.com/ziwensite/xiaoyuanAgent/issues>

## 许可证

MIT © XiaoYuan

---

# English

## Overview

XiaoyuanAgent uses an **extensible multi-agent registry**. Two agents ship built in — Xiaoa (API channel) and Xiaoc (OpenCode channel) — and you can add as many of your own as you like. Every agent has its own channel, model, avatar and system prompt.

Two ways to collaborate:

- **Group chat**: all agents are present in one session; mention `@name` to pick who answers.
- **Direct chat**: a separate session thread for a single agent, with its own context.

In group chat, the current member roster (channel, active mode and capability summary) is appended to each agent's system prompt, so agents know who is good at what and can delegate work with `@mentions`.

## Features

- **Multi-agent**: add, rename, change avatar, channel and prompt; capability summaries are injected into the roster automatically.
- **`@` routing**: `@Xiaoc inspect this project` is answered by that agent.
- **Background delegation**: when a replying agent mentions `@teammate task`, the plugin runs it in the background (max 3 concurrent, 5-minute timeout per task) and bubbles up the result.
- **Two channels, both live**:
  - `API`: connect to any OpenAI-compatible endpoint; providers are grouped.
  - `OpenCode`: talk to a local `opencode serve` instance to read/write files and run commands.
- **Workspace switcher**: vault root by default, or any directory on disk; the last 5 workspaces are remembered.
- **Model picker**: grouped by provider, collapsible; API providers can fetch the model list online.
- **Composer toolbar**: attachments, agent switch, model, reasoning effort, current-note chip, context usage.
- **Current note context**: attach the active note's content (truncated to 2000 chars) to a message with one click.
- **Context management**: token-usage percentage, compact and reset.
- **Streaming replies** with a separate reasoning display.
- **Diff preview** for file changes; vault file paths in replies are clickable.
- **Selection actions**: polish, summarize, complete, expand, translate (zh/en), continue.
- **Skills**: `AGENTS.md` based, invoked with `/skillName`, optionally scheduled (hourly, every 6 hours, daily, weekly).
- **Bilingual UI** (Chinese / English), adapts to light and dark themes.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css`.
2. Put them into `<your vault>/.obsidian/plugins/xiaoyuanAgent/`.
3. Reload Obsidian and enable **XiaoyuanAgent** under **Settings → Community plugins**.

### From source

```bash
git clone https://github.com/ziwensite/xiaoyuanAgent.git
cd xiaoyuanAgent
npm install
npm run build
```

The build emits `main.js` next to `manifest.json` and `styles.css`.

> The plugin uses Node.js / Electron APIs (`fs`, `child_process`, Electron `net`) to launch a local OpenCode server, so it is **desktop only**.

## Getting started

1. Open the chat panel from the command palette ("Toggle XiaoyuanAgent chat") or the robot ribbon icon.
2. Configure a channel:
   - **API**: Settings → API. Add a provider with Base URL and API key, then add models manually or fetch them online.
   - **OpenCode**: install [opencode](https://opencode.ai) v2, then check the path under Settings → CLI and enable auto-start.
3. Ask anything in the composer; type `@` to address an agent, `/` to run a skill.

## UI tour

### Header

From left to right: **workspace**, **chat history**, **agent switcher**; on the right: **API status**, **OpenCode status**, **settings**.

- The workspace chip shows the active workspace (vault root by default, highlighted when custom).
- The chat history menu is grouped by agent and searchable. **The first row of each group is "＋ New"** — group chat creates a group session, an agent group creates a direct session for that agent.
- The agent switcher decides who answers the next message.
- The two status lights check the API channel and the local OpenCode server independently; click the OpenCode light to inspect or stop the server.

### Composer

- `@` lists all enabled agents.
- `/` lists skills defined in `AGENTS.md`.
- Toolbar: attachments (images, PDF, txt/md/csv/json/yaml/xml), agent tools, model, reasoning effort, current-note chip, context usage, send/stop.

### Workspace

The workspace is the directory the AI (especially the OpenCode channel) actually reads and writes; it defaults to the vault root.

- Switch via the header workspace chip: vault root, recent workspaces, or "Browse folder…".
- Switching clears session bindings and stops the OpenCode server. **The next message restarts it in the new directory**, so the first request may take a few seconds.
- Known limitation: if the workspace is outside the vault, file links inside the diff preview cannot be opened.

### Sessions

- Group chat is the default; direct chats are stored per agent.
- Switching the foreground agent only changes who answers next; it does not swap the current session.
- Topic sections are visual separators only and do not affect the model context.
- Chat history is stored under `_xiaoyuanAgent/chatHistory/` (one Markdown file per session); the path is configurable.

## Channels

### API

- Works with OpenAI-compatible `chat/completions` endpoints and any custom Base URL.
- Providers share Base URL and API key and keep their own model list; models are sorted by name and selected with a full-row click.
- The status light reflects real calls or probes.

### OpenCode

- Executes through a local `opencode serve` HTTP server (`/api/*`), so the agent can read/write files and run commands.
- Connection strategy: reuse a running server → read the managed-server registry → try the configured port → launch `opencode serve`.
- Default host `127.0.0.1`, default port `16226`; if the port is taken, the next free one is used and reported.
- Auth: `Basic opencode:<password>`, from the registry file or `OPENCODE_SERVER_PASSWORD`.
- Verified against OpenCode 2.1.x (currently pinned to 2.1.2). The status card shows the detected version and warns when the major version is not 2.
- Built-in API self-check (server info, agents, models, providers, event stream, session CRUD, diff) helps diagnose issues after an upgrade.

## Settings

| Tab | Contents |
|-----|----------|
| General | Default agent, proxy, startup behavior, chat history path, diff / reasoning display |
| CLI | OpenCode path, auto-start, host / port, model, agent, reasoning effort, file permissions, self-check |
| API | Providers and model lists (with online fetch), reasoning effort, temperature, max tokens |
| Agents | Agent cards: name, avatar, channel, model, capability summary, system prompt, enable / default / restore defaults |
| Skills | Generate or edit `AGENTS.md`, sync skills, schedule interval |
| Prompt templates | Restore built-in templates, add or remove custom ones |
| About | Version, author, license, dependency |

## Commands

| Command | Description |
|---------|-------------|
| Toggle XiaoyuanAgent chat | Open or focus the chat view |
| New AI chat | Start a new session |
| Chat with current note | Send the active note as the first message |
| Skill commands | One command per synced skill, pre-fills `/skillName ` |

> No default hotkeys are set. Bind your own under **Settings → Hotkeys**.

## Privacy and network

- **No usage data is collected** and there is no telemetry.
- API keys are stored in the plugin's `data.json` inside your vault and are never uploaded to the author or any third party.
- Network requests only go to the API endpoints you configure or to your locally running OpenCode server.
- The OpenCode channel starts a local subprocess (`opencode serve`) on your machine.
- Chat transcripts are stored as Markdown files in your vault and follow your own sync policy.

## Known limitations

- Desktop only (requires Node.js / Electron).
- The OpenCode channel requires a separately installed `opencode` v2; the binary is not bundled.
- File links inside diff previews do not work when the workspace is outside the vault.
- Background delegation is capped at 3 concurrent tasks with a 5-minute timeout.
- Built-in agents (Xiaoa / Xiaoc) can be renamed and reconfigured but not deleted.

## Development

```bash
npm install      # install dependencies
npm run dev      # watch mode
npm run build    # lint + typecheck + production bundle
npm run lint     # lint only
```

```
src/
  main.ts                entry point, commands, delegation queue, settings migration
  chat-view.ts           chat view assembly
  chat/
    header-view.ts       header, session menu, status lights
    input-view.ts        composer, note chip, @ and skill popups
    stream-controller.ts streaming requests and events
    renderer.ts          message rendering, diffs, clickable file paths
    session-controller.ts session persistence and switching
  agent-registry.ts      agent registry, default prompts, roster
  ai.ts                  channel orchestration (API / OpenCode)
  api-client.ts          OpenAI-compatible streaming client
  opencode-*.ts          OpenCode server management, config, probe, sync
  toolbar.ts             composer toolbar and workspace chip
  model-picker.ts        model picker popup
  popup.ts               shared popup
  context-control.ts     context status, compact, reset
  settings/              settings tabs
  locales/{zh,en}.json   translations
```

See [DESIGN.md](./DESIGN.md) for deeper design notes.

## Feedback

Please open an issue at <https://github.com/ziwensite/xiaoyuanAgent/issues>.

## License

MIT © XiaoYuan

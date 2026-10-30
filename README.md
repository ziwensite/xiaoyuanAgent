# XiaoyuanAgent / 小元 Agent

**小元 Agent** 是一个 [Obsidian](https://obsidian.md) 插件，把 AI 能力深度集成进你的笔记工作流。
它把原「双助手」升级为**可扩展的多 Agent 注册表**：内置小A（API 通道）与小C（OpenCode 通道），
并允许你自由添加任意数量的 Agent，每个 Agent 可独立配置通道、模型、头像与系统提示词。

**XiaoyuanAgent** is an [Obsidian](https://obsidian.md) plugin that integrates AI deeply into your
note workflow. It upgrades the original dual-assistant design into an **extensible multi-agent
registry**: two built-in agents (小A on the API channel, 小C on the OpenCode channel) plus any number
of your own, each with its own channel, model, avatar and system prompt.

---

## 功能特色 / Features

| 中文 | English |
|------|---------|
| 🧑‍🤝‍🧑 多 Agent 系统，可自由增删、改名、换头像 | 🧑‍🤝‍🧑 Multi-agent system: add, rename, recolor, delete |
| 🎯 `@名字` 直接点名路由，任意 Agent 均可被 @ | 🎯 Route messages with `@name` mentions |
| 🔄 前台回复中 `@对方` → 后台静默执行，完成后冒泡 | 🔄 Background delegation via `@mention` in replies |
| 💬 AI 聊天面板，群聊 + Agent 独立会话 | 💬 Chat panel with group chat + per-agent sessions |
| 🗂️ 左侧会话抽屉，按 Agent 分组、可搜索 | 🗂️ Left session drawer, grouped by agent, searchable |
| 📑 话题分段（仅展示，不影响上下文） | 📑 Topic sections (display only, no context effect) |
| ✍️ 选中文本后操作：润色、总结、补全、扩写、翻译、续写 | ✍️ Text operations: polish, summarize, complete, expand, translate, continue |
| 📎 附件上传（图片、PDF、文本文件） | 📎 File attachments (images, PDFs, text files) |
| 📊 文件变更 Diff 预览 | 📊 File diff preview |
| 🔄 流式响应 | 🔄 Streaming responses |
| 🔊 状态栏朗读指示器 | 🔊 Speaking indicator in status bar |
| ⏰ 定时 Skill 自动执行 | ⏰ Scheduled skill execution |
| 🌏 中英双语界面 | 🌏 Full Chinese / English UI |

---

## 多 Agent 系统 / Multi-Agent System

每个 Agent 是一份独立配置：

| 字段 | 说明 |
|------|------|
| 名称 | 唯一，同时作为 `@` 路由键与消息署名 |
| 头像 | Obsidian 图标名（lucide） |
| 通道 | `API`（直连 OpenAI 兼容接口）或 `OpenCode`（本地 `opencode serve`） |
| 模型 | 可选，留空则沿用通道默认模型 |
| 系统提示词 | 该 Agent 的角色定位 |
| 启用 | 停用后不参与路由与列表；至少保留一个启用的 Agent |
| 默认 | 不 @ 任何人时由它回答（全局唯一） |

内置 Agent：

| Agent | 默认通道 | 能力定位 |
|-------|----------|----------|
| 小A | API | 对话、写作、分析、翻译 |
| 小C | OpenCode | 文件操作、命令执行、项目操作 |

> 内置 Agent 可改名、改提示词、改通道，但**不可删除**。

### @ 路由

```
用户: @小C 帮我统计项目文件数量        → 小C 直接回复
用户: @小A 帮我写一段文案             → 小A 直接回复
用户: 帮我看看这个项目结构怎么样       → 当前默认 Agent 回复
```

### 后台委托

前台 Agent 在回复中以 `@对方 任务` 引用时，插件自动截取任务并在后台执行，
完成后结果冒泡显示。后台委托的**并发上限为 3**，且单项带超时保护。

```
小A: 我来分析代码结构。@小C 读取 src/ 目录文件
     (插件后台调起小C，不阻塞对话)
     ...
小C: src/ 下有以下文件:
     main.ts
     utils.ts
     ...
```

---

## 会话模型 / Session Model

- **群聊会话（默认）**：所有 Agent 共享同一条会话，`@` 谁就由谁回答。
- **Agent 独立会话**：在抽屉里点「以此 Agent 新建对话」，即开启一条属于该 Agent 的独立线。
- 切换前台 Agent **不会**改变当前屏幕内容，只决定下一条消息由谁回答；
  要进入某 Agent 的独立线，需显式新建。此设计避免误切上下文。
- 话题分段只是会话内的**视觉分隔**，不影响发送给模型的上下文。

---

## 执行通道 / Execution Channels

| 通道 | 说明 |
|------|------|
| API | 直连设置里配置的 OpenAI 兼容接口，需要单独配置 API Key |
| OpenCode | 通过本地 `opencode serve` 的 HTTP 服务端（`/api/*`）执行，可读写文件、运行命令。需安装 [opencode](https://opencode.ai) v2 |

两条通道**同时在线**：无论当前前台 Agent 是谁，另一条通道的 Agent 依然可以随时被 `@`。
`execMode` 保留为兼容/回退项，前台 Agent 的通道才是权威值，切换前台 Agent 会同步它。

### OpenCode v2 适配要点

- 接口前缀统一为 `/api/*`；响应带 `{ location, data }` 信封，插件自动拆包。
- 鉴权：`Basic opencode:<password>`，密码来自服务注册文件或 `OPENCODE_SERVER_PASSWORD`。
- **双路自适应连接**：优先复用已有服务 → 读取托管服务注册文件 → 尝试配置端口 → 自建 `opencode serve`。
- **端口占用兜底**：配置端口（默认 `16226`）被占用时自动顺延并提示。
- **版本检测**：设置页状态卡片显示当前 OpenCode 版本；主版本非 2 时给出兼容提示，
  高于已验证版本（当前 `2.1.2`）时标注「未经验证」。
- **接口自检**：CLI 设置页提供逐项探测（服务端信息 / Agent / 模型 / Provider / 事件流 / 会话增删 / Diff），
  升级后聊天异常时先点它定位问题。

---

## 安装 / Installation

### 手动安装

1. 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `.obsidian/plugins/xiaoyuanAgent/`。
3. 在 Obsidian 设置 → 第三方插件 → 启用「小元 Agent」。

### 从源码构建

```bash
cd .obsidian/plugins/xiaoyuanAgent
npm install
npm run build
```

构建产物：`main.js`（配合已有的 `manifest.json` 与 `styles.css`）。

> 本插件依赖 Node 的 `fs` / `child_process` 来拉起本地 OpenCode 服务，因此**仅支持桌面端**。

---

## 设置面板 / Settings

打开 Obsidian 设置 → 小元 Agent。顶部为状态卡片，下方为横向 Tab：

| Tab | 内容 |
|-----|------|
| 通用 | 默认 Agent、代理、启动行为、聊天历史路径、Diff / 思考 / 上下文显示等 |
| CLI 设置 | OpenCode 路径、自动启动、Host / Port、模型、Agent、思考强度、文件权限、接口自检 |
| API 设置 | 多 API 提供者管理、思考强度 / 温度 / 最大 Token |
| Agents | Agent 卡片：名称、头像、通道、模型、系统提示词、启用 / 默认 / 删除 |
| Skills | 生成/编辑 `AGENTS.md`、同步 skill 列表、定时执行间隔 |
| Prompt 模板 | 内置模板恢复默认，自定义模板增删 |
| 关于 | 版本、作者、协议、依赖 |

### 状态卡片

实时显示：CLI 连接、OpenCode 版本、API 连接、CLI 模型、API 模型、代理。
两条通道各自独立检测。

---

## AGENTS.md 与技能 / Skills

在聊天输入框中使用：

- `/skillName` — 调用 `AGENTS.md` 中定义的 skill
- `@名字` — 弹出所有启用的 Agent 供点名

支持定时自动执行（每小时 / 6 小时 / 每天 / 每周）。

---

## 开发 / Development

```bash
npm install      # 安装依赖
npm run dev      # 开发模式（watch）
npm run build    # 生产构建（lint + tsc + esbuild）
npm run lint     # 仅 lint
```

### 目录结构

```
src/
  main.ts              插件入口、DelegationQueue、设置迁移
  settings.ts          7 个 Tab 的设置面板
  chat-view.ts         聊天视图、会话抽屉、@ 路由、后台委托
  agent-registry.ts    多 Agent 核心 API
  ai.ts                通道编排（CLI / API）
  api-client.ts        OpenAI 兼容 API 客户端
  opencode-*.ts        OpenCode 服务端 / 配置 / 探测
  session.ts           会话持久化
  types.ts / constants.ts / i18n.ts / utils.ts
  locales/{zh,en}.json 中英文案
```

设计细节见 [`DESIGN.md`](./DESIGN.md)（唯一事实来源）。

---

## License

MIT © XiaoYuan

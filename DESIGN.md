# 小元 Agent（xiaoyuanAgent）设计文档

> 文档：`DESIGN.md`（本仓库内维护，随实现随时更新）
> 版本：v1.0（设计阶段）
> 目标插件 id：`xiaoyuanAgent`　显示名：`XiaoyuanAgent` / 小元 Agent
> 参照项目：`../xiaoyuanAI`（Obsidian AI 插件，双助手系统）
> 设计方向：**方案 A — 完整复刻 + 多 Agent 增强**

---

## 0. 文档说明

本文件是整个新项目（xiaoyuanAgent）的唯一事实来源，覆盖：
命名与标识、目录结构、数据模型、模块职责、设置面板（原风格）、聊天面板、通道层、
国际化、样式规范、实施顺序、验收清单、待讨论问题。

> **维护约定**：本 `DESIGN.md` 随代码同步演进。任何影响架构、数据模型、命名规范、
> 交互流程的变更，必须先在本文档更新对应章节，再落地代码。禁止让实现与文档长期漂移。

源项目 `xiaoyuanAI` 的全部功能必须 100% 保留；在此基础上升级为**可扩展的多 Agent 架构**。

---

## 1. 目标与范围

### 1.1 目标

1. 在 `.obsidian/plugins/xiaoyuanAgent/` 下新建一个**完全独立**的 Obsidian 插件。
2. 完整复刻 `xiaoyuanAI` 的全部功能（聊天、双通道流式、文本操作、维基/Skill、设置面板等）。
3. 将写死的「双助手（小A/小C）」升级为**多 Agent 注册表**，支持 N 个 Agent。
4. 保持 `xiaoyuanAI` 的设置菜单**原风格**（状态卡片 + 横向 Tab + 图标装饰），并小幅优化。
5. 中英双语（zh/en）全覆盖。

### 1.2 非目标

- 不修改、不删除源项目 `xiaoyuanAI` 的任何文件。
- 本期不写单元测试（后续可补）。
- 不引入新的第三方运行时依赖（保持 Obsidian API + esbuild）。

### 1.3 关键决策（已确认）

| 决策项 | 结论 |
|--------|------|
| 实现方向 | 方案 A：复刻 + 多 Agent 增强 |
| CSS 前缀 | `xyag-`（全部类名 / 视图类型重命名） |
| 插件 id / 名 | `xiaoyuanAgent` / `XiaoyuanAgent`（中文：小元 Agent） |
| 版本 | `1.0.0`，`minAppVersion 1.5.0`，`isDesktopOnly true` |
| Agent 预置 | 内置 2 个（小A=API、小C=CLI），可自由新增 N 个 |
| 设置面板风格 | 沿用原风格 + 小幅优化 |
| 聊天面板 | 增加 Agent 切换器 + `@` 弹出完整 Agent 列表 |
| 会话组织 | **单会话群聊为默认**；可指定 Agent 新建独立对话；会话列表**按 Agent 分组**，用**头部下拉菜单**呈现（见 5.10） |
| 话题分段 | 会话内支持「话题」分段，**仅作展示**、不切上下文（见 5.10.3） |
| 测试 | 本期暂不写 |
| 作者 / 许可 | `XiaoYuan` / MIT |
| 待定项 Q1–Q10 | 全部按文档「建议」执行 |

---

## 2. 命名与标识规范

| 项 | 值 |
|----|----|
| 插件目录 | `xiaoyuanAgent/` |
| manifest id | `xiaoyuanAgent` |
| manifest name | `XiaoyuanAgent` |
| 中文显示名 | 小元 Agent |
| 视图类型 | `xyag-agent-view` |
| CSS 前缀 | `xyag-` |
| 会话索引 key | `xyag-sessions` |
| 当前会话 key | `xyag-current-session` |
| 默认历史路径 | `_xiaoyuanAgent/chatHistory` |
| 自动任务日志 | `_xiaoyuanAgent/autoTaskLog.md` |
| 命令前缀 | `xiaoyuanAgent-*` |
| 设置 Tab id | `xiaoyuanAgent` |
| 数据版本字段 | `settingsVersion = 1`（新项目起点） |

---

## 3. 目录结构

```
xiaoyuanAgent/
├── manifest.json              # 插件清单（双语描述）
├── package.json               # dev/build/lint 脚本（无自有测试脚本）
├── esbuild.config.mjs         # 打包配置（沿用源项目 external 列表；dev 模式额外监听 styles.css）
├── tsconfig.json
├── eslint.config.mjs
├── styles.css                 # 全站样式（xyag- 前缀）
├── README.md                  # 中英双语说明
├── DESIGN.md                  # 本设计文档
└── src/
    ├── main.ts                # 插件入口：视图/命令/菜单/定时任务/迁移
    ├── constants.ts           # 默认设置 / 默认模板 / 默认 Agent / 常量
    ├── types.ts               # 全部类型定义
    ├── i18n.ts                # 语言初始化 + t()
    ├── locales/
    │   ├── zh.json            # 中文词条（全键）
    │   └── en.json            # 英文词条（全键）
    │
    ├── agent-registry.ts      # ★ 多 Agent 注册表（核心增强）
    ├── settings.ts            # ★ 设置面板（原风格 + Agents Tab）
    ├── chat-view.ts           # ★ 聊天面板（ItemView）
    │
    ├── ai.ts                  # 通道编排（CLI 优先 → API 降级）
    ├── api-client.ts          # OpenAI 兼容 API 调用 + SSE 解析
    ├── opencode-client.ts     # OpenCode v2 HTTP/SSE/鉴权/信封拆包
    ├── opencode-config.ts     # 模型 / Agent / 版本 拉取与解析
    ├── opencode-server.ts     # 服务发现 / 自建 / 端口兜底 / 进程管理
    ├── opencode-probe.ts      # 接口自检（逐项探测 v2 契约）
    │
    ├── session.ts             # 会话 Markdown 读写 / 扫描 / 元数据
    ├── attachment.ts          # 附件选择与 base64
    ├── modals.ts              # 文本操作弹窗（可拖动）
    │
    ├── toolbar.ts             # 输入区工具栏
    ├── action-bar.ts          # 消息操作条
    ├── action-buttons.ts      # 操作按钮工厂
    ├── popup.ts               # 通用弹层（全插件统一：贴触发器 + 自动翻面 + 点外面关闭）
    ├── model-picker.ts        # 模型选择器（列表内容 + 弹层承载）
    ├── model-select.ts        # 自绘下拉框控件（外观 + 键盘）
    ├── select-list.ts         # 通用自绘下拉（触发器 + 选项列表）
    ├── debug-log.ts           # 调试落盘（弹层几何快照 + 版本戳）
    ├── quote-bar.ts           # 引用/附件预览条
    ├── selection-popup.ts     # 选中悬浮条
    ├── speak-controller.ts    # 朗读控制 + 状态栏指示
    ├── open-in-editor.ts      # 内容导出为临时笔记并在编辑器打开
    ├── connection-checker.ts  # 连接状态检测
    ├── utils.ts               # token 估算 / diff / 版本比较 / 格式化
    ├── server.ts              # vault 基路径单例
    └── obsidian-ext.d.ts      # Obsidian 私有 API 类型补充
```

### 3.1 开发与构建

| 命令 | 作用 |
|------|------|
| `npm run build` | 一次性生产构建：`lint` + `tsc -noEmit` + esbuild（`production`，不监听、无 sourcemap）。用于提交前验证。 |
| `npm run dev` | 开发监听：esbuild `watch` 持续重编 `src/**`（含 inline sourcemap）；**额外监听 `styles.css`**。 |
| `npm run lint` | 仅跑 ESLint。 |

**CSS 热加载**：`styles.css` 不参与 esbuild 打包（由 Obsidian 直接读取原文件），
因此普通 watch 不会感知它的变化。`npm run dev` 在 dev 分支里额外 `fs.watch("styles.css")`，
文件变化（含防抖）后 touch 一次 `main.js`，借此触发 Obsidian 热加载插件重载，
使改样式后无需手动重启即可生效。生产构建（`npm run build`）不注册该监听。

---

## 4. 数据模型（types.ts）

### 4.1 Agent 注册表（核心新增）

```ts
export type AgentChannel = "api" | "cli";

export interface AgentConfig {
  /** 稳定标识，如 "agent-a" / "agent-c" / "agent-<ts>" */
  id: string;
  /** 显示名，用于 @ 路由与消息署名 */
  name: string;
  /** Obsidian 图标名（lucide），如 "sparkles" / "server" */
  avatar: string;
  /** 绑定通道 */
  channel: AgentChannel;
  /** 系统提示词 */
  systemPrompt: string;
  /** 是否启用（停用后不参与路由与列表） */
  enabled: boolean;
  /** 覆盖通道默认模型（留空 = 沿用通道默认） */
  model?: string;
  /** 是否为前台默认回答者（全局唯一） */
  isDefault?: boolean;
  /** 内置 Agent：可改名/改提示词，不可删除 */
  builtin?: boolean;
}
```

### 4.2 复用的既有模型

```ts
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  source: string;          // "user" | Agent 名
  thinking?: string;
  timestamp?: number;
}

export interface ChatSession {
  id: string; title: string; createdAt: number; updatedAt: number;
  /** 归属 Agent id；null / 省略 = 群聊会话（见 5.10） */
  ownerAgentId?: string | null;
}

export interface Attachment { name: string; type: string; data: string; size: number; }

export interface FileDiff {
  file: string; before: string; after: string;
  additions: number; deletions: number;
  status?: "added" | "deleted" | "modified";
}

export interface ModelCaps {
  text: boolean; image: boolean; pdf: boolean; audio: boolean; video: boolean;
  reasoning: boolean; toolcall: boolean; attachment: boolean; temperature: boolean;
}

export interface ModelEntry { id: string; displayName: string; }

export interface OpenCodeSettings {
  cliPath: string; autoStart: boolean; hostname: string;
  port: number; model: string; agent: string;
}

export interface ApiProviderConfig {
  id: string; name: string; baseUrl: string; model: string; apiKey: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningEffortAPI = "none" | "low" | "medium" | "high";
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SkillEntry { name: string; description: string; autoRunInterval?: number; }
export interface PromptTemplate { id: string; name: string; description: string; prompt: string; icon: string; }
```

### 4.3 插件设置总结构

```ts
export interface XiaoyuanAgentSettings {
  settingsVersion?: number;

  execMode: "api" | "cli";                  // 兼容保留（前台默认 = agents 里 isDefault 的通道）
  opencode: OpenCodeSettings;

  activeApiProviderId: string;
  apiProviders: ApiProviderConfig[];

  proxyEnabled: boolean;
  proxyUrl: string;
  defaultReasoning: ReasoningEffort;
  apiReasoningEffort: ReasoningEffortAPI;
  defaultPermission: PermissionMode;
  autoOpen: boolean;
  showContext: boolean;
  chatViewType: "left" | "right";

  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  chatHistoryPath: string;
  showDiffPreview: boolean;
  showThinking: boolean;
  maxAttachmentSize: number;
  captureCommandId: string;

  opencodeModels?: { label: string; value: string }[];
  opencodeModelCaps?: Record<string, ModelCaps>;
  opencodeAgents?: { id: string; name: string; description?: string }[];
  opencodeServerState?: { url: string; password: string };

  skills: SkillEntry[];
  promptTemplates: PromptTemplate[];

  /** ★ 多 Agent 注册表（取代 assistantA / assistantC） */
  agents: AgentConfig[];
}
```

### 4.4 默认值（constants.ts）

```ts
export const DEFAULT_AGENT_A: AgentConfig = {
  id: "agent-a", name: "小A", avatar: "sparkles", channel: "api",
  systemPrompt: "", // 由 i18n 填充
  enabled: true, isDefault: true, builtin: true,
};

export const DEFAULT_AGENT_C: AgentConfig = {
  id: "agent-c", name: "小C", avatar: "server", channel: "cli",
  systemPrompt: "",
  enabled: true, builtin: true,
};
```

其余默认值与源项目一致（端口 16226、温度 0.7、maxTokens 4096、
历史路径 `_xiaoyuanAgent/chatHistory`、7 个默认 Prompt 模板、7 个文本操作模板等）。

---

## 5. 模块设计

### 5.1 agent-registry.ts（核心增强）

职责：统一管理 Agent 列表的读取、校验、查询与增删改。

| 函数 | 说明 |
|------|------|
| `listAgents(s)` | 返回启用的 Agent（可选含停用） |
| `getAgentByName(s, name)` | 按显示名查找（@ 路由用） |
| `getAgentById(s, id)` | 按 id 查找 |
| `getDefaultAgent(s)` | 返回 isDefault 的 Agent；缺失时回退第一个启用的 |
| `getAgentForChannel(s, ch)` | 返回该通道下的内置/首个 Agent（CLI/API 面板署名用） |
| `ensureDefaultAgent(s)` | 保证有且仅有一个 isDefault；无启用 Agent 时兜底 |
| `createAgent(partial)` | 生成新 Agent（含唯一 id 与去重名） |
| `uniqueAgentName(s, base)` | 生成不与现有重名的名字（新 Agent 默认「小X」类） |
| `removeAgent(s, id)` | 删除（builtin 拒绝） |
| `canRemoveAgent(agent)` | 是否允许删除 |
| `resolveAgentTarget(text, s)` | 解析 `@名字` / `名字，` 前缀 → { agent, cleanText } |
| `extractAgentDelegations(text, s)` | 提取回复中的 `@其他Agent 任务` 用于后台委托 |
| `buildAgentMessages(...)` | 拼装多轮消息为单条 prompt（含「当前助手: X」标识） |

设计要点：
- 名字是路由主键，改名时必须同步校验唯一性。
- `isDefault` 全局唯一，任何改动后调用 `ensureDefaultAgent`。
- 至少保留一个启用 Agent；删除/停用最后一个需拦截。

### 5.2 直接调用 agent-registry（原 assistant-manager 已移除）

源项目里的 `assistant-manager.ts` **不再保留**：它的职责（路由 / 委托 / 消息拼装）
本身就是注册表的自然延伸，单独做一层转发只会增加间接层。
调用点（`chat-view.ts` / `ai.ts` / `settings.ts`）**直接引用 `agent-registry`** 的导出函数：

| 源项目用法 | 新项目对应 |
|------------|-----------|
| `getAssistantConfig(mode)` | `getAgentForChannel(s, ch)` / `getDefaultAgent(s)` |
| 解析 `@小A` / `@小C` | `resolveAgentTarget(text, s)` |
| 提取后台委托 | `extractAgentDelegations(text, s, self)` |
| 拼装 prompt | `buildAgentMessages(messages, sys, content, source)` |

这样调用链更短、无重复转发，符合「简单高效、不写冗余代码」的编码约定。

### 5.3 ai.ts（通道编排）

- `callAIWithHTTPStreaming()`：OpenCode v2 CLI 通道全流程（建会话 → SSE → prompt → 收尾 → diff）。
- `callAISession()`：统一入口，按 `channel` 参数或默认 Agent 决定走 CLI 还是 API，
  CLI 失败（非用户中断）自动降级 API。
- 保留：`buildModelRef` / `extractAssistantText` / `extractToolDiffs` /
  `buildWriteDiff` / `relativizePath` / `pushSessionDiffs` / `WriteSnapshot`。

### 5.4 opencode-client.ts / opencode-config.ts / opencode-server.ts / opencode-probe.ts

与源项目一致（v1→v2 适配、`/api` 前缀、`{location,data}` 信封、Basic 鉴权、
`service.json` 服务发现、端口兜底、进程树清理、接口自检）。仅重命名插件相关常量。

### 5.5 session.ts

- 会话文件：`<chatHistoryPath>/<sessionId>.md`
- Markdown 消息头：`**名字** (通道 · 时间):`，解析用正则通配名字（不写死），
  围栏代码块内的伪消息头/分隔线按正文处理。
- 话题分段：文件内用 `## 话题 <标题>`（或等价分隔行）标记话题边界，
  解析时识别为 `TopicSection`，**仅作展示分段**（详见 5.10）。
- 元数据：`xyag-sessions`（JSON 字符串）、`xyag-current-session`；
  会话索引条目新增 `ownerAgentId`（见 4.1 与 5.10）。
- 旧数据迁移 `migrateOldData`（含 `ownerAgentId` 缺省补全）。

### 5.6 chat-view.ts（聊天面板）

在源项目基础上：
- 头部模式选择器 → **Agent 切换器**（弹出启用的 Agent 列表，点选即设为前台默认；
  **切换不改动屏幕内容**，仅变更下一条消息的回答者，见 5.10 细节 1）。
- 头部新增**会话下拉菜单**：会话列表，**按 Agent 分组**（群聊 / 小A / 小C / …），
  见 5.10 细节 3。
- 每个 Agent 的「新建对话」入口（切到该 Agent 的独立会话线）。
- 输入框 `@` → 弹出**完整 Agent 列表**（图标 + 名字）。
- 消息头像/署名按 Agent 名从注册表解析。
- 其余（会话管理、流式渲染、思考折叠、工具进度、Diff 表格、附件、引用、
  右键操作、欢迎语、日期分隔、话题分段、截断、撤销）保持一致。

### 5.10 会话与上下文模型（多 Agent 增强核心）

> 本节是「多 Agent 在会话界面如何组织」的唯一事实来源。三条细节已确认。

**总原则：会话是一等公民，Agent 是会话的一个属性，话题是会话内的分段。**

#### 5.10.1 数据模型

```ts
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 归属 Agent id；null / 省略 = 群聊会话 */
  ownerAgentId?: string | null;
}

/** 会话内的话题分段（仅展示用，不影响上下文） */
export interface TopicSection {
  id: string;
  title: string;
  /** 该话题起始消息在会话消息数组中的下标 */
  startIndex: number;
}
```

- **群聊会话**：`ownerAgentId = null` → 会话列表归入「群聊」组。
- **Agent 独立会话**：`ownerAgentId = <agentId>` → 归入该 Agent 组。

#### 5.10.2 细节 1 — 切换前台 Agent 的行为（已确认：A / 不动）

- 切 Agent **只改「下一条消息由谁答」**（同步 `isDefault` 与 `execMode`），
  **屏幕与会话内容完全不动作**。
- 要进入某 Agent 的独立线，必须**显式**点「新建对话（以此 Agent）」；
  不做「切 Agent 自动跳线」的隐式行为，保证可预测。

#### 5.10.3 细节 2 — 话题的含义（已确认：A / 纯展示分段）

- 话题 = 会话内的一段**视觉分段**，用于让长会话更易读。
- **话题不切上下文**：拼装 prompt 时仍以整条会话（或 5.10.5 的规则）为准，
  不因为话题边界而丢弃历史。
- 分段方式：手动「新话题」按钮为主；（可选）按时间间隔自动提示分段。
- 段头在 UI 上表现为可折叠的 `话题标题` 分隔条。

#### 5.10.4 细节 3 — 会话列表（已确认：排法 A + 下拉菜单）

- **形态**：头部「历史」按钮弹出的**下拉菜单**，复用 §5.8.1 的统一弹层
  （位置/收边/点外面关闭/尺寸变化重排全部走同一套逻辑，不另起一套）。
  早先做过左侧可折叠抽屉，会常驻占掉聊天区宽度，故改回下拉。
- **结构不变**（和抽屉时期一致）：标题 / 搜索框 / 按 Agent 分组 / 每组一个「新建」/
  会话条目（切换、重命名、打开 md、删除）。条目操作按钮悬停才出现；
  选中会话或「新建」后菜单自动收起，重命名 / 删除时保持打开并原地重绘。
- **排法**：**按 Agent 分组**：
  ```
  群聊
    ├ 今天聊的这些
    └ 另一个话题
  小C
    └ 帮我查资料
  小A
    └ 写代码
  ```
- 组内按 `updatedAt` 倒序；**空组保留**（显示为「暂无对话」），
  这样每个 Agent 始终有「以此 Agent 新建对话」的入口，不会因无历史会话而失去入口。
- 当前会话高亮。
- 每条会话可右键：重命名 / 删除 / 复制链接 等（沿用源项目会话操作）。

#### 5.10.5 上下文拼装规则

- 拼装 prompt 时，以**当前会话的全部消息**为上下文基准（源项目行为），
  `source` 为任意 Agent 名或 `user` 的消息一律纳入。
- 后台委托产生的消息同样留在本会话，参与后续上下文。
- 若后续需要「访客 Agent 只看局部」等高级规则，作为增强项预留，本期不实现。

#### 5.10.6 与源项目的差异

| 项 | 源项目 | 新项目 |
|----|--------|--------|
| 会话归属 | 无概念 | `ownerAgentId`（群聊为 null） |
| 会话列表 UI | 顶部下拉 | 头部下拉菜单（复用统一弹层，带分组/搜索） |
| 会话列表分组 | 无（仅时间序） | 按 Agent 分组 |
| 话题分段 | 无 | `TopicSection`（纯展示） |
| 切 Agent 行为 | 仅改 execMode | 仅改前台回答者，屏幕不动 |
| 上下文 | 全会话 | 全会话（本期不变） |

### 5.7 settings.ts（设置面板，原风格）

详见第 6 节。

### 5.8 其余 UI 模块

`toolbar` / `action-bar` / `action-buttons` / `popup` / `quote-bar` /
`selection-popup` / `speak-controller` / `open-in-editor` / `modals`：
逻辑与源项目一致，类名统一 `xyag-` 前缀，文案走 `t()`。

### 5.8.1 popup.ts —— 统一样式 + 统一逻辑的弹层

**全插件只有一套弹层实现**：聊天界面、设置面板、会话菜单、模型选择器
全部调用 `popup.ts` 的 `showPopup()` / `addPopupItem()`，
外观（`.xyag-popup`）、定位规则、关闭逻辑完全一致，各处只管提供内容。

#### 宿主：弹层挂在哪儿

| 场景 | 宿主 | 定位方式 | 坐标系原点 |
|---|---|---|---|
| 聊天界面（无 modal） | 触发器所在 document 的 `body` | `position: fixed` | body 的盒子 |
| 设置面板（有 `.modal`） | 最近的 `.modal` | `position: absolute` | modal 的 padding box（减掉滚动量） |

> **弹层宿主必须是定位元素**。Obsidian 只在 `.modal-container` 里才给 modal 写
> `position: relative`；**弹出窗口（popout modal）**里 modal 是 `body` 的直接子元素，
> 这条规则不命中 → modal 是 `position: static` →
> 绝对定位的弹层会退回**以视口为参照**：位置全错（直接盖住选择框，看起来像「没对齐」），
> 而且不再被 modal 的 `overflow` 裁剪，能飘到设置窗口外面。
> 所以 `resolveHost()` 发现宿主是 `static` 时补一个 `position: relative`
> （无偏移的 relative 不影响布局，普通窗口里本来就是 relative）。

**算法内部一律用视口坐标算**，最后一步按宿主的原点换算过去
（`宿主坐标 = 视口坐标 − 宿主原点`），所以两种宿主出来的**外观和手感完全一致**，
只有「弹层的 DOM 节点住在哪」不同。

设置面板是 Obsidian 的 modal（`.modal-container > .modal.mod-settings.mod-sidebar-layout`），
把弹层挂进 modal 里有三个好处：

- **飘不出去**：`.modal` 是 `overflow: auto`，溢出部分**直接被裁掉**，
  「列表跑到设置窗口外面」在结构上就不可能发生 —— 光靠算范围去夹，
  一旦算错几个像素就会漏出去，还是裁掉来得踏实；
- **不会被挡住**：弹层成了 modal 的后代，一定盖在 modal 内容之上；
- **不会变成无主之物**：设置窗口关掉时弹层跟着一起消失，
  不会孤零零飘在工作区上（那看着就像「跑到设置窗口外面了」）。

> modal 是 `position: relative` 且**自己能滚**（`overflow: auto`），
> 绝对定位的子元素是**跟着内容一起滚**的 ——
> 所以宿主原点要减去 `scrollLeft/scrollTop`，否则弹层会整体偏移一截。

其余规则统一：

- **先量后排**：内容构建完 → 量自然高度 → 决定朝上还是朝下 → 再定坐标。
  定位完成前 `visibility: hidden`，避免弹层先落在容器底部再跳过来。
- **方向是偏好不是硬指定**：`direction` 取 `"down" / "up" / "auto"`。
  `"auto"`：下方放得下就向下（和系统下拉框一致），放不下看上方，
  两边都放不下就取宽敞的一侧、列表内部滚动；
  `"down" / "up"` 是首选侧，首选侧放不下且另一侧更宽裕时自动翻面。
- **活动范围 = 视口 ∩ 所在 modal ∩ modal 内的可见滚动区**：
  在 modal 里时把范围收到 modal 的盒子里（留 4px 边距）；
  再往里收一层「最近的裁剪祖先」（设置面板的标签页是 `overflow-y:auto` 的滚动容器），
  列表就不会压到弹窗标题栏上；不在 modal 里就用整个视口（左右各留 8px）。
  只认**面板级**的裁剪祖先（宽 ≥ 240 且高 ≥ 160）——
  设置项那一行也常带 `overflow: hidden`，拿它当边界会把弹层挤成一条缝。
- **高度按可用空间收**：上限取可用空间与 `maxHeight` 的较小值。
  `.xyag-popup` 是 `box-sizing: border-box`，`max-height` 就是**总高度**，
  因此算出的高度一定装得进可用空间 —— 列表在弹层内部滚动，不溢出屏幕、也不溢出 modal。
  > 这条是「没对齐」的根因：默认的 `content-box` 下 `max-height` 只管内容高度，
  > 加上内边距和边框后弹层会比可用空间高出十来像素，收边逻辑误判为溢出，
  > 就把弹层推离了触发器 —— 轻则看着没对齐，重则盖住触发器，
  > 「再点一次关掉」的那一下打在弹层上，表现为「必须选一项才能关掉」。
- **纵向永远贴着触发器**：`top` 直接由触发器的位置算出
  （向下 = 触发器下沿 + 2px；向上 = 触发器上沿 − 2px − 弹层高度），
  **绝不因为「放不下」就把弹层推离触发器**。
- **水平对齐**：默认左边缘与触发器对齐；右边放不下时改成**右边缘**与触发器对齐
  （向左展开），仍不越出活动范围。`matchWidth` 让弹层宽度跟随触发器，`minWidth` 兜底。
- **点外面就关闭**：用**捕获阶段**的 `pointerdown`，挂在**触发器所在的 document**
  （不是全局 `document`）上。设置面板里不少控件会吞掉冒泡，挂在冒泡阶段的话
  点击根本传不上来，弹层就怎么点都关不掉。点触发器本身不算「点外面」，
  由 `showPopup()` 的切换逻辑负责（再点一次收起）。
- **弹出窗口是另一份 document**：Obsidian 的 popout 窗口有自己的 `document` / `window`，
  而插件代码里的全局 `document` 永远指向主窗口。设置面板开在弹出窗口里时，
  挂到全局 document 上的 `pointerdown` / `scroll` / `keydown` 收不到那边的操作 ——
  表现为「点外面关不掉」「滚动后弹层不跟」「Esc 无效」。
  所以 `docOf()` / `winOf()` 一律按元素自己取，事件、`getComputedStyle`、
  `elementFromPoint`、`innerWidth/innerHeight`、`activeElement` 全部走它们。
- **内容变宽变高要重排**：弹层按内容自适应宽度，定位时算一次位置是不够的 ——
  模型列表展开「二级菜单」后出现更长的模型名，宽度涨上去，
  旧的左边缘还留在触发器左边，右边就顶出窗口了。
  所以 `ResizeObserver` 观察弹层本身，尺寸一变就重新贴一次；
  分组展开/收起另外主动派发 `xyag-popup-relayout`（同 tick 生效，不用等观察器）。
  条目文字是 `white-space: nowrap`，宽度不会被滚动条来回挤，观察不会自激。
  重排时若右边仍放不下：先把**右边缘**对齐触发器（向左展开），
  还把不住就按 `bounds.right - left` 收窄 `maxWidth` 并放开 `minWidth`（宁可窄也不溢出）。
- **监听跟着弹层走**：每个弹层自己记着自己挂的全局监听
  （`popupCleanups`），关闭时只注销自己那份。
  之前这些监听放在一个全局数组里，谁关闭都顺手把全家的清了 ——
  设置窗口关掉时弹层会被 DOM 带走（节点没了但监听还在），
  下一个弹层打开再一关，就把**新弹层**的监听也一起注销了，
  于是新弹层「点外面关不掉」。
- **点击隔离**：弹层内的 `click/mousedown` 一律 `stopPropagation`，
  避免 Obsidian「点到 modal 外面就关掉」把设置面板一起关掉。
- 关闭统一走 `closePopup()`（再点触发器 / 点外面 / 选中条目三条路径），
  `onClose` 只回调一次；`Esc` 关闭，方向键在列表内导航。
- **跟随滚动**：触发器所在容器滚动 / 窗口缩放时重新贴一次，弹层不跟着漂走。
- **可折叠分组只有一套实现**：`addPopupSection(popup, label, { collapsed })`，
  标题 + 箭头 + 折叠都在这儿，展开 / 收起会派发 `xyag-popup-relayout` 重排。
  模型列表按 provider 分组用 `collapsed: true`（默认收起，点开才出模型名）。
- **内容构建可以是异步的**：`buildContent` 返回 Promise 时（比如连接列表要先探测），
  弹层保持在 `visibility: hidden`，等 promise 落地再定位 + 显示，不闪空壳；
  promise 失败就把空壳收掉，不会留一个点不掉的空弹层。
- **调试快照**（`debug-log.ts`）：弹层在 modal 里打开 / 重排时做一次**几何自检**，
  **只在看着不对时才落盘**（盖住触发器 / 没贴住 / 横向纵向越界 /
  宿主是 `static` / 被别的元素挡住），连同触发器、宿主、活动范围、
  弹层盒子的真实几何与祖先链写进插件目录的 `xyag-popup-debug.json`。
  正常打开下拉框什么都不写 —— 插件目录在同步盘里，写一次同步一次，
  天天看到这个文件变动很烦；真出问题时现场又会自动留下来。
  插件每次加载还会写一份 `xyag-build.json`（版本号 + 加载时间），
  用来确认「用户那边跑的到底是不是新包」。
  > 调试文件优先走 Obsidian 自己的 `vault.adapter.write`，
  > 插件目录读写权限、路径转义都由 Obsidian 兜底，比裸用 `fs` 稳。

### 5.8.2 model-select.ts / select-list.ts —— 自绘下拉框

设置面板**一律不用原生 `<select>`**，包括 Obsidian 的 `DropdownComponent`
（它底层就是 `<select class="dropdown">`）和手写的 `createEl("select")`：

> 原生下拉的选项列表由**操作系统单独开窗渲染**，既不受主题控制，
> 也完全不受设置弹窗的边界约束 —— 列表会直接飘到设置窗口外面去。
> 聊天界面全是自绘控件，所以那边不会出现这个问题。

- `model-select.ts`：`createSelectTrigger()` 只做外观（边框/圆角/箭头）与键盘
  （Enter/Space/↓ 展开，↑↓ 选择，Esc 关闭），列表内容由调用方提供。
- `select-list.ts`：`createSelectField()` 是通用版本 —— 触发器 + 选项列表，
  设置面板的 Agent / 思考强度 / 权限 / 模式 / 抓取命令 / 聊天位置 /
  头像 / 通道 / 技能间隔等全部走它。
- 选项列表由 `model-picker.ts` 提供 —— 设置面板与聊天工具栏共用同一份模型列表内容。

### 5.9 main.ts（入口装配）

- 加载设置 + 旧数据迁移（`assistantA/assistantC` → `agents[]`）。
- 注册视图 `xyag-agent-view`、状态栏朗读指示、Ribbon 图标。
- 命令：切换面板、新建对话、用当前笔记对话、动态 skill 命令。
- 编辑器右键菜单：文本操作模板子菜单。
- 全局 `mouseup`：Markdown 选中悬浮条。
- 定时 skill 任务（每分钟检查 `autoRunInterval`）。
- 自动启动 OpenCode Server、自动打开面板、清理临时文件。
- `onunload`：停朗读、清 Key、detach 视图、停服务。

---

## 6. 设置面板设计（原风格 + 小幅优化）

### 6.1 顶部状态卡片（沿用原风格）

6 行实时状态：CLI 状态 / OpenCode 版本 / API 状态 / CLI 模型 / API 模型 / OpenCode 代理，
底部「刷新」按钮（同时同步模型与 Agent 列表）。版本主号非 2 或高于已验证版本时显示告警条。

### 6.1.1 代理设置的作用范围

「启用 OpenCode 代理」+「OpenCode 代理地址」**仅作用于插件拉起的 opencode 子进程**：

- `opencode-server.ts` 的 `setProxyConfig()` 收下配置，`buildChildEnv()` 在
  `spawnWithTimeout()` / `startTempOpenCodeServer()` 时把 `HTTP_PROXY` / `HTTPS_PROXY`
  （大小写两套）注入子进程环境变量；同时写入 `NO_PROXY` 豁免 `127.0.0.1` /
  `localhost` / `::1`，避免插件连自己刚拉起的服务也被送去代理。
- **API 通道不走这条路径**：`api-client.ts` 用裸 `fetch()`，插件自身进程的 env 从不被修改，
  全局也无 `dispatcher` / `setGlobalDispatcher` 拦截。API 通道是否经代理由系统层决定
  （代理程序的 TUN / 虚拟网卡模式会全局接管），插件层面不介入。
- 开关与地址必须同时有值才生效（`proxyEnabled && proxyUrl`）；设置保存后立即同步，
  无需重启。已在运行的 opencode 子进程持有旧环境变量，需重启该服务才会用上新地址。

### 6.2 Tab 栏（原风格 + 1 个新 Tab）

| Tab | 图标 | 内容 |
|-----|------|------|
| 通用 | `settings` | 默认 Agent、OpenCode 代理开关/地址（见 §6.1.1）、启动打开、捕获命令、聊天路径、面板位置、Diff、思考、附件上限、上下文 |
| CLI | `terminal-square` | 路径(+检测)、自动启动、Host、Port、模型(下拉框 +↻)、模型能力、Agent(+↻)、思考强度、文件权限、接口自检 |
| API | `key-round` | Provider 卡片列表（启用/测试/删除/新增）、Base URL/模型/Key、思考强度、温度、最大 token |
| **Agents** | `users` | **新增**：Agent 管理卡片 |
| Skills | `wand-sparkles` | AGENTS.md 生成/编辑、Skills 列表表 + 自动执行间隔 |
| Prompt | `file-pen` | 模板折叠卡片（恢复默认/删除/新增） |
| 关于 | `info` | 版本/描述/作者/协议/依赖/GitHub |

> **所有下拉都是自绘的**（`.xyag-select`）：不使用 `DropdownComponent`，
> 也不手写 `<select>` —— 原生选项列表由操作系统开窗渲染，会飘到设置窗口外面。
> 详见 §5.8.2。

### 6.3 Agents Tab 卡片设计（新增）

每个 Agent 一张卡片（样式复用 `.xyag-api-provider-row`）：

```
┌───────────────────────────────────────────────┐
│ [图标] 小A   · API通道        [启用][设为默认][删除] │  ← head（可折叠）
├───────────────────────────────────────────────┤
│ 名称        [___________]                      │
│ 头像图标    [dropdown ▾]                       │
│ 通道        [API ▾ / OpenCode ▾]               │
│ 模型        [___________] (留空=通道默认)       │
│ 系统提示词  [textarea]                          │
└───────────────────────────────────────────────┘
[+ 新增 Agent]
```

交互：
- `启用` = 切换 `enabled`（内置也允许停用，但至少保留 1 个启用）。
- `设为默认` = 把 `isDefault` 移给该 Agent（自动清除其它）。
- `删除` = builtin 禁用（tooltip 说明）；非内置二次确认。
- 改名实时更新卡片标题，并校验重名（重名时提示并拒绝保存）。

### 6.4 「小幅优化」清单

1. Tab 栏激活项加轻微投影/加粗，提升可读性（不改配色体系）。
2. 状态卡片「刷新」按钮旁增加同步时间戳提示。
3. Agents Tab 卡片头部显示通道徽标（API / OpenCode 不同色调）。
4. 空状态（无 Skill / 无模板 / 无额外 Agent）给出引导文案。
5. 所有 `Setting` 都经 `decorateSetting` 加图标，风格统一。

### 6.5 样式复用

源项目 CSS 结构整体迁移，类名批量替换 `xy-` / `xiaoyuan-` → `xyag-`；
保留 Obsidian 主题变量（`--background-secondary`、`--interactive-accent` 等），
保证明暗主题自适应。

---

## 7. 国际化（i18n）

- `i18n.ts` 读取 `localStorage.language` / `navigator.language`，zh 开头→zh，否则 en。
- `locales/zh.json` 与 `locales/en.json` 键完全对齐（源项目 331 键基础上，
  新增 Agent 管理相关键，删除 assistantA/C 专属冗余）。
- 默认 Agent 名称与系统提示词跟随语言（`loadSettings` 时按 `t()` 补全）。
- 内置文本操作模板的 name/desc/prompt 跟随语言（与源项目同策略）。

新增词条（示例）：`setting.agents.title`、`setting.agents.add`、`setting.agents.enable`、
`setting.agents.setDefault`、`setting.agents.delete`、`setting.agents.channel`、
`setting.agents.model`、`setting.agents.modelHint`、`setting.agents.nameTaken`、
`setting.agents.keepOne`、`setting.agents.builtinTip`、`chat.agent.switcher` 等。

会话与话题相关新增词条：`chat.session.group.chat`（群聊）、`chat.session.newWithAgent`
（以此 Agent 新建对话）、`chat.session.menuTitle`（对话记录）、`chat.topic.new`（新话题）、
`chat.topic.untitled`（未命名话题）、`chat.topic.collapse` / `chat.topic.expand` 等。

---

## 8. 样式规范（styles.css）

- 前缀：全部 `xyag-`（含视图容器、消息、工具栏、弹层、设置、Diff、Skill popup 等）。
- 复用源项目分层结构：Chat / Messages / Toolbar / Popup / Selection / Modal /
  Settings / Diff / Skill Popup / Responsive。
- 不写死颜色，统一走 Obsidian CSS 变量。
- 保留代码块复制按钮、表格横向滚动包裹、diff 表格配色、思维链折叠样式。

---

## 9. 实施顺序（供编码阶段执行）

1. **脚手架**：`manifest.json`、`package.json`、`esbuild.config.mjs`、
   `tsconfig.json`、`eslint.config.mjs`。
2. **基础设施**：`types.ts`、`constants.ts`、`i18n.ts`、`locales/*.json`、
   `utils.ts`、`server.ts`、`obsidian-ext.d.ts`。
3. **Agent 内核**：`agent-registry.ts`。
4. **通道层**：`api-client.ts`、`opencode-client.ts`、`opencode-config.ts`、
   `opencode-server.ts`、`opencode-probe.ts`、`ai.ts`。
5. **会话与附件**：`session.ts`、`attachment.ts`、`connection-checker.ts`。
6. **聊天 UI**：`chat-view.ts`、`toolbar.ts`、`action-bar.ts`、`action-buttons.ts`、
   `popup.ts`、`quote-bar.ts`、`selection-popup.ts`、`speak-controller.ts`、
   `open-in-editor.ts`、`modals.ts`。
7. **设置面板**：`settings.ts`（原风格 + Agents Tab）。
8. **入口装配**：`main.ts`。
9. **样式**：`styles.css`。
10. **构建验证**：`npm run build`（lint + tsc + esbuild）通过。
11. **文档**：`README.md` 中英双语。

---

## 10. 验收清单

- [ ] manifest 正确，插件可被 Obsidian 加载、启用、卸载无残留。
- [ ] 设置面板 7 Tab 全部可用，风格与源项目一致（`xyag-` 前缀）。
- [ ] 多 Agent：内置 2 个 + 可新增，增删改/启用/默认/通道/模型/头像/提示词均生效。
- [ ] `@名字` 路由正确；前台回复 `@对方` 触发后台委托并冒泡。
- [ ] 聊天：多会话、搜索、重命名、删除、日期分隔、欢迎语正常。
- [ ] 会话模型：默认群聊；可指定 Agent 新建独立对话；会话列表**按 Agent 分组**的**头部下拉菜单**。
- [ ] 切 Agent 不改动屏幕内容（仅改前台回答者）；「新建对话（以此 Agent）」才进入独立线。
- [ ] 话题：可新建话题分段并在会话内折叠展示，且**不影响上下文**。
- [ ] 流式：CLI（OpenCode v2 SSE）与 API（OpenAI SSE）均可用，思考与工具进度显示正确。
- [ ] Diff 预览（含非 git 仓库 write 快照兜底）正常。
- [ ] 附件、引用、复制、朗读、捕获、选中悬浮条、右键文本操作正常。
- [ ] Skills：AGENTS.md 生成/编辑、列表同步、定时执行、`/skill` `/template:` 触发正常。
- [ ] OpenCode：服务发现/自建/端口兜底/鉴权/接口自检/代理 正常。
- [ ] 中英双语切换无缺键（zh/en 键完全对齐）。
- [ ] `npm run build` 无错误。
- [ ] 旧数据（若存在 assistantA/assistantC）自动迁移为 agents[]。

---

## 11. 待讨论问题（Q&A）

> 已确认：全部按下述「建议」执行。

### Q1. `execMode` 与「默认 Agent」的关系 — ✅ 按建议
保留 `execMode` 字段仅作兼容与回退，实际以前台 Agent 的 `channel` 为准；
切换前台 Agent 时同步写 `execMode`。

### Q2. 新 Agent 的命名与头像默认值 — ✅ 按建议
默认名「小D / 小E…」按序递增，默认头像 `bot`，
默认通道沿用当前前台 Agent 的通道。
（内置固定为 `小A` / `小C`；后续新增从「小D」开始。）

### Q3. Agent 与模型的绑定粒度 — ✅ 按建议
Agent 的 `model` 只覆盖「该通道默认模型」。
CLI 通道模型是 `providerID/modelID`，API 通道是 `provider.model`。
Agents Tab 的「模型」输入框为**文本框**，按通道给不同 placeholder 与候选提示，
留空 = 沿用通道默认模型。

### Q4. 停用/删除最后一个启用 Agent — ✅ 按建议
硬拦截，至少保留 1 个启用 Agent；删除非内置 Agent 弹确认框。

### Q5. 后台委托的并行上限 — ✅ 按建议
加并发上限 **3** 与超时，避免多 Agent 场景下请求风暴。

### Q6. 会话文件里 Agent 名称的处理 — ✅ 按建议
保持原策略（不回溯改名），历史以写入时名字为准。

### Q7. 设置面板 Tab 是否改为「纵向」或分组 — ✅ 按建议
保持横向 + `flex-wrap`，不改纵向。

### Q8. 是否需要「导入 xiaoyuanAI 配置」功能 — ✅ 按建议
本期不做；作为后续增强预留。

### Q9. opencode-probe / 自检项是否扩展 — ✅ 按建议
维持源项目 7 项探测，不改接口契约。

### Q10. 版本号与许可证 — ✅ 已确认
`1.0.0`，MIT，作者 **XiaoYuan**。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| OpenCode v2 小版本破坏性变更 | 聊天失败 | 保留 events 归一化 + 接口自检 + 未验证提示 |
| 多 Agent 请求风暴 | 性能/额度 | Q5 的并发上限与超时 |
| 名字改重导致路由歧义 | 路由错乱 | 改名唯一性校验 + 编辑即提示 |
| CSS 前缀遗留 | 样式冲突 | 全量替换并 grep 校验无 `xy-`/`xiaoyuan-` 残留 |
| 旧数据迁移遗漏 | 设置丢失 | `loadSettings` 显式迁移 + 兜底默认 Agent |

---

## 13. 附录：源项目功能对照表（复刻清单）

| 源项目模块 | 新项目对应 | 变化 |
|------------|-----------|------|
| assistantA/assistantC 字段 | agents[] 注册表 | **升级为多 Agent** |
| 双助手 @ 路由 | 多 Agent @ 路由 | 扩展 |
| 后台委托 | 多 Agent 后台委托 | 扩展（加并发控制） |
| 设置 6 Tab | 设置 7 Tab（+Agents） | 新增 |
| chat-view 模式选择器 | Agent 切换器 | 升级 |
| 会话（无归属概念） | 会话带 `ownerAgentId`（群聊 / Agent 独立） | 升级 |
| 会话列表（顶部下拉） | 头部下拉菜单 + 按 Agent 分组（复用统一弹层） | 升级 |
| （无话题概念） | 会话内「话题」分段（纯展示） | 新增 |
| 其余（通道/会话/UI/样式/i18n） | 一一对应 | 前缀与文案调整 |

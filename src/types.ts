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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** "user" | Agent 名 */
  source: string;
  thinking?: string;
  timestamp?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 归属 Agent id；null / 省略 = 群聊会话（见 DESIGN.md 5.10） */
  ownerAgentId?: string | null;
}

/** 会话内的话题分段（仅展示用，不影响上下文） */
export interface TopicSection {
  id: string;
  title: string;
  /** 该话题起始消息在会话消息数组中的下标 */
  startIndex: number;
  /**
   * 话题结束位置（不含该下标对应的消息）。
   * 省略 / undefined 表示话题一直延续到下一个话题或会话结束。
   */
  endIndex?: number;
}

export interface Attachment {
  name: string;
  type: string;
  data: string;
  size: number;
}

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  /** OpenCode v2 `FileDiff.Info.status` */
  status?: "added" | "deleted" | "modified";
}

export interface ModelCaps {
  text: boolean;
  image: boolean;
  pdf: boolean;
  audio: boolean;
  video: boolean;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
  temperature: boolean;
  /** 模型支持的推理变体（v2 的 `Variant.Info.id`，如 low / medium / high） */
  variants?: string[];
}

export interface ModelEntry {
  id: string;
  displayName: string;
}

export interface OpenCodeSettings {
  cliPath: string;
  autoStart: boolean;
  hostname: string;
  port: number;
  model: string;
  agent: string;
}

export interface ApiProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningEffortAPI = "none" | "low" | "medium" | "high";
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SkillEntry {
  name: string;
  description: string;
  autoRunInterval?: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
}

/** OpenCode v2 SSE 事件负载 (`{id, created, type, location?, data}`) */
export interface OpenCodeEventData {
  sessionID?: string;
  /** 兼容可能的字段改名 */
  sessionId?: string;
  assistantMessageID?: string;
  assistantMessageId?: string;
  messageID?: string;
  ordinal?: number;
  delta?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  executed?: boolean;
  content?: { type?: string; text?: string }[];
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  [key: string]: unknown;
}

/** OpenCode v2 SSE 事件帧 */
export interface OpenCodeEvent {
  id?: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  data?: OpenCodeEventData;
}

/** OpenCode v2 `Agent.Info` */
export interface OpenCodeAgentInfo {
  id: string;
  name?: string;
  description?: string;
  mode?: "subagent" | "primary" | "all" | string;
  hidden?: boolean;
}

/** 插件自建 OpenCode 实例的连接信息（url + 随机密码） */
export interface OpenCodeServerState {
  url: string;
  password: string;
}

export interface XiaoyuanAgentSettings {
  /** 设置结构版本号（新项目起点为 1）。 */
  settingsVersion?: number;

  /** 兼容保留：实际以前台 Agent（isDefault）的 channel 为准（见 DESIGN.md Q1）。 */
  execMode: AgentChannel;

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
  opencodeAgents?: OpenCodeAgentInfo[];

  /**
   * 插件自建 OpenCode 实例的连接信息。
   * 插件重载 / Obsidian 重启后，如果这个实例还在跑，就直接复用它
   * （密码是随机生成的，不记下来的话就没法认证）。
   */
  opencodeServerState?: OpenCodeServerState;

  skills: SkillEntry[];
  promptTemplates: PromptTemplate[];

  /** ★ 多 Agent 注册表（取代源项目的 assistantA / assistantC） */
  agents: AgentConfig[];

  /** 上次自动接口自检时检测到的 OpenCode 版本（用于版本变更时自动触发自检） */
  lastAutoProbeOpenCodeVersion?: string;
}

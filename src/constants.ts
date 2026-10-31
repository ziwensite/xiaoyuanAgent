import type {
  OpenCodeSettings,
  XiaoyuanAgentSettings,
  ApiProviderConfig,
  PromptTemplate,
  AgentConfig,
} from "./types";

/** Agent 头像可选图标（lucide） */
export const AGENT_AVATARS = [
  "sparkles",
  "server",
  "bot",
  "brain",
  "code",
  "pen-tool",
  "book-open",
  "search",
  "wand-sparkles",
  "lightbulb",
] as const;

/** 内置 Agent 的稳定 id */
export const BUILTIN_AGENT_A_ID = "agent-a";
export const BUILTIN_AGENT_C_ID = "agent-c";

/**
 * OpenCode 默认端口。
 * 之前这个值在 `opencode-client.ts` / `opencode-server.ts` / `opencode-config.ts`
 * 里各硬编码一份，改一处漏两处就会连到错误端口。统一从这里引用。
 */
export const DEFAULT_OPENCODE_PORT = 16226;

/** 仅允许连接本机的 OpenCode 服务：请求会带上 Basic 鉴权头，不能发给远端 */
export const OPENCODE_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/** 单轮 AI 回复的总超时（毫秒） */
export const AI_REPLY_TIMEOUT_MS = 5 * 60 * 1000;
/** 普通 API 请求（等待响应头）的超时（毫秒） */
export const API_REQUEST_TIMEOUT_MS = 60 * 1000;
/** 历史裁剪后允许占用的上下文比例 */
export const CONTEXT_TRIM_RATIO = 0.75;
/** 引用进上下文的笔记内容最大长度（字符） */
export const CONTEXT_SNIPPET_MAX = 2000;
/** API 状态探测结果的缓存时长（毫秒） */
export const API_STATUS_CACHE_MS = 60 * 1000;
/** 单次 OpenCode 服务启动的超时（毫秒） */
export const OPENCODE_START_TIMEOUT_MS = 15000;
/** 端口顺延的最大尝试次数 */
export const OPENCODE_PORT_FALLBACK_ATTEMPTS = 8;
/** 自建 opencode 实例放行的来源：Obsidian 渲染进程就是这个 origin */
export const OPENCODE_CORS_ORIGIN = "app://obsidian.md";

/**
 * 默认 Agent（内置两个）。
 * systemPrompt 留空，由 `loadSettings` 按当前语言用 i18n 填充（见 DESIGN.md §7）。
 */
export const DEFAULT_AGENT_A: AgentConfig = {
  id: BUILTIN_AGENT_A_ID,
  name: "小A",
  avatar: "sparkles",
  channel: "api",
  systemPrompt: "",
  enabled: true,
  isDefault: true,
  builtin: true,
};

export const DEFAULT_AGENT_C: AgentConfig = {
  id: BUILTIN_AGENT_C_ID,
  name: "小C",
  avatar: "server",
  channel: "cli",
  systemPrompt: "",
  enabled: true,
  builtin: true,
};

export const DEFAULT_AGENTS: AgentConfig[] = [DEFAULT_AGENT_A, DEFAULT_AGENT_C];

export const DEFAULT_OPENCODE_SETTINGS: OpenCodeSettings = {
  cliPath: "opencode",
  // v2 起 CLI 通道必须连一个常驻的 `opencode serve`，否则完全无法工作，
  // 因此默认开启自动启动。
  autoStart: true,
  hostname: "127.0.0.1",
  port: DEFAULT_OPENCODE_PORT,
  model: "",
  agent: "build",
};

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "polish", name: "润色", description: "改进表达、语法和流畅度", prompt: "你是一个文字润色助手。请润色以下文本，改进表达、语法和流畅度，保持原意不变。只输出润色后的结果，不要添加任何解释：\n\n", icon: "pencil" },
  { id: "summarize", name: "总结", description: "提取关键要点", prompt: "你是一个总结助手。请对以下文本进行简洁的总结，提取关键要点。用中文总结，只输出总结内容：\n\n", icon: "file-text" },
  { id: "complete", name: "补全", description: "根据上下文自然补全内容", prompt: "你是一个写作助手。请根据上下文，自然地补全以下内容，保持风格一致：\n\n", icon: "check" },
  { id: "expand", name: "扩写", description: "增加细节和深度", prompt: "你是一个写作助手。请扩写以下内容，增加细节、例子和深度，保留原文的核心观点：\n\n", icon: "maximize" },
  { id: "continue", name: "续写", description: "自然地续写内容", prompt: "你是一个写作助手。请根据以下内容自然地续写，保持风格一致：\n\n", icon: "arrow-right" },
  { id: "translate", name: "翻译为中文", description: "将文本翻译成中文", prompt: "你是一个翻译助手。请将以下文本翻译成中文，保持专业性和流畅度：\n\n", icon: "languages" },
  { id: "translate-en", name: "翻译为英文", description: "将文本翻译成英文", prompt: "你是一个翻译助手。请将以下文本翻译成英文，保持专业性和流畅度：\n\n", icon: "languages" },
];

/** 内置模板 id（顺序即展示顺序） */
export const BUILTIN_TEMPLATE_IDS = DEFAULT_PROMPT_TEMPLATES.map((t) => t.id);

export const DEFAULT_SETTINGS: XiaoyuanAgentSettings = {
  settingsVersion: 1,
  // 兼容字段，加载后由 ensureDefaultAgent 同步为默认 Agent（小A，api）的通道。
  // 初值与 DEFAULT_AGENT_A.channel 保持一致，避免首次渲染时状态不自洽。
  execMode: "api",

  opencode: { ...DEFAULT_OPENCODE_SETTINGS },

  activeApiProviderId: "",
  apiProviders: [
    { id: "default", name: "默认 API", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", models: ["gpt-4o"], apiKey: "" },
  ],

  proxyEnabled: false,
  proxyUrl: "",
  defaultReasoning: "low",
  apiReasoningEffort: "none",
  defaultPermission: "read-only",
  autoOpen: true,
  showContext: false,
  chatViewType: "right",

  systemPrompt: "",
  maxTokens: 4096,
  temperature: 0.7,
  chatHistoryPath: "_xiaoyuanAgent/chatHistory",
  showDiffPreview: true,
  showThinking: true,
  maxAttachmentSize: 10,
  captureCommandId: "",
  promptTemplates: [...DEFAULT_PROMPT_TEMPLATES],
  skills: [],
  agents: DEFAULT_AGENTS.map((a) => ({ ...a })),
};

export function getActiveProvider(s: { apiProviders: ApiProviderConfig[]; activeApiProviderId: string }): ApiProviderConfig | undefined {
  if (s.activeApiProviderId) return s.apiProviders.find((p) => p.id === s.activeApiProviderId);
  return s.apiProviders[0];
}

export const CHAT_SESSIONS_KEY = "xyag-sessions";
export const CURRENT_SESSION_KEY = "xyag-current-session";
export const VIEW_TYPE_XIAOYUAN_AGENT_CHAT = "xyag-agent-view";

/** 后台委托并发上限（见 DESIGN.md Q5） */
export const DELEGATION_CONCURRENCY = 3;
/** 后台委托超时（毫秒） */
export const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 插件最后一个完整验证过的 OpenCode 版本。
 *
 * 插件适配的是 **v2 服务端 API 契约**，不是某个具体的小版本：
 * 只要主版本是 2 就会尝试连接。但 v2 的次版本升级也出现过破坏性变更
 * （例如 2.0.x → 2.1.x 换掉了整套接口路径与事件名），所以当检测到的版本
 * 比这个值更新时，状态卡片会给出「未验证」的软提示，而不是直接报「不兼容」。
 */
export const VERIFIED_OPENCODE_VERSION = "2.1.2";

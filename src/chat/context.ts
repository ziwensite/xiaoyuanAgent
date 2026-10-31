import type { App } from "obsidian";
import type XiaoyuanAgentPlugin from "../main";
import type { ChatMessage, ChatSession, FileDiff, Attachment, AgentConfig, TopicSection } from "../types";

/** 一个话题折叠块的 DOM 引用集合 */
export interface TopicBlock {
  el: HTMLElement;
  details: HTMLDetailsElement;
  summary: HTMLElement;
  body: HTMLElement;
}

/** 工具栏需要的宿主能力（见 `toolbar.ts`） */
export interface ToolbarHost {
  plugin: XiaoyuanAgentPlugin;
  abortController: AbortController | null;
  pickFiles(): void;
  sendMessage(): void;
  syncOpenCodeState(opts?: { force?: boolean; silent?: boolean }): Promise<void>;
}

/**
 * 聊天视图拆分后各子模块共享的宿主契约。
 *
 * `XiaoyuanAgentChatView` 实现这个接口，把自己传给 `chat/*.ts`。这样：
 * - 子模块只依赖这一小份契约，不用反向 import 视图类（避免循环依赖）；
 * - 跨模块调用（如会话模块要重绘头部）走 `ctx.xxx()`，由主类的薄委托转发，
 *   子模块之间因此无需互相 import。
 *
 * 拆之前这里是一个 2000+ 行的单体类，改动一个渲染细节要在整文件里翻。
 */
export interface ChatCtx extends ToolbarHost {
  app: App;
  plugin: XiaoyuanAgentPlugin;

  // ─── 会话 / 消息状态 ────────────────────────────────────────────
  messages: ChatMessage[];
  lastDateKey: string;
  sessions: ChatSession[];
  currentSessionId: string;
  /** 会话内的话题分段（仅展示，不影响上下文） */
  topics: TopicSection[];
  /** 当前话题的 body 容器；后续消息追加到这里（为 null 则追加到 messagesEl） */
  currentTopicBody: HTMLElement | null;
  /** 当前活跃话题（未结束的那个） */
  currentTopicSection: TopicSection | null;
  /** 当前活跃话题的 DOM 外壳（用于结束话题时清理空话题） */
  currentTopicEl: HTMLElement | null;
  msgIdCounter: number;
  /**
   * 当前正在流式输出的消息 id。
   * 定型时必须用它而不是「最后一条消息」：后台委托会在前台流式期间往末尾插消息。
   */
  streamingMessageId: string | null;
  /** 保存串行化链：见 `saveCurrentSession` */
  saveChain: Promise<void>;
  /** 工具事件可能早于流式消息创建到达，先缓冲，等消息节点建好再补 */
  pendingToolLogs: { tool: string; status: string }[];
  pendingDiffs: FileDiff[] | null;

  // ─── DOM 引用 ───────────────────────────────────────────────────
  viewContainer?: HTMLDivElement;
  messagesEl: HTMLDivElement;
  thinkingBarEl: HTMLDivElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLSpanElement;
  toolbarEl: HTMLDivElement;
  /** 输入框上方工具条右侧的上下文状态容器（CLI 通道才有内容） */
  contextBarEl?: HTMLDivElement;
  /** 工具栏「当前笔记」chip；无活动笔记时为 null */
  noteChipEl?: HTMLElement | null;
  agentSelector: HTMLSpanElement;
  connectionStatusEl: HTMLSpanElement | null;
  openCodeEl: HTMLSpanElement;
  attachPreviewEl: HTMLDivElement;
  /** 会话下拉菜单的弹层；收起时为 null。 */
  sessionMenuEl: HTMLDivElement | null;

  // ─── 输入区 / 状态灯状态 ─────────────────────────────────────────
  attachments: Attachment[];
  quoteText: string;
  skillIndex: number;
  openCodeStatus?: boolean;
  apiStatus?: boolean;
  apiProbeAt: number;

  /** 前台 Agent（不 @ 时由它回答） */
  readonly foreground: AgentConfig | undefined;

  // ─── 跨模块回调（主类以薄委托实现） ────────────────────────────────
  addMessage(role: "user" | "assistant", content: string, source?: string): Promise<void>;
  addSystemMessage(text: string): HTMLDivElement;
  quote(text: string): void;
  openInEditor(content: string, ts?: number): Promise<void>;
  showAIToolsForContent(content: string, e: MouseEvent): void;
  capture(text: string): void;
  undoMessage(id: string): void;
  renderQuoteBar(): void;
  renderConversation(): Promise<void>;
  saveCurrentSession(): Promise<void>;
  updateSessionTitle(): void;
  switchSession(sessionId: string): Promise<void>;
  newChatWith(ownerId: string | null): Promise<void>;
  newChat(): Promise<void>;
  createNewSession(ownerId: string | null): void;
  renderSessionMenu(): void;
  closeSessionMenu(): void;
  updateAgentSelector(): void;
  updateAgentBorderClass(): void;
  rebuildToolbar(opts?: { skipSync?: boolean }): void;
  probeApiStatus(): Promise<void>;
  setOpenCodeStatus(ok: boolean): void;
  setApiStatus(ok: boolean): void;
  setProcessingState(processing: boolean): void;
  addStreamingMessage(content: string, thinking?: string, source?: string): string;
  updateStreamingMessage(messageId: string, content: string): void;
  updateStreamingThinking(messageId: string, thinking: string): void;
  addToolLogEntry(messageId: string, toolName: string, status: string): void;
  finalizeStreamingMessage(messageId?: string): Promise<string | null>;
  truncateMessagesIfNeeded(): Promise<void>;
  renderDiffs(messageId: string, diffs: FileDiff[]): void;
  addTopic(title: string): Promise<void>;
  endCurrentTopic(): Promise<void>;
  deleteTopic(section: TopicSection): Promise<void>;
  sendPrefilled(text: string): Promise<void>;
  setInputValue(text: string): void;
}

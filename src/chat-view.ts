import { ItemView, WorkspaceLeaf } from "obsidian";
import type XiaoyuanAgentPlugin from "./main";
import type { ChatMessage, ChatSession, FileDiff, Attachment, AgentConfig, TopicSection } from "./types";
import { VIEW_TYPE_XIAOYUAN_AGENT_CHAT } from "./constants";
import { registerSelectionListener } from "./selection-popup";
import { getDefaultAgent } from "./agent-registry";
import { t } from "./i18n";
import type { ChatCtx } from "./chat/context";
import * as renderer from "./chat/renderer";
import * as sessionController from "./chat/session-controller";
import * as headerView from "./chat/header-view";
import * as inputView from "./chat/input-view";
import * as streamController from "./chat/stream-controller";

/**
 * 聊天视图主类 —— 薄编排层。
 *
 * 拆分后这里只保留：状态字段、生命周期（onOpen/onClose）、以及把调用转发到
 * `chat/*.ts` 的委托。具体逻辑在这些子模块里：
 * - `chat/renderer.ts`          消息 / 话题 / diff 的渲染
 * - `chat/session-controller.ts` 会话的加载、保存、切换、删除
 * - `chat/header-view.ts`        头部、状态灯、会话菜单、工具栏
 * - `chat/input-view.ts`         输入区、`/` 与 `@` 补全、附件
 * - `chat/stream-controller.ts`  发送、AI 调用、流式、后台委托
 *
 * 子模块通过 `ChatCtx` 反向调用宿主，主类因此不用把方法体搬回来。
 * 拆之前这里是一个 2000+ 行的单体类，改动一个渲染细节要在整文件里翻。
 */
export class XiaoyuanAgentChatView extends ItemView implements ChatCtx {
  plugin: XiaoyuanAgentPlugin;
  messages: ChatMessage[] = [];
  lastDateKey = "";
  sessions: ChatSession[] = [];
  currentSessionId = "";
  /** 会话内的话题分段（仅展示，不影响上下文） */
  topics: TopicSection[] = [];
  /** 当前话题的 body 容器；后续消息追加到这里（为 null 则追加到 messagesEl） */
  currentTopicBody: HTMLElement | null = null;
  /** 当前活跃话题（未结束的那个） */
  currentTopicSection: TopicSection | null = null;
  /** 当前活跃话题的 DOM 外壳（用于结束话题时清理空话题） */
  currentTopicEl: HTMLElement | null = null;
  abortController: AbortController | null = null;

  msgIdCounter = 0;
  viewContainer?: HTMLDivElement;
  /**
   * 当前正在流式输出的消息 id。
   * 定型时必须用它而不是「最后一条消息」：后台委托会在前台流式期间往末尾插消息，
   * 取最后一条会定型到后台那条上。
   */
  streamingMessageId: string | null = null;
  /** 保存串行化链：见 `saveCurrentSession` */
  saveChain: Promise<void> = Promise.resolve();
  /** 划选浮层的注销函数（onClose 必须调用，否则监听会一直挂着） */
  private disposeSelectionListener: (() => void) | null = null;
  /** 打开视图时只补一次 agent 列表 */
  private agentsSyncedOnOpen = false;
  /** 会话下拉菜单的弹层；收起时为 null。 */
  sessionMenuEl: HTMLDivElement | null = null;
  messagesEl!: HTMLDivElement;
  thinkingBarEl!: HTMLDivElement;
  inputEl!: HTMLTextAreaElement;
  sendBtn!: HTMLSpanElement;
  toolbarEl!: HTMLDivElement;
  agentSelector!: HTMLSpanElement;
  connectionStatusEl: HTMLSpanElement | null = null;
  openCodeEl!: HTMLSpanElement;
  openCodeStatus?: boolean;
  apiStatus?: boolean;
  apiProbeAt = 0;
  attachments: Attachment[] = [];
  attachPreviewEl!: HTMLDivElement;
  quoteText = "";
  skillIndex = -1;
  pendingDiffs: FileDiff[] | null = null;
  /** 工具事件可能早于流式消息创建到达，先缓冲，等消息节点建好再补 */
  pendingToolLogs: { tool: string; status: string }[] = [];
  /** 前台 Agent（不 @ 时由它回答） */
  get foreground(): AgentConfig | undefined {
    return getDefaultAgent(this.plugin.settings);
  }

  constructor(leaf: WorkspaceLeaf, plugin: XiaoyuanAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_XIAOYUAN_AGENT_CHAT;
  }
  getDisplayText(): string {
    return t("app.name");
  }
  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("xyag-chat-container");
    this.viewContainer = contentEl.createDiv({ cls: "xyag-chat" });

    const mainEl = this.viewContainer.createDiv({ cls: "xyag-main" });

    headerView.buildHeader(this, mainEl);
    this.thinkingBarEl = mainEl.createDiv({ cls: "xyag-thinking-bar" });
    this.messagesEl = mainEl.createDiv({ cls: "xyag-chat-messages" });
    inputView.buildInputArea(this, mainEl);

    // 活动笔记变化时刷新工具栏的「当前笔记」chip
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => inputView.refreshNoteChip(this)),
    );
    // 文件改名后 chip 上的名字也要跟着换
    this.registerEvent(
      this.app.vault.on("rename", () => inputView.refreshNoteChip(this)),
    );

    try {
      const s = this.plugin.settings;
      if (s.execMode === "cli" && !this.agentsSyncedOnOpen) {
        this.agentsSyncedOnOpen = true;
        if ((s.opencodeAgents || []).length === 0) {
          const { ensureOpenCodeAgents } = await import("./opencode-sync");
          void ensureOpenCodeAgents({ plugin: this.plugin, silent: true, reason: "chat-open" });
        }
      }
    } catch {}

    this.disposeSelectionListener = registerSelectionListener(this.messagesEl, {
      onSpeak: (text) => this.plugin.speakController.start(text),
      onQuote: (text) => this.quote(text),
      onAITools: (text, e) => this.showAIToolsForContent(text, e),
      onCapture: (text) => this.capture(text),
    });

    void this.syncOpenCodeState({ force: false, silent: false });
    await sessionController.loadSessions(this);
    // 打开聊天面板时顺便探测一次 API 连通性，避免设置里新加的模型要点图标才更新
    void this.probeApiStatus();
  }

  async onClose(): Promise<void> {
    // 会话菜单挂在 body 上，视图关了要主动收掉，否则会剩一个孤儿弹层
    this.closeSessionMenu();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.pendingDiffs = null;
    await this.saveCurrentSession();
    // 划选弹层往 document 上挂了监听，不注销就一直持有已销毁的 DOM 子树
    this.disposeSelectionListener?.();
    this.disposeSelectionListener = null;
    // onOpen 早期抛错时 viewContainer 可能还没赋值，别在关闭时再抛一次
    this.viewContainer?.empty();
  }

  // ─── 委托：渲染 ────────────────────────────────────────────────

  addMessage(role: "user" | "assistant", content: string, source?: string): Promise<void> {
    return renderer.addMessage(this, role, content, source);
  }

  addSystemMessage(text: string): HTMLDivElement {
    return renderer.addSystemMessage(this, text);
  }

  renderQuoteBar(): void {
    renderer.renderQuoteBarFor(this);
  }

  renderConversation(): Promise<void> {
    return renderer.renderConversation(this);
  }

  truncateMessagesIfNeeded(): Promise<void> {
    return renderer.truncateMessagesIfNeeded(this);
  }

  renderDiffs(messageId: string, diffs: FileDiff[]): void {
    renderer.renderDiffs(this, messageId, diffs);
  }

  undoMessage(id: string): void {
    renderer.undoMessage(this, id);
  }

  addStreamingMessage(content: string, thinking?: string, source?: string): string {
    return renderer.addStreamingMessage(this, content, thinking, source);
  }

  updateStreamingMessage(messageId: string, content: string): void {
    renderer.updateStreamingMessage(this, messageId, content);
  }

  updateStreamingThinking(messageId: string, thinking: string): void {
    renderer.updateStreamingThinking(this, messageId, thinking);
  }

  addToolLogEntry(messageId: string, toolName: string, status: string): void {
    renderer.addToolLogEntry(this, messageId, toolName, status);
  }

  finalizeStreamingMessage(messageId?: string): Promise<string | null> {
    return renderer.finalizeStreamingMessage(this, messageId);
  }

  addTopic(title: string): Promise<void> {
    return renderer.addTopic(this, title);
  }

  endCurrentTopic(): Promise<void> {
    return renderer.endCurrentTopic(this);
  }

  deleteTopic(section: TopicSection): Promise<void> {
    return renderer.deleteTopic(this, section);
  }

  // ─── 委托：会话 ────────────────────────────────────────────────

  saveCurrentSession(): Promise<void> {
    return sessionController.saveCurrentSession(this);
  }

  updateSessionTitle(): void {
    sessionController.updateSessionTitle(this);
  }

  createNewSession(ownerId: string | null): void {
    sessionController.createNewSession(this, ownerId);
  }

  newChat(): Promise<void> {
    return sessionController.newChat(this);
  }

  switchSession(sessionId: string): Promise<void> {
    return sessionController.switchSession(this, sessionId);
  }

  newChatWith(ownerId: string | null): Promise<void> {
    return sessionController.newChatWith(this, ownerId);
  }

  /** 设置改动后由设置面板调用，重绘会话下拉菜单（收起时什么都不做）。 */
  refreshSessionMenu(): void {
    this.renderSessionMenu();
  }

  // ─── 委托：头部 / 工具栏 / 状态灯 ────────────────────────────────

  updateAgentSelector(): void {
    headerView.updateAgentSelector(this);
  }

  updateAgentBorderClass(): void {
    headerView.updateAgentBorderClass(this);
  }

  rebuildToolbar(opts?: { skipSync?: boolean }): void {
    headerView.rebuildToolbar(this, opts);
  }

  probeApiStatus(): Promise<void> {
    return headerView.probeApiStatus(this);
  }

  setOpenCodeStatus(ok: boolean): void {
    headerView.setOpenCodeStatus(this, ok);
  }

  setApiStatus(ok: boolean): void {
    headerView.setApiStatus(this, ok);
  }

  setProcessingState(processing: boolean): void {
    headerView.setProcessingState(this, processing);
  }

  /** OpenCode 服务连通后由 ai.ensureOpenCodeServer 调用，只更新状态灯 */
  markOpenCodeConnected(): void {
    headerView.markOpenCodeConnected(this);
  }

  syncOpenCodeState(opts?: { force?: boolean; silent?: boolean }): Promise<void> {
    return headerView.syncOpenCodeState(this, opts);
  }

  renderSessionMenu(): void {
    headerView.renderSessionMenu(this);
  }

  closeSessionMenu(): void {
    headerView.closeSessionMenu(this);
  }

  quote(text: string): void {
    headerView.quote(this, text);
  }

  capture(text: string): void {
    headerView.capture(this, text);
  }

  showAIToolsForContent(content: string, e: MouseEvent): void {
    headerView.showAIToolsForContent(this, content, e);
  }

  openInEditor(content: string, ts?: number): Promise<void> {
    return headerView.openInEditorFor(this, content, ts);
  }

  // ─── 委托：输入区 ──────────────────────────────────────────────

  pickFiles(): void {
    inputView.pickFiles(this);
  }

  setInputValue(text: string): void {
    inputView.setInputValue(this, text);
  }

  sendPrefilled(text: string): Promise<void> {
    return inputView.sendPrefilled(this, text);
  }

  // ─── 委托：发送 / AI ────────────────────────────────────────────

  sendMessage(): Promise<void> {
    return streamController.sendMessage(this);
  }
}

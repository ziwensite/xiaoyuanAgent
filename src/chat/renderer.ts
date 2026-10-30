import { MarkdownRenderer, loadPrism, Menu, Notice, setIcon } from "obsidian";
import type { ChatCtx, TopicBlock } from "./context";
import type { ChatMessage, FileDiff, TopicSection } from "../types";
import { CONTEXT_TRIM_RATIO } from "../constants";
import { estimateTokens, diffLineRows, formatDate } from "../utils";
import { buildActionBar } from "../action-bar";
import { renderQuoteBar } from "../quote-bar";
import { TopicTitleModal } from "../modals";
import { getAgentByName } from "../agent-registry";
import { t } from "../i18n";

// ─── 日期分隔 ────────────────────────────────────────────────────

function formatDateWeekday(ts: number): string {
  const d = new Date(ts);
  return new Intl.DateTimeFormat(t("locale.code"), {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(d);
}

function getDateKey(ts: number): string {
  return formatDate(ts);
}

// ─── 单条消息的渲染 ───────────────────────────────────────────────

export function actionBarOptions(ctx: ChatCtx) {
  return {
    modeLabel: ctx.foreground?.name || "",
    undoMessage: (id: string) => undoMessage(ctx, id),
    openInEditor: (c: string, ts?: number) => void ctx.openInEditor(c, ts),
    quote: (text: string) => ctx.quote(text),
    onSpeak: (text: string) => ctx.plugin.speakController.start(text),
    onAITools: (c: string, e: MouseEvent) => ctx.showAIToolsForContent(c, e),
    onCapture: (text: string) => ctx.capture(text),
  };
}

export function sanitizeForRender(md: string): string {
  const blocks: string[] = [];
  const noCode = md.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\x00CODERAW${blocks.length - 1}\x00`;
  });
  const safe = noCode.replace(/!\[\[/g, "!\u200B[[");
  return safe.replace(/\x00CODERAW(\d+)\x00/g, (_, i) => blocks[+i]);
}

/**
 * 代码高亮。
 *
 * Obsidian 把 Prism 放在 `/lib/prism.min.js`，**按需加载**。
 * `loadPrism()` 是官方暴露的入口，等它 resolve 拿到的才是真对象。
 */
export async function highlightCodeUnder(container: HTMLElement): Promise<void> {
  try {
    const prism = (await loadPrism()) as { highlightAllUnder?: (el: HTMLElement) => void } | null | undefined;
    if (typeof prism?.highlightAllUnder === "function") prism.highlightAllUnder(container);
  } catch (err) {
    // 高亮是可选增强，加载失败不能影响消息渲染
    console.warn("代码高亮不可用", err);
  }
}

export function enhanceCodeBlocks(ctx: ChatCtx, container: HTMLElement): void {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".xyag-copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "xyag-copy-btn";
    btn.textContent = t("btn.copy");
    pre.style.position = "relative";
    btn.addEventListener("click", () => {
      // 复制的是 pre 的文本，但按钮本身也在 pre 里 —— 不摘掉按钮会把「复制」一起复制出去。
      const clone = pre.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".xyag-copy-btn").forEach((b) => b.remove());
      navigator.clipboard.writeText(clone.textContent || "");
      btn.textContent = t("chat.copied");
      setTimeout(() => {
        btn.textContent = t("btn.copy");
      }, 2000);
    });
    pre.appendChild(btn);
  });
  void highlightCodeUnder(container);
}

export async function renderObsidianMD(ctx: ChatCtx, container: HTMLElement, md: string): Promise<void> {
  const safe = sanitizeForRender(md);
  const sourcePath = `${ctx.plugin.settings.chatHistoryPath}/session.md`;
  await MarkdownRenderer.render(ctx.app, safe, container, sourcePath, ctx as never);
  container.querySelectorAll("table").forEach((table) => {
    const wrapper = document.createElement("div");
    wrapper.style.overflowX = "auto";
    wrapper.style.maxWidth = "100%";
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

export function renderMsgHeader(ctx: ChatCtx, msgEl: HTMLElement, source: string): void {
  const agent = getAgentByName(ctx.plugin.settings, source);
  const headerEl = msgEl.createDiv({ cls: "xyag-msg-header" });
  const avatarEl = headerEl.createSpan({ cls: "xyag-msg-avatar" });
  setIcon(avatarEl, agent?.avatar || "sparkles");
  headerEl.createSpan({ cls: "xyag-msg-name", text: source });
}

export async function renderMessageEl(
  ctx: ChatCtx,
  id: string,
  role: "user" | "assistant",
  content: string,
  streaming = false,
  thinking?: string,
  timestamp?: number,
  source?: string,
): Promise<HTMLDivElement> {
  const msgEl = createDiv({ cls: `xyag-msg xyag-msg-${role}` });
  msgEl.id = id;

  if (role === "assistant" && source && source !== "user") {
    renderMsgHeader(ctx, msgEl, source);
  }

  const bubbleEl = msgEl.createDiv({ cls: "xyag-msg-bubble" });
  if (role === "user") {
    if (/!\[.*?\]\(data:image/.test(content)) {
      await renderObsidianMD(ctx, bubbleEl.createDiv({ cls: "xyag-obsidian-md" }), content.trim());
    } else {
      bubbleEl.createSpan().textContent = content;
    }
  } else {
    if (thinking && ctx.plugin.settings.showThinking) {
      const detailsEl = bubbleEl.createEl("details", { cls: "xyag-thinking" });
      detailsEl.createEl("summary", { text: t("chat.thinking") });
      detailsEl.createDiv({ cls: "xyag-thinking-content" }).textContent = thinking.trim();
    }
    await renderObsidianMD(ctx, bubbleEl.createDiv({ cls: "xyag-obsidian-md" }), content.trim());
    enhanceCodeBlocks(ctx, bubbleEl);
  }

  if (!streaming) {
    buildActionBar(msgEl, role, content, timestamp, actionBarOptions(ctx));
  }
  return msgEl;
}

// ─── 追加 / 更新消息 ──────────────────────────────────────────────

export function addWelcomeMessage(ctx: ChatCtx): void {
  const modeLabel = ctx.foreground?.name || "";
  const msgEl = ctx.messagesEl.createDiv({ cls: "xyag-msg xyag-msg-assistant xyag-welcome" });
  const bubble = msgEl.createDiv({ cls: "xyag-msg-bubble" });
  const line = (text: string) => {
    bubble.createEl("span", { text });
    bubble.createEl("br");
  };
  line(t("chat.welcome.title"));
  bubble.createEl("br");
  line(`${t("chat.welcome.mode")}：${modeLabel}`);
  bubble.createEl("br");
  line(t("chat.welcome.helpTitle"));
  line("• " + t("chat.welcome.help1"));
  line("• " + t("chat.welcome.help2"));
  line("• " + t("chat.welcome.help3"));
  bubble.createEl("br");
  bubble.createEl("span", { text: t("chat.welcome.help4") });
}

export function addSystemMessage(ctx: ChatCtx, text: string): HTMLDivElement {
  const msgEl = ctx.messagesEl.createDiv({ cls: "xyag-msg xyag-msg-system" });
  msgEl.createDiv({ cls: "xyag-msg-bubble" }).textContent = text;
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
  return msgEl;
}

export function addDateHeaderIfNeeded(ctx: ChatCtx, timestamp: number): void {
  const dateKey = getDateKey(timestamp);
  if (dateKey !== ctx.lastDateKey) {
    ctx.lastDateKey = dateKey;
    const headerEl = (ctx.currentTopicBody ?? ctx.messagesEl).createDiv({
      cls: "xyag-msg xyag-msg-system xyag-date-header",
    });
    headerEl.createDiv({ cls: "xyag-msg-bubble" }).textContent = formatDateWeekday(timestamp);
  }
}

export async function addMessage(
  ctx: ChatCtx,
  role: "user" | "assistant",
  content: string,
  source?: string,
): Promise<void> {
  const id = "msg-" + ++ctx.msgIdCounter;
  const now = Date.now();
  ctx.messages.push({ id, role, content, source: source || "user", timestamp: now });
  addDateHeaderIfNeeded(ctx, now);
  const targetEl = ctx.currentTopicBody ?? ctx.messagesEl;
  targetEl.appendChild(await renderMessageEl(ctx, id, role, content, false, undefined, now, source));
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
}

export function renderQuoteBarFor(ctx: ChatCtx): void {
  renderQuoteBar(
    ctx.attachPreviewEl,
    { quoteText: ctx.quoteText, attachments: ctx.attachments },
    () => {
      ctx.quoteText = "";
      renderQuoteBarFor(ctx);
    },
    (i) => {
      ctx.attachments.splice(i, 1);
      renderQuoteBarFor(ctx);
    },
  );
}

// ─── 流式消息 ────────────────────────────────────────────────────

export function addStreamingMessage(ctx: ChatCtx, content: string, thinking?: string, source?: string): string {
  const id = "msg-" + ++ctx.msgIdCounter;
  const now = Date.now();
  const src = source || ctx.foreground?.name || "";
  ctx.messages.push({ id, role: "assistant", content, thinking, source: src, timestamp: now });
  const msgEl = createDiv({ cls: "xyag-msg xyag-msg-assistant" });
  msgEl.id = id;
  renderMsgHeader(ctx, msgEl, src);
  const bubbleEl = msgEl.createDiv({ cls: "xyag-msg-bubble" });
  if (thinking && ctx.plugin.settings.showThinking) {
    const detailsEl = bubbleEl.createEl("details", { cls: "xyag-thinking" });
    detailsEl.createEl("summary", { text: t("chat.thinking") });
    detailsEl.createDiv({ cls: "xyag-thinking-content" }).textContent = thinking;
  }
  bubbleEl.createDiv({ cls: "xyag-stream-content" }).textContent = content;
  (ctx.currentTopicBody ?? ctx.messagesEl).appendChild(msgEl);
  if (ctx.pendingToolLogs.length) {
    const logs = ctx.pendingToolLogs;
    ctx.pendingToolLogs = [];
    for (const l of logs) addToolLogEntry(ctx, id, l.tool, l.status);
  }
  buildActionBar(msgEl, "assistant", content, now, actionBarOptions(ctx));
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
  return id;
}

export function updateStreamingMessage(ctx: ChatCtx, messageId: string, content: string): void {
  const msgEl = ctx.messagesEl.querySelector<HTMLElement>(`[id="${messageId}"]`);
  if (!msgEl) return;
  const bubbleEl = msgEl.querySelector<HTMLElement>(".xyag-msg-bubble");
  if (!bubbleEl) return;
  let streamEl = bubbleEl.querySelector<HTMLElement>(".xyag-stream-content");
  if (!streamEl) streamEl = bubbleEl.createDiv({ cls: "xyag-stream-content" });
  streamEl.textContent = content;
  const idx = ctx.messages.findIndex((m) => m.id === messageId);
  if (idx !== -1) ctx.messages[idx].content = content;
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
}

export function updateStreamingThinking(ctx: ChatCtx, messageId: string, thinking: string): void {
  const msgEl = ctx.messagesEl.querySelector<HTMLElement>(`[id="${messageId}"]`);
  if (!msgEl || !ctx.plugin.settings.showThinking) return;
  const idx = ctx.messages.findIndex((m) => m.id === messageId);
  if (idx !== -1) ctx.messages[idx].thinking = thinking;
  let tc = msgEl.querySelector<HTMLElement>(".xyag-thinking-content");
  if (tc) {
    tc.textContent = thinking;
    return;
  }
  const bubbleEl = msgEl.querySelector(".xyag-msg-bubble");
  if (!bubbleEl) return;
  const detailsEl = document.createElement("details");
  detailsEl.className = "xyag-thinking";
  detailsEl.createEl("summary", { text: t("chat.thinking") });
  tc = detailsEl.createDiv({ cls: "xyag-thinking-content" });
  tc.textContent = thinking;
  bubbleEl.prepend(detailsEl);
}

export function addToolLogEntry(ctx: ChatCtx, messageId: string, toolName: string, status: string): void {
  const msgEl = ctx.messagesEl.querySelector<HTMLElement>(`[id="${messageId}"]`);
  if (!msgEl) return;
  let logEl = msgEl.querySelector<HTMLElement>(".xyag-tool-log");
  if (!logEl) {
    const bubbleEl = msgEl.querySelector(".xyag-msg-bubble");
    if (!bubbleEl) return;
    logEl = bubbleEl.createDiv({ cls: "xyag-tool-log" });
  }
  const toolLabel =
    toolName === "bash"
      ? t("chat.tool.bash")
      : toolName === "write"
        ? t("chat.tool.write")
        : toolName === "edit"
          ? t("chat.tool.edit")
          : toolName === "read"
            ? t("chat.tool.read")
            : toolName;
  const icon = status === "running" ? "\u{23F3}" : "\u{2705}";
  // 工具名可能含引号等选择器特殊字符，直接拼选择器会抛错或匹配不到；
  // 改用遍历比较属性值，彻底规避转义问题。
  let entry = Array.from(logEl.children).find((c) => c.getAttribute("data-tool") === toolName) as
    | HTMLElement
    | undefined;
  if (!entry) {
    entry = logEl.createDiv({ cls: "xyag-tool-entry" });
    entry.setAttribute("data-tool", toolName);
  }
  entry.textContent = `${icon} ${toolLabel}`;
}

/**
 * 定型流式消息。
 *
 * 必须按显式 id 找：后台委托会在前台流式期间往 `ctx.messages` 末尾插消息，
 * 「取最后一条 assistant」会定型到后台那条上（重复渲染、清错节点）。
 */
export async function finalizeStreamingMessage(ctx: ChatCtx, messageId?: string): Promise<string | null> {
  const id = messageId ?? ctx.streamingMessageId;
  const lastMsg = (id ? ctx.messages.find((m) => m.id === id) : undefined) ?? ctx.messages[ctx.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return null;
  const msgEl = ctx.messagesEl.querySelector<HTMLElement>(`[id="${lastMsg.id}"]`);
  const bubbleEl = msgEl?.querySelector<HTMLElement>(".xyag-msg-bubble");
  if (!bubbleEl) return null;

  bubbleEl.querySelector(".xyag-stream-content")?.remove();
  bubbleEl.querySelector(".xyag-thinking")?.remove();

  const hasContent = lastMsg.content.trim().length > 0;
  const displayContent = hasContent ? lastMsg.content.trim() : (lastMsg.thinking || "").trim();
  if (!displayContent) return lastMsg.id;

  await renderObsidianMD(ctx, bubbleEl.createDiv({ cls: "xyag-obsidian-md" }), displayContent);

  if (hasContent && lastMsg.thinking && ctx.plugin.settings.showThinking) {
    const detailsEl = bubbleEl.createEl("details", { cls: "xyag-thinking" });
    detailsEl.createEl("summary", { text: t("chat.thinking") });
    detailsEl.createDiv({ cls: "xyag-thinking-content" }).textContent = lastMsg.thinking.trim();
    bubbleEl.prepend(detailsEl);
  }

  enhanceCodeBlocks(ctx, bubbleEl);
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
  return lastMsg.id;
}

export function renderDiffs(ctx: ChatCtx, messageId: string, diffs: FileDiff[]): void {
  const msgEl = ctx.messagesEl.querySelector<HTMLElement>(`[id="${messageId}"]`);
  if (!msgEl) return;
  msgEl.querySelector(".xyag-diffs")?.remove();

  const diffsEl = msgEl.createDiv({ cls: "xyag-diffs" });
  const toggle = diffsEl.createEl("details");
  const summary = toggle.createEl("summary", { cls: "xyag-diffs-summary" });
  const totalAdd = diffs.reduce((sum, d) => sum + d.additions, 0);
  const totalDel = diffs.reduce((sum, d) => sum + d.deletions, 0);
  summary.textContent = t("chat.diff.summary", String(totalAdd), String(totalDel), String(diffs.length));

  for (const diff of diffs) {
    const fileEl = toggle.createDiv({ cls: "xyag-diff-file" });
    fileEl.createDiv({ cls: "xyag-diff-file-header" }).textContent = `${diff.file} (+${diff.additions}/-${diff.deletions})`;
    const contentEl = fileEl.createDiv({ cls: "xyag-diff-content" });
    const table = contentEl.createEl("table", { cls: "xyag-diff-table" });
    for (const r of diffLineRows(diff.before, diff.after)) {
      const row = table.createEl("tr");
      row.createEl("td", { text: r.beforeLine != null ? String(r.beforeLine) : "" });
      row.createEl("td", { text: r.afterLine != null ? String(r.afterLine) : "" });
      if (r.kind === "context") {
        row.classList.add("diff-context");
        row.createEl("td", { text: r.before ?? "" });
      } else if (r.kind === "removed") {
        row.classList.add("diff-removed");
        row.createEl("td", { text: r.before ?? "" });
      } else if (r.kind === "added") {
        row.classList.add("diff-added");
        row.createEl("td", { text: r.after ?? "" });
      } else {
        row.classList.add("diff-changed");
        const cell = row.createEl("td");
        cell.createEl("span", { text: r.before ?? "", cls: "diff-removed" });
        cell.createEl("br");
        cell.createEl("span", { text: r.after ?? "", cls: "diff-added" });
      }
    }
  }
}

// ─── 上下文截断 ───────────────────────────────────────────────────

export async function truncateMessagesIfNeeded(ctx: ChatCtx): Promise<void> {
  const s = ctx.plugin.settings;
  const threshold = Math.floor(s.maxTokens * CONTEXT_TRIM_RATIO);
  const sysTokens = estimateTokens(ctx.foreground?.systemPrompt || s.systemPrompt);
  // 先算好每条消息的 token 数再倒序扣减，整体只遍历一次。
  // 旧实现在循环里反复 `slice().map().join()` + `estimateTokens`，长会话是 O(n²)。
  const perMessage = ctx.messages.map((m) => estimateTokens(m.content));
  const total = perMessage.reduce((sum, n) => sum + n, 0);
  if (sysTokens + total <= threshold) return;

  let removed = 0;
  let remaining = total;
  // 至少保留最后一条消息（当前提问），同时保证循环一定终止。
  while (removed < ctx.messages.length - 1 && sysTokens + remaining > threshold) {
    remaining -= perMessage[removed];
    removed++;
  }
  if (removed === 0) return;

  // 话题下标是相对消息数组的，截断后必须整体偏移，否则话题标记会落到错误位置
  ctx.topics = ctx.topics
    .map((t) => ({
      ...t,
      startIndex: t.startIndex - removed,
      endIndex: t.endIndex === undefined ? undefined : t.endIndex - removed,
    }))
    .filter((t) => t.startIndex >= 0 && (t.endIndex === undefined || t.endIndex > t.startIndex));

  const msgEls = Array.from(ctx.messagesEl.querySelectorAll(".xyag-msg"));
  let removedFromDom = 0;
  for (const el of msgEls) {
    if (removedFromDom >= removed) break;
    if (el.classList.contains("xyag-welcome") || el.classList.contains("xyag-msg-system")) continue;
    el.remove();
    removedFromDom++;
  }

  ctx.messages = ctx.messages.slice(removed);
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
  addSystemMessage(ctx, t("chat.systemMsg.truncated", String(removed)));
}

// ─── 撤销 / 恢复 ─────────────────────────────────────────────────

export function restoreMessage(ctx: ChatCtx, id: string): void {
  const idx = ctx.messages.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const content = ctx.messages[idx].content;
  // 按 id 精确删除：querySelectorAll(".xyag-msg") 还包含欢迎语和日期分隔，
  // 它们的下标与 ctx.messages 不对齐，按下标删会删错节点。
  const removeIds = new Set(ctx.messages.slice(idx).map((m) => m.id));
  ctx.messages = ctx.messages.slice(0, idx);
  setTimeout(() => {
    ctx.messagesEl.querySelectorAll<HTMLElement>(".xyag-msg").forEach((el) => {
      if (el.id && removeIds.has(el.id)) el.remove();
    });
    ctx.inputEl.value = content;
    ctx.inputEl.focus();
  }, 0);
}

export function undoMessage(ctx: ChatCtx, id: string): void {
  restoreMessage(ctx, id);
  void ctx.saveCurrentSession();
}

// ─── 话题分段（仅展示） ────────────────────────────────────────────

/** 新建话题：上一个话题若还在进行中会自动结束（空话题直接丢弃）。 */
export async function addTopic(ctx: ChatCtx, title: string): Promise<void> {
  endActiveTopicIfNeeded(ctx);
  const section: TopicSection = { id: "topic-" + Date.now(), title, startIndex: ctx.messages.length };
  ctx.topics.push(section);
  // 话题仅作视觉分段：后续消息挂到同一个 body，details 折叠时整个话题收起。
  activateTopic(ctx, section, buildTopicBlock(ctx, section));
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
  await ctx.saveCurrentSession();
}

/** 「结束当前话题」：之后的消息回到话题外（顶层）。 */
export async function endCurrentTopic(ctx: ChatCtx): Promise<void> {
  if (!ctx.currentTopicSection) return;
  endActiveTopicIfNeeded(ctx);
  await ctx.saveCurrentSession();
}

/** 隐藏当前活跃话题；空话题（一条消息都没有）直接丢弃，不留空壳。 */
export function endActiveTopicIfNeeded(ctx: ChatCtx): void {
  const section = ctx.currentTopicSection;
  if (!section) return;
  if (section.startIndex >= ctx.messages.length) {
    ctx.topics = ctx.topics.filter((x) => x !== section);
    ctx.currentTopicEl?.remove();
  } else {
    section.endIndex = ctx.messages.length;
  }
  clearActiveTopic(ctx);
}

export function activateTopic(ctx: ChatCtx, section: TopicSection, block: TopicBlock): void {
  ctx.currentTopicSection = section;
  ctx.currentTopicEl = block.el;
  ctx.currentTopicBody = block.body;
}

export function clearActiveTopic(ctx: ChatCtx): void {
  ctx.currentTopicSection = null;
  ctx.currentTopicEl = null;
  ctx.currentTopicBody = null;
}

/** 在消息区末尾插入一个话题折叠块；右键标题弹出话题菜单。 */
export function buildTopicBlock(ctx: ChatCtx, section: TopicSection): TopicBlock {
  const el = ctx.messagesEl.createDiv({ cls: "xyag-topic" });
  const details = el.createEl("details", { cls: "xyag-topic-details" }) as HTMLDetailsElement;
  details.open = true;
  const summary = details.createEl("summary", {
    cls: "xyag-topic-summary",
    text: section.title || t("chat.topic.untitled"),
  });
  const body = details.createDiv({ cls: "xyag-topic-body" });
  summary.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showTopicMenu(ctx, ev, section, { el, details, summary, body });
  });
  return { el, details, summary, body };
}

export function showTopicMenu(ctx: ChatCtx, ev: MouseEvent, section: TopicSection, block: TopicBlock): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(t("chat.topic.rename"))
      .setIcon("pencil")
      .onClick(() => renameTopic(ctx, section, block)),
  );
  menu.addItem((item) =>
    item
      .setTitle(block.details.open ? t("chat.topic.collapse") : t("chat.topic.expand"))
      .setIcon("chevrons-up-down")
      .onClick(() => {
        block.details.open = !block.details.open;
      }),
  );
  if (ctx.currentTopicSection === section) {
    menu.addItem((item) =>
      item
        .setTitle(t("chat.topic.end"))
        .setIcon("log-out")
        .onClick(() => void endCurrentTopic(ctx)),
    );
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(t("chat.topic.delete"))
      .setIcon("trash")
      .onClick(() => void deleteTopic(ctx, section)),
  );
  menu.showAtMouseEvent(ev);
}

export function renameTopic(ctx: ChatCtx, section: TopicSection, block: TopicBlock): void {
  new TopicTitleModal(
    ctx.app,
    (title) => {
      section.title = title;
      block.summary.textContent = title;
      void ctx.saveCurrentSession();
    },
    { initialTitle: section.title, heading: t("chat.topic.rename") },
  ).open();
}

/** 删除话题只移除分段，消息全部保留（回落到顶层）。 */
export async function deleteTopic(ctx: ChatCtx, section: TopicSection): Promise<void> {
  if (ctx.abortController) {
    new Notice(t("chat.waitForResponse"));
    return;
  }
  const idx = ctx.topics.indexOf(section);
  if (idx === -1) return;
  ctx.topics.splice(idx, 1);
  if (ctx.currentTopicSection === section) clearActiveTopic(ctx);
  await renderConversation(ctx);
  await ctx.saveCurrentSession();
}

// ─── 整段重绘 ────────────────────────────────────────────────────

/** 按 messages + topics 重绘整个消息区（加载会话 / 删除话题后复用）。 */
export async function renderConversation(ctx: ChatCtx): Promise<void> {
  ctx.messagesEl.empty();
  ctx.lastDateKey = "";
  clearActiveTopic(ctx);

  if (ctx.messages.length === 0) {
    addWelcomeMessage(ctx);
    return;
  }

  const visible = ctx.topics
    .filter((x) => x.endIndex === undefined || x.endIndex > x.startIndex)
    .sort((a, b) => a.startIndex - b.startIndex);

  // 并行渲染全部消息节点：每条都要 `await MarkdownRenderer.render` + `loadPrism`，
  // 串行 await 时加载长会话会明显卡顿。渲染完再按原顺序插入 DOM。
  const msgEls = await Promise.all(
    ctx.messages.map((msg: ChatMessage) =>
      renderMessageEl(ctx, msg.id, msg.role, msg.content, false, msg.thinking, msg.timestamp, msg.source),
    ),
  );

  let tIdx = 0;
  for (let i = 0; i < ctx.messages.length; i++) {
    // 上一个话题已经越过终点 → 后面的消息回到顶层
    if (ctx.currentTopicSection?.endIndex !== undefined && ctx.currentTopicSection.endIndex <= i) {
      clearActiveTopic(ctx);
    }
    while (tIdx < visible.length && visible[tIdx].startIndex <= i) {
      const section = visible[tIdx];
      const block = buildTopicBlock(ctx, section);
      if (section.endIndex === undefined || section.endIndex > i) {
        activateTopic(ctx, section, block);
      }
      tIdx++;
    }
    const msg = ctx.messages[i];
    if (msg.timestamp) addDateHeaderIfNeeded(ctx, msg.timestamp);
    (ctx.currentTopicBody ?? ctx.messagesEl).appendChild(msgEls[i]);
  }
  // 末尾的空话题块也显示出来（例如刚建好还没发消息）
  while (tIdx < visible.length) {
    const section = visible[tIdx++];
    const block = buildTopicBlock(ctx, section);
    if (section.endIndex === undefined) activateTopic(ctx, section, block);
  }
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight;
}

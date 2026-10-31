import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import type { ChatCtx } from "./context";
import type { ChatSession } from "../types";
import { API_STATUS_CACHE_MS, getActiveProvider } from "../constants";
import { ensureOpenCodeServer, getVaultBasePath } from "../ai";
import { buildToolbarContent as renderToolbar, buildContextControls } from "../toolbar";
import { showPopup, addPopupItem, closePopup } from "../popup";
import { createActionBtn } from "../action-buttons";
import { openInEditor } from "../open-in-editor";
import { TextOperationModal } from "../modals";
import { listAgents, setDefaultAgent } from "../agent-registry";
import { getChatHistoryPath, saveSessionsMeta } from "../session";
import { deleteSession } from "./session-controller";
import { t } from "../i18n";
import { addSystemMessage, renderQuoteBarFor } from "./renderer";

// ─── Header ─────────────────────────────────────────────────────

export function buildHeader(ctx: ChatCtx, root: HTMLDivElement): void {
  // header 只在建的时候用一次，不必挂成实例字段
  const headerEl = root.createDiv({ cls: "xyag-chat-header" });
  const left = headerEl.createSpan({ cls: "xyag-chat-header-left" });
  const right = headerEl.createSpan({ cls: "xyag-chat-header-right" });

  const sessionBtn = left.createSpan({ cls: "xyag-icon-btn" });
  setIcon(sessionBtn, "history");
  setTooltip(sessionBtn, t("chat.tooltip.session"));
  sessionBtn.addEventListener("click", () => showSessionMenu(ctx, sessionBtn));

  const newChatBtn = left.createSpan({ cls: "xyag-icon-btn" });
  setIcon(newChatBtn, "message-square-plus");
  setTooltip(newChatBtn, t("chat.tooltip.newChat"));
  newChatBtn.addEventListener("click", () => showNewChatMenu(ctx, newChatBtn));

  ctx.agentSelector = left.createSpan({ cls: "xyag-agent-selector" });
  setTooltip(ctx.agentSelector, t("chat.agent.tooltip"));
  ctx.agentSelector.addEventListener("click", (e) => {
    e.stopPropagation();
    showAgentSwitcher(ctx, ctx.agentSelector);
  });

  buildHeaderRight(ctx, right);
  updateAgentSelector(ctx);
}

export function buildHeaderRight(ctx: ChatCtx, right: HTMLSpanElement): void {
  ctx.connectionStatusEl = right.createSpan({ cls: "xyag-icon-btn" });
  setIcon(ctx.connectionStatusEl, "activity");

  const openCodeEl = right.createSpan({ cls: "xyag-icon-btn" });
  ctx.openCodeEl = openCodeEl;
  setIcon(openCodeEl, "server");
  if (!openCodeEl.classList.contains("is-connected") && !openCodeEl.classList.contains("is-disconnected")) {
    openCodeEl.classList.add("is-disconnected");
  }

  // 两盏灯各管各的：OpenCode 那盏看服务同步结果，API 那盏看真实调用/探测结果。
  ctx.connectionStatusEl.addEventListener("click", () => void probeApiStatus(ctx));
  openCodeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    void showConnectionPopup(ctx, openCodeEl);
  });

  const settingsIcon = right.createSpan({ cls: "xyag-icon-btn" });
  setIcon(settingsIcon, "settings");
  setTooltip(settingsIcon, t("chat.tooltip.settings"));
  settingsIcon.addEventListener("click", () => {
    ctx.app.setting.open();
    ctx.app.setting.openTabById("xiaoyuanAgent");
  });
}

export function updateAgentSelector(ctx: ChatCtx): void {
  const agent = ctx.foreground;
  if (!ctx.agentSelector) return;
  ctx.agentSelector.empty();
  const icon = ctx.agentSelector.createSpan({ cls: "xyag-agent-selector-icon" });
  setIcon(icon, agent?.avatar || "bot");
  ctx.agentSelector.createSpan({ cls: "xyag-agent-selector-name", text: agent?.name || "" });
}

export function updateAgentBorderClass(ctx: ChatCtx): void {
  const channel = ctx.foreground?.channel;
  if (!ctx.viewContainer) return;
  // `xyag-agent-plan` 全项目从未被 add 过，是残留分支，一并清掉
  ctx.viewContainer.removeClass("xyag-agent-plan", "xyag-agent-build");
  if (channel === "cli") ctx.viewContainer.addClass("xyag-agent-build");
}

// ─── 新建 / Agent 切换 / 连接弹层 ──────────────────────────────────

/**
 * 工具栏「新建」下拉菜单：群聊 + 各个已启用的 Agent（新建独立对话）。
 * 历史菜单里不再保留「新建」项，统一收拢到这里。
 */
export function showNewChatMenu(ctx: ChatCtx, anchor: HTMLElement): void {
  if (ctx.abortController) {
    new Notice(t("chat.waitForResponse"));
    return;
  }
  const s = ctx.plugin.settings;
  showPopup(
    anchor,
    (popup) => {
      addPopupItem(
        popup,
        t("chat.session.newChat"),
        false,
        () => {
          void ctx.newChat();
        },
        "option",
      );
      if (listAgents(s).length > 0) {
        popup.createDiv({ cls: "xyag-popup-separator" });
      }
      for (const agent of listAgents(s)) {
        addPopupItem(
          popup,
          t("chat.session.newWithAgentName", agent.name),
          false,
          () => {
            void ctx.newChatWith(agent.id);
          },
          "option",
        );
      }
    },
    {
      onClose: () => {
        // no-op
      },
    },
  );
}

/** 前台 Agent 选择器（点击切换由谁回答）。 */
export function showAgentSwitcher(ctx: ChatCtx, anchor: HTMLElement): void {
  const s = ctx.plugin.settings;
  showPopup(anchor, (popup) => {
    for (const agent of listAgents(s)) {
      addPopupItem(popup, agent.name, agent.isDefault === true, async () => {
        const curId = ctx.currentSessionId;
        const cur = ctx.sessions.find((x) => x.id === curId);

        // 独立会话切换 Agent 时，自动联动到该 Agent 的独立对话线
        if (cur?.ownerAgentId && cur.ownerAgentId !== agent.id) {
          if (ctx.abortController) {
            new Notice(t("chat.waitForResponse"));
            return;
          }
          await ctx.saveCurrentSession();
          const existing = ctx.sessions.find((x) => x.ownerAgentId === agent.id);
          if (existing) {
            await ctx.switchSession(existing.id);
            return;
          }
          await ctx.newChatWith(agent.id);
          return;
        }

        // 群聊（ownerAgentId === null）或者已经是同一个 Agent 的独立会话：只切换前台回答者
        setDefaultAgent(s, agent.id);
        await ctx.plugin.saveSettings();
        ctx.updateAgentSelector();
        ctx.rebuildToolbar({ skipSync: true });
        ctx.renderSessionMenu();
        addSystemMessage(ctx, t("chat.switchMode.msg", agent.name));
        new Notice(t("chat.switchMode.notice", agent.name));
      });
    }
  });
}

export async function showConnectionPopup(ctx: ChatCtx, anchor: HTMLElement): Promise<void> {
  const s = ctx.plugin.settings;
  showPopup(
    anchor,
    async (popup) => {
      const { getCLIConnections } = await import("../connection-checker");
      const urls = await getCLIConnections(s);
      if (urls.length === 0) {
        popup.createDiv({ cls: "xyag-popup-item", text: t("chat.server.disconnected") });
        return;
      }
      for (const url of urls) {
        const row = popup.createDiv({ cls: "xyag-popup-item" });
        row.createSpan({ cls: "xyag-status-dot is-on" });
        // 地址与操作按钮之间留足空白，不要挤在一起
        row.createSpan({ cls: "xyag-popup-label xyag-server-host", text: new URL(url).host });
        const actions = row.createDiv({ cls: "xyag-popup-suffix" });
        const openIcon = actions.createSpan({ cls: "xyag-popup-suffix-btn xyag-msg-action" });
        setIcon(openIcon, "external-link");
        openIcon.addEventListener("click", (ev) => {
          ev.stopPropagation();
          window.open(url, "_blank");
          closePopup(popup);
        });
        const closeIcon = actions.createSpan({ cls: "xyag-popup-suffix-btn xyag-msg-action" });
        setIcon(closeIcon, "x");
        closeIcon.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const { stopOpenCodeServer } = await import("../opencode-server");
          stopOpenCodeServer();
          closePopup(popup);
        });
      }
    },
    // 自适应宽度：内容就一两条服务器地址，全宽太夸张
    { direction: "down" },
  );
}

// ─── 工具栏 / 处理中状态 ───────────────────────────────────────────

export function buildToolbarContent(ctx: ChatCtx, container: HTMLElement): void {
  ctx.sendBtn = renderToolbar(container, ctx);
  setProcessingState(ctx, false);
}

export function setProcessingState(ctx: ChatCtx, processing: boolean): void {
  ctx.thinkingBarEl.classList.toggle("is-active", processing);
  if (processing) {
    setIcon(ctx.sendBtn, "circle-stop");
    setTooltip(ctx.sendBtn, t("btn.stop"));
    ctx.sendBtn.classList.add("is-stop");
  } else {
    setIcon(ctx.sendBtn, "circle-arrow-right");
    setTooltip(ctx.sendBtn, t("btn.send"));
    ctx.sendBtn.classList.remove("is-stop");
  }
}

export function rebuildToolbar(ctx: ChatCtx, opts?: { skipSync?: boolean }): void {
  if (!ctx.toolbarEl) return;
  ctx.toolbarEl.empty();
  buildToolbarContent(ctx, ctx.toolbarEl);
  // 上下文状态挂在输入框上方，也要跟着重建（作用域可能随会话切换变化）
  if (ctx.contextBarEl) {
    ctx.contextBarEl.empty();
    buildContextControls(ctx, ctx.contextBarEl);
  }
  ctx.updateAgentSelector();
  ctx.updateAgentBorderClass();
  if (opts?.skipSync) return;
  // 只在确实需要时同步：CLI 通道下模型列表为空或当前未选模型
  const s = ctx.plugin.settings;
  const needSync = s.execMode === "cli" && (!s.opencodeModels?.length || !s.opencode.model);
  if (needSync) {
    void ctx.syncOpenCodeState({ force: false, silent: true });
  }
}

// ─── 状态灯 / 连通性 ──────────────────────────────────────────────

export async function syncOpenCodeState(ctx: ChatCtx, opts?: { force?: boolean; silent?: boolean }): Promise<void> {
  const s = ctx.plugin.settings;
  if (s.execMode !== "cli") {
    return;
  }
  const force = opts?.force ?? true;
  const silent = opts?.silent ?? false;
  try {
    if (s.opencode.autoStart) {
      await ensureOpenCodeServer(
        s.opencode.cliPath,
        s.opencode.hostname,
        s.opencode.port,
        getVaultBasePath(),
        true,
      ).catch((e) => console.warn("opencode 自动启动失败:", e));
    }
    const { ensureOpenCodeModels, ensureOpenCodeAgents } = await import("../opencode-sync");
    await ensureOpenCodeModels({ plugin: ctx.plugin, silent, force, reason: "manual" });
    await ensureOpenCodeAgents({ plugin: ctx.plugin, silent: true, force: false, reason: "manual" });
    await ctx.plugin.saveSettings();
    setOpenCodeStatus(ctx, true);
    const count = ctx.plugin.settings.opencodeModels?.length || 0;
    if (!silent && count > 0) new Notice(t("notice.syncModels", String(count)));
  } catch (err: unknown) {
    setOpenCodeStatus(ctx, false);
    if (!silent) {
      new Notice(t("notice.syncFailed", err instanceof Error ? err.message : String(err)));
    }
  }
}

/** OpenCode 服务灯，只反映 syncOpenCodeState 的结果。 */
export function setOpenCodeStatus(ctx: ChatCtx, ok: boolean): void {
  if (ctx.openCodeStatus === ok) return;
  ctx.openCodeStatus = ok;
  if (!ctx.openCodeEl) return;
  ctx.openCodeEl.removeClass("is-connected", "is-disconnected");
  ctx.openCodeEl.addClass(ok ? "is-connected" : "is-disconnected");
  setTooltip(ctx.openCodeEl, ok ? t("status.opencode.tip.ok") : t("status.opencode.tip.down"));
}

/**
 * OpenCode 服务连通后由 ai.ensureOpenCodeServer 调用，
 * 只更新状态灯，不触发同步（避免循环）。
 */
export function markOpenCodeConnected(ctx: ChatCtx): void {
  setOpenCodeStatus(ctx, true);
}

/** API 通道灯，只反映真实调用 / 探测的结果。 */
export function setApiStatus(ctx: ChatCtx, ok: boolean): void {
  if (ctx.apiStatus === ok) return;
  ctx.apiStatus = ok;
  if (!ctx.connectionStatusEl) return;
  ctx.connectionStatusEl.removeClass("is-connected", "is-disconnected");
  ctx.connectionStatusEl.addClass(ok ? "is-connected" : "is-disconnected");
  setTooltip(ctx.connectionStatusEl, ok ? t("status.api.tip.ok") : t("status.api.tip.down"));
}

/**
 * 点 API 灯时打一次不消耗 token 的轻量端点判断可达性。
 * 有些 OpenAI 兼容服务不实现 /models —— 那不是「连不上」，别把灯打红。
 *
 * `ctx.apiProbeAt` 记录上次探测时间：开视图 / 新会话 / 切会话都会调一次，
 * 没必要每次都发真请求。
 */
export async function probeApiStatus(ctx: ChatCtx): Promise<void> {
  const provider = getActiveProvider(ctx.plugin.settings);
  if (!provider?.apiKey) {
    setApiStatus(ctx, false);
    return;
  }
  if (Date.now() - ctx.apiProbeAt < API_STATUS_CACHE_MS) return;
  ctx.apiProbeAt = Date.now();
  const base = provider.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  try {
    const resp = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${provider.apiKey}` } });
    // 不读响应体就丢开，socket 会挂到 GC 才释放
    resp.body?.cancel().catch(() => {});
    if (resp.ok) {
      setApiStatus(ctx, true);
      return;
    }
    if (resp.status === 404 || resp.status === 405) return;
    setApiStatus(ctx, false);
  } catch {
    setApiStatus(ctx, false);
  }
}

// ─── 会话下拉菜单 ─────────────────────────────────────────────────

/**
 * 会话列表下拉菜单（原来是左侧抽屉）。
 *
 * 结构跟抽屉时期完全一致：标题 / 搜索框 / 按 Agent 分组 /
 * 会话条目（切换、重命名、打开文件、删除）。区别只是贴着按钮弹出，
 * 不再常驻占据聊天区宽度。
 */
export function showSessionMenu(ctx: ChatCtx, anchor: HTMLElement): void {
  showPopup(
    anchor,
    (popup) => {
      popup.addClass("xyag-session-menu");
      ctx.sessionMenuEl = popup;
      drawSessionList(ctx, popup);
    },
    {
      onClose: () => {
        ctx.sessionMenuEl = null;
      },
    },
  );
}

/** 会话菜单还开着就原地重画（新建 / 删除 / 设置改动后调用）。 */
export function renderSessionMenu(ctx: ChatCtx): void {
  const menu = ctx.sessionMenuEl;
  if (!menu) return;
  drawSessionList(ctx, menu);
  // 分组收起 / 列表变短后高度变了，重新贴一次触发器
  menu.dispatchEvent(new CustomEvent("xyag-popup-relayout"));
}

/** 收起会话菜单（点条目 / 新建之后调用）。 */
export function closeSessionMenu(ctx: ChatCtx): void {
  if (!ctx.sessionMenuEl) return;
  closePopup(ctx.sessionMenuEl);
  ctx.sessionMenuEl = null;
}

/** 把会话菜单的内容画进容器，按 Agent 分组（见 DESIGN.md 5.10）。 */
export function drawSessionList(ctx: ChatCtx, container: HTMLElement): void {
  const s = ctx.plugin.settings;
  container.empty();

  container.createDiv({ cls: "xyag-session-title", text: t("chat.session.menuTitle") });

  const searchInput = container.createEl("input", {
    cls: "xyag-session-search",
    type: "text",
    placeholder: t("chat.session.search"),
  });
  const listEl = container.createDiv({ cls: "xyag-session-list" });

  // 分组：群聊（ownerAgentId 为空）+ 历史中存在过的 Agent + 当前已启用的 Agent
  const knownAgentIds = new Set<string>();
  for (const a of s.agents) knownAgentIds.add(a.id);
  const historyAgentIds = new Set<string>();
  for (const sess of ctx.sessions) {
    if (sess.ownerAgentId) historyAgentIds.add(sess.ownerAgentId);
  }
  const groups: { key: string; label: string; icon: string; ownerId: string | null; gone?: boolean }[] = [
    { key: "chat", label: t("chat.session.group.chat"), icon: "messages-square", ownerId: null },
  ];
  for (const a of s.agents) {
    groups.push({ key: a.id, label: a.name, icon: a.avatar || "bot", ownerId: a.id });
  }
  for (const aid of historyAgentIds) {
    if (knownAgentIds.has(aid)) continue;
    // Agent 已被删除，但历史记录还在 —— 用灰色标记提示
    groups.push({
      key: aid,
      label: t("chat.session.legacyAgent"),
      icon: "user-x",
      ownerId: aid,
      gone: true,
    });
  }

  for (const group of groups) {
    const items = ctx.sessions.filter((x) => (x.ownerAgentId ?? null) === group.ownerId);
    const groupEl = listEl.createDiv({ cls: "xyag-session-group" });
    const groupHead = groupEl.createDiv({ cls: "xyag-session-group-head" });
    const arrow = groupHead.createSpan({ cls: "xyag-session-group-arrow", text: "▼" });
    const gIcon = groupHead.createSpan({ cls: "xyag-session-group-icon" });
    setIcon(gIcon, group.icon);
    const gLabel = groupHead.createSpan({ cls: "xyag-session-group-label", text: group.label });
    if (group.gone) {
      groupHead.addClass("is-disabled");
      gLabel.style.color = "var(--text-faint)";
    }
    const body = groupEl.createDiv({ cls: "xyag-session-group-body" });
    groupHead.addEventListener("click", () => {
      const open = arrow.textContent === "▼";
      arrow.textContent = open ? "▶" : "▼";
      body.classList.toggle("is-collapsed", open);
      // 收起 / 展开会改高度，弹层位置得跟着重算
      container.dispatchEvent(new CustomEvent("xyag-popup-relayout"));
    });

    if (items.length === 0) {
      body.createDiv({ cls: "xyag-session-empty", text: t("chat.session.empty") });
    }
    for (const session of items) {
      renderSessionItem(ctx, body, session);
    }
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    listEl.querySelectorAll<HTMLElement>(".xyag-session-item").forEach((el) => {
      const label = el.querySelector(".xyag-session-item-title");
      const match = !q || (label?.textContent || "").toLowerCase().includes(q);
      el.style.display = match ? "" : "none";
    });
  });
}

export function renderSessionItem(ctx: ChatCtx, parent: HTMLElement, session: ChatSession): void {
  const item = parent.createDiv({ cls: "xyag-session-item" });
  if (session.id === ctx.currentSessionId) item.addClass("is-active");

  const checkEl = item.createSpan({ cls: "xyag-popup-check" });
  checkEl.textContent = session.id === ctx.currentSessionId ? "✓" : "";
  item.createSpan({ cls: "xyag-session-item-title", text: session.title });

  const suffix = item.createSpan({ cls: "xyag-popup-suffix" });

  const renameBtn = createActionBtn("rename");
  setTooltip(renameBtn, t("chat.session.rename"));
  renameBtn.classList.add("xyag-popup-suffix-btn");
  renameBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    startRename(ctx, item, session);
  });
  suffix.appendChild(renameBtn);

  const openBtn = createActionBtn("open");
  setTooltip(openBtn, t("chat.session.openInFile"));
  openBtn.classList.add("xyag-popup-suffix-btn");
  openBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const p = getChatHistoryPath(ctx.plugin.settings.chatHistoryPath);
    ctx.app.workspace.openLinkText(`${p}/${session.id}.md`, "/");
  });
  suffix.appendChild(openBtn);

  const deleteBtn = createActionBtn("delete");
  setTooltip(deleteBtn, t("chat.session.delete"));
  deleteBtn.classList.add("xyag-popup-suffix-btn", "danger");
  deleteBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void deleteSession(ctx, session.id);
  });
  suffix.appendChild(deleteBtn);

  item.addEventListener("click", () => {
    // 下拉菜单的语义：选完就收起来
    closeSessionMenu(ctx);
    void ctx.switchSession(session.id);
  });
}

export function startRename(ctx: ChatCtx, item: HTMLElement, session: ChatSession): void {
  const titleEl = item.querySelector<HTMLElement>(".xyag-session-item-title");
  if (!titleEl) return;
  // 视图可能开在弹出窗口里，元素得用同一份 document 创建
  const input = item.ownerDocument.createElement("input");
  input.type = "text";
  input.value = session.title;
  input.className = "xyag-session-rename";
  const finish = (save: boolean) => {
    if (save) {
      const next = input.value.trim() || session.title;
      if (next !== session.title) {
        session.title = next;
        void saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
      }
    }
    const span = createSpan({ cls: "xyag-session-item-title", text: session.title });
    input.replaceWith(span);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// ─── 消息上的动作（被 action-bar / 划选浮层回调） ────────────────────

export function capture(ctx: ChatCtx, text: string): void {
  navigator.clipboard.writeText(text);
  const cmdId = ctx.plugin.settings.captureCommandId;
  if (cmdId) ctx.app.commands.executeCommandById(cmdId);
}

export function quote(ctx: ChatCtx, text: string): void {
  ctx.quoteText = text;
  renderQuoteBarFor(ctx);
  ctx.inputEl.focus();
}

export async function openInEditorFor(ctx: ChatCtx, content: string, ts?: number): Promise<void> {
  await openInEditor(content, ctx.app.vault, ctx.app.workspace, ctx.plugin.settings.chatHistoryPath, ts, "bubble");
}

export function showAIToolsForContent(ctx: ChatCtx, content: string, e: MouseEvent): void {
  const menu = new Menu();
  for (const tpl of ctx.plugin.settings.promptTemplates) {
    menu.addItem((item) => {
      item.setTitle(`${tpl.name} — ${tpl.description}`);
      item.setIcon(tpl.icon);
      item.onClick(() => new TextOperationModal(ctx.app, ctx.plugin, tpl.id, content).open());
    });
  }
  menu.showAtMouseEvent(e);
}

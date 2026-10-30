import { Notice } from "obsidian";
import type { ChatCtx } from "./context";
import type { ChatSession } from "../types";
import {
  getChatHistoryPath,
  ensureChatHistoryFolder,
  scanChatHistoryFolder,
  loadSessionWithTopics,
  saveSessionToFile,
  deleteSessionFile,
  saveSessionsMeta,
  loadSessionsMeta,
  migrateOldData,
} from "../session";
import { getAgentById, setDefaultAgent } from "../agent-registry";
import { t } from "../i18n";
import { addSystemMessage, addWelcomeMessage, clearActiveTopic, renderConversation } from "./renderer";

// ─── 加载 / 切换 ──────────────────────────────────────────────────

export async function loadSessions(ctx: ChatCtx): Promise<void> {
  try {
    const path = getChatHistoryPath(ctx.plugin.settings.chatHistoryPath);
    await ensureChatHistoryFolder(ctx.app.vault, path);

    const meta = await loadSessionsMeta(ctx.plugin);
    // scanChatHistoryFolder 内部已经按 updatedAt 倒序排好了，不用再排一次
    ctx.sessions = await scanChatHistoryFolder(ctx.app.vault, path);
    ctx.currentSessionId = meta.currentSessionId;

    if (ctx.sessions.length === 0) {
      const rawData = await ctx.plugin.loadData();
      const oldMessages = rawData ? migrateOldData(rawData) : null;
      if (oldMessages && oldMessages.length > 0) {
        const now = Date.now();
        const session: ChatSession = {
          id: "session-" + now,
          title: oldMessages[0]?.content?.slice(0, 30) || t("chat.sessionTitle.history"),
          createdAt: now,
          updatedAt: now,
          ownerAgentId: null,
        };
        ctx.sessions.push(session);
        // 不再给 ctx.messages 赋值：紧接着的 switchToSession 会从文件重读一遍，
        // 这里赋的值必然被覆盖
        await saveSessionToFile(
          ctx.app.vault,
          path,
          session.id,
          session,
          oldMessages,
          ctx.plugin.settings.execMode,
        );
      }
    }
  } catch (err: unknown) {
    console.warn("加载会话失败:", err);
  }

  if (ctx.sessions.length === 0) {
    createNewSession(ctx, null);
  } else {
    const target = ctx.sessions.find((x) => x.id === ctx.currentSessionId) || ctx.sessions[0];
    await switchToSession(ctx, target);
  }
  await saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
}

export async function switchToSession(ctx: ChatCtx, session: ChatSession): Promise<void> {
  ctx.currentSessionId = session.id;
  await loadSession(ctx, session);
}

export async function loadSession(ctx: ChatCtx, session: ChatSession): Promise<void> {
  const path = getChatHistoryPath(ctx.plugin.settings.chatHistoryPath);
  const { messages, topics } = await loadSessionWithTopics(ctx.app.vault, path, session.id);
  ctx.messages = messages;
  ctx.topics = topics;
  ctx.msgIdCounter = ctx.messages.length;
  await renderConversation(ctx);
}

export function sessionTitleFromMessages(ctx: ChatCtx): string {
  const firstUser = ctx.messages.find((m) => m.role === "user");
  const text = firstUser?.content || ctx.messages[0]?.content || t("chat.sessionTitle.default");
  const cleaned = text.replace(/^#+\s*/, "").replace(/[*_`~]/g, "").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ─── 保存 ────────────────────────────────────────────────────────

/**
 * 保存当前会话（串行化）。
 *
 * 发送完成后、后台委托完成时、切会话时、关闭视图时都会触发保存，
 * 而这些路径是并发的。`saveSessionsMeta` 内部是 `loadData → 改 → saveData`，
 * `saveSessionToFile` 又是整文件覆写 —— 并发就是标准的 lost-update：
 * 后写者可能拿旧的 `messages` 把新内容盖掉。
 * 这里用一条 promise 链把所有保存串起来（天然 FIFO）。
 */
export async function saveCurrentSession(ctx: ChatCtx): Promise<void> {
  ctx.saveChain = ctx.saveChain.then(
    () => writeCurrentSession(ctx),
    () => writeCurrentSession(ctx),
  );
  return ctx.saveChain;
}

export async function writeCurrentSession(ctx: ChatCtx): Promise<void> {
  if (ctx.messages.length === 0) return;
  const path = getChatHistoryPath(ctx.plugin.settings.chatHistoryPath);
  const session = ctx.sessions.find((x) => x.id === ctx.currentSessionId);
  if (session) {
    session.updatedAt = Date.now();
    if (session.title === t("chat.sessionTitle.default") || session.title === "") {
      session.title = sessionTitleFromMessages(ctx);
    }
  }
  const ok = await saveSessionToFile(
    ctx.app.vault,
    path,
    ctx.currentSessionId,
    session,
    ctx.messages,
    ctx.plugin.settings.execMode,
    ctx.topics,
  );
  if (!ok) new Notice(t("notice.sessionSaveFailed"));
  await saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
}

export function updateSessionTitle(ctx: ChatCtx): void {
  const session = ctx.sessions.find((x) => x.id === ctx.currentSessionId);
  if (
    session &&
    (session.title === t("chat.sessionTitle.default") || session.title === "") &&
    ctx.messages.length > 0
  ) {
    session.title = sessionTitleFromMessages(ctx);
    session.updatedAt = Date.now();
  }
}

// ─── 新建 / 切换 / 删除 ────────────────────────────────────────────

/** 新建会话。`ownerId` 为 null 表示群聊会话，否则归属某个 Agent 的独立线。 */
export function createNewSession(ctx: ChatCtx, ownerId: string | null): void {
  const now = Date.now();
  const session: ChatSession = {
    id: "session-" + now,
    title: t("chat.sessionTitle.default"),
    createdAt: now,
    updatedAt: now,
    ownerAgentId: ownerId,
  };
  ctx.sessions.unshift(session);
  ctx.currentSessionId = session.id;
  ctx.messages = [];
  ctx.topics = [];
  clearActiveTopic(ctx);
  ctx.msgIdCounter = 0;
  ctx.messagesEl.empty();
  addWelcomeMessage(ctx);
  void saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
}

export async function newChat(ctx: ChatCtx): Promise<void> {
  await saveCurrentSession(ctx);
  createNewSession(ctx, null);
  ctx.renderSessionMenu();
  void ctx.probeApiStatus();
}

export async function newChatWith(ctx: ChatCtx, ownerId: string | null): Promise<void> {
  if (ctx.abortController) {
    new Notice(t("chat.waitForResponse"));
    return;
  }
  await saveCurrentSession(ctx);
  if (ownerId) {
    // 切到该 Agent，才能在这个独立对话里用它来回答
    setDefaultAgent(ctx.plugin.settings, ownerId);
    await ctx.plugin.saveSettings();
  }
  createNewSession(ctx, ownerId);
  ctx.renderSessionMenu();
  void ctx.probeApiStatus();
  if (ownerId) {
    ctx.updateAgentSelector();
    ctx.rebuildToolbar({ skipSync: true });
  }
  const owner = ownerId ? getAgentById(ctx.plugin.settings, ownerId) : undefined;
  if (owner) addSystemMessage(ctx, t("chat.session.newWithAgent") + ": " + owner.name);
}

export async function switchSession(ctx: ChatCtx, sessionId: string): Promise<void> {
  if (ctx.abortController) {
    new Notice(t("chat.waitForResponse"));
    return;
  }
  await saveCurrentSession(ctx);

  const filePath = getChatHistoryPath(ctx.plugin.settings.chatHistoryPath) + "/" + sessionId + ".md";
  const exists = await ctx.app.vault.adapter.exists(filePath).catch(() => false);
  if (!exists) {
    new Notice(t("chat.session.fileDeleted"));
    ctx.sessions = ctx.sessions.filter((x) => x.id !== sessionId);
    ctx.renderSessionMenu();
    return;
  }

  const session = ctx.sessions.find((x) => x.id === sessionId);
  if (!session) return;
  // 切换会话时也把前台切到该会话所属的 Agent（群聊沿用当前默认/切换器的逻辑）
  if (session.ownerAgentId) {
    setDefaultAgent(ctx.plugin.settings, session.ownerAgentId);
    await ctx.plugin.saveSettings();
  }
  ctx.currentSessionId = sessionId;
  await loadSession(ctx, session);
  await saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
  ctx.renderSessionMenu();
  if (session.ownerAgentId) {
    ctx.updateAgentSelector();
    ctx.rebuildToolbar({ skipSync: true });
  }
  void ctx.probeApiStatus();
  addSystemMessage(ctx, t("chat.session.switched") + ": " + session.title);
}

export async function deleteSession(ctx: ChatCtx, sessionId: string): Promise<void> {
  if (ctx.abortController) {
    new Notice(t("chat.waitForResponse"));
    return;
  }
  if (ctx.sessions.length <= 1) {
    new Notice(t("chat.session.atLeastOne"));
    return;
  }
  const idx = ctx.sessions.findIndex((x) => x.id === sessionId);
  if (idx === -1) return;

  ctx.sessions.splice(idx, 1);
  await deleteSessionFile(ctx.app.vault, getChatHistoryPath(ctx.plugin.settings.chatHistoryPath), sessionId);

  if (ctx.currentSessionId === sessionId) {
    const next = ctx.sessions[0];
    ctx.currentSessionId = next.id;
    await loadSession(ctx, next);
  }
  await saveSessionsMeta(ctx.plugin, ctx.sessions, ctx.currentSessionId);
  ctx.renderSessionMenu();
  new Notice(t("chat.session.deleted"));
}

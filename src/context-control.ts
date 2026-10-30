import type XiaoyuanAgentPlugin from "./main";
import type { ChatSession } from "./types";
import { findOpenCodeConnection } from "./opencode-server";
import { requestOpenCode } from "./opencode-client";

/**
 * 长会话上下文管理：状态查询、压缩、重置。
 *
 * 绑定粒度不是「某条聊天记录」：群聊所有聊天记录共用 `group` 一条，
 * 每个 Agent 的独立会话线各自 `agent:<id>` 一条。所以这里以作用域 key 为入口，
 * 调用方只需给出当前视图的作用域。
 *
 * 所有操作都只用**已经在跑**的连接（findOpenCodeConnection 不会拉起服务），
 * 服务没起时直接返回失败，不为了看一眼状态去等 15 秒启动。
 */

/** 作用域 key：群聊 = group，Agent 独立线 = agent:<id> */
export function scopeKey(ownerAgentId?: string | null): string {
  return ownerAgentId ? `agent:${ownerAgentId}` : "group";
}

/** 从聊天视图解析当前作用域 */
export function scopeOf(view: { sessions?: ChatSession[]; currentSessionId?: string }): string {
  const owner = view.sessions?.find((s) => s.id === view.currentSessionId)?.ownerAgentId;
  return scopeKey(owner);
}

export function boundSessionId(plugin: XiaoyuanAgentPlugin, scope: string): string {
  return plugin.settings.opencodeSessionBindings?.[scope] || "";
}

/** `GET /session/{id}/context` 里我们关心的字段 */
interface ContextItem {
  type?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface ContextStatus {
  sessionId: string;
  /** 上下文里实际包含的消息条数（不含 idle 占位与压缩标记） */
  messageCount: number;
  /** 最近一次请求的 prompt token 数（≈ 当前上下文大小），拿不到为 null */
  tokens: number | null;
  /** 当前模型的上下文窗口（`Model.Info.limit.context`） */
  limit: number | null;
  /** 上下文里已经出现过压缩消息 */
  compacted: boolean;
}

async function runningConn(plugin: XiaoyuanAgentPlugin) {
  const s = plugin.settings;
  return findOpenCodeConnection(s.opencode.port, s.opencode.hostname);
}

/** 读取当前作用域的上下文状态；没有绑定或服务没起时返回 null */
export async function readContextStatus(
  plugin: XiaoyuanAgentPlugin,
  scope: string,
): Promise<ContextStatus | null> {
  const sessionId = boundSessionId(plugin, scope);
  if (!sessionId) return null;
  const conn = await runningConn(plugin);
  if (!conn) return null;

  const items = await requestOpenCode<ContextItem[]>(
    conn.url,
    `/session/${sessionId}/context`,
    "GET",
    undefined,
    conn.authHeader,
  );
  if (!Array.isArray(items)) return null;

  let messageCount = 0;
  let tokens: number | null = null;
  let compacted = false;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "compaction") {
      compacted = true;
      continue;
    }
    if (it.type && it.type !== "idle") messageCount++;
    // 取最后一条带用量的消息：它的 prompt 大小就是当时的上下文规模
    if (it.tokens) {
      const t = it.tokens;
      const total = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      if (total > 0) tokens = total;
    }
  }

  const model = plugin.settings.opencode.model || "";
  const limit = plugin.settings.opencodeModelCaps?.[model]?.contextLimit ?? null;
  return { sessionId, messageCount, tokens, limit, compacted };
}

/**
 * 请求压缩上下文。
 *
 * v2 的 compact 是投递一条 `compaction` 消息，空闲会话会立刻执行（实测 10 秒内
 * 上下文被替换成 compaction + idle）；正在跑的一轮则排到下一个 step 边界。
 */
export async function compactContext(plugin: XiaoyuanAgentPlugin, scope: string): Promise<boolean> {
  const sessionId = boundSessionId(plugin, scope);
  if (!sessionId) return false;
  const conn = await runningConn(plugin);
  if (!conn) return false;
  await requestOpenCode<unknown>(
    conn.url,
    `/session/${sessionId}/compact`,
    "POST",
    {},
    conn.authHeader,
  );
  return true;
}

/**
 * 重置上下文：解除绑定并删掉服务端那条会话，下一条消息会重新建一条空的。
 * 只影响当前作用域（群聊或某个 Agent 的独立线）。
 */
export async function resetContext(plugin: XiaoyuanAgentPlugin, scope: string): Promise<void> {
  const s = plugin.settings;
  const bindings = s.opencodeSessionBindings;
  const sessionId = bindings?.[scope] || "";
  if (bindings && bindings[scope]) {
    delete bindings[scope];
  }
  // 标记「已重置」：下一条消息只发系统提示 + 本轮问题，不回放本地历史
  (s.opencodeContextReset ??= {})[scope] = true;
  await plugin.saveSettings();
  if (!sessionId) return;
  try {
    const conn = await runningConn(plugin);
    if (conn) {
      await requestOpenCode<unknown>(conn.url, `/session/${sessionId}`, "DELETE", undefined, conn.authHeader);
    }
  } catch {
    /* 服务端删不掉也不影响：绑定已解除，本地会重新开一条 */
  }
}

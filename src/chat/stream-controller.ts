import { Notice } from "obsidian";
import type XiaoyuanAgentPlugin from "../main";
import type { ChatCtx } from "./context";
import type { AgentConfig, FileDiff } from "../types";
import { CONTEXT_SNIPPET_MAX, DELEGATION_TIMEOUT_MS, getActiveProvider } from "../constants";
import { callAIWithHTTPStreaming, callAISession, getVaultBasePath } from "../ai";
import { combineAbort } from "../api-client";
import { buildAgentMessages, buildAgentRoster, extractAgentDelegations, resolveAgentTarget } from "../agent-registry";
import { t } from "../i18n";
import { askPermission } from "../modals";
import {
  addMessage,
  addStreamingMessage,
  addSystemMessage,
  addToolLogEntry,
  finalizeStreamingMessage,
  renderDiffs,
  renderQuoteBarFor,
  restoreMessage,
  truncateMessagesIfNeeded,
  updateStreamingMessage,
  updateStreamingThinking,
} from "./renderer";

/**
 * 「正在生成中」的统一守卫。
 * 这段判断以前复制了 6 份，分散在各处，措辞和返回值都不一致。
 */
export function busyGuard(ctx: ChatCtx, notify = true): boolean {
  if (!ctx.abortController) return false;
  if (notify) new Notice(t("chat.waitForResponse"));
  return true;
}

export async function sendMessage(ctx: ChatCtx): Promise<void> {
  if (busyGuard(ctx, false)) return;
  if (!ctx.inputEl) return; // 视图还没构建完就被命令调用（main.ts 的 skill / 定时任务）
  let text = ctx.inputEl.value.trim();
  if (!text) return;
  if (ctx.quoteText) {
    text = `> ${ctx.quoteText}\n\n${text}`;
    ctx.quoteText = "";
    renderQuoteBarFor(ctx);
  }

  const skillMatch = text.match(/^\/(\S+)\s*(.*)/);
  if (skillMatch) {
    const skill = ctx.plugin.settings.skills.find((s) => s.name === skillMatch[1]);
    if (skill) {
      text = `[Skill: ${skill.name} - ${skill.description}]\n\n${skillMatch[2] || skill.description}`;
    }
  }

  const templateMatch = text.match(/^\/template:(\S+)\s*(.*)/);
  if (templateMatch) {
    const tpl = ctx.plugin.settings.promptTemplates.find((x) => x.name === templateMatch[1]);
    // `\s*` 已经把模板和参数之间的空白吃掉了，直接拼接会让参数紧贴模板正文
    if (tpl) text = `${tpl.prompt}${templateMatch[2] ? `\n\n${templateMatch[2]}` : ""}`;
  }

  const { agent, cleanText } = resolveAgentTarget(text, ctx.plugin.settings);
  const target = agent ?? ctx.foreground;
  const finalText = cleanText || text;

  // 守卫必须同步占位：旧实现在 `await addMessage(...)` 之后才赋值 AbortController，
  // 连按两次回车时第二次调用能穿过守卫，产生两条并发 AI 请求、消息交错。
  const controller = new AbortController();
  ctx.abortController = controller;
  ctx.streamingMessageId = null;
  ctx.pendingDiffs = null;
  ctx.pendingToolLogs = [];

  await addMessage(ctx, "user", finalText, "user");
  ctx.updateSessionTitle();
  ctx.inputEl.value = "";
  ctx.setProcessingState(true);

  try {
    await truncateMessagesIfNeeded(ctx);
    const response = await callAI(ctx, finalText, target, controller.signal);
    ctx.attachments = [];
    renderQuoteBarFor(ctx);
    const finalized = await finalizeStreamingMessage(ctx);
    if (!finalized && response) await addMessage(ctx, "assistant", response, target?.name);
    await ctx.saveCurrentSession();
    const pendingDiffs: FileDiff[] | null = ctx.pendingDiffs as FileDiff[] | null;
    if (ctx.plugin.settings.showDiffPreview && finalized && pendingDiffs?.length) {
      renderDiffs(ctx, finalized, pendingDiffs);
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        if (ctx.messages[i].role === "user") {
          restoreMessage(ctx, ctx.messages[i].id);
          break;
        }
      }
      addSystemMessage(ctx, t("chat.interrupted"));
    } else {
      await addMessage(
        ctx,
        "assistant",
        t("chat.error") + ": " + (err instanceof Error ? err.message : String(err)),
        target?.name,
      );
    }
    await ctx.saveCurrentSession();
  } finally {
    ctx.abortController = null;
    ctx.pendingDiffs = null;
    ctx.setProcessingState(false);
    ctx.inputEl.focus();
    // 一轮结束后刷新上下文占用（chip 会异步去查一次，skipSync 避免顺带触发模型同步）
    ctx.rebuildToolbar({ skipSync: true });
  }
}

/**
 * 长会话作用域。
 *
 * opencode 的 project 由目录派生，我们所有会话都在同一个 project 下，它只划分
 * 「能读写哪些文件」，不划分「哪段对话」。所以上下文单位要自己定：
 * 群聊所有聊天记录共用一条，每个 Agent 的独立会话线各自一条。
 */
function sessionScope(ctx: ChatCtx): string {
  const owner = ctx.sessions.find((x) => x.id === ctx.currentSessionId)?.ownerAgentId;
  return owner ? `agent:${owner}` : "group";
}

export async function callAI(
  ctx: ChatCtx,
  userMessage: string,
  target: AgentConfig | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const s = ctx.plugin.settings;
  const source = target?.name || ctx.foreground?.name || "";
  const systemPrompt = target?.systemPrompt || s.systemPrompt;

  let enrichedMessage = userMessage;
  if (ctx.attachments.length > 0) {
    const attachBlocks = await Promise.all(
      ctx.attachments.map(async (att) =>
        att.type.startsWith("image/") ? `![${att.name}](${att.data})` : `[附件: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``,
      ),
    );
    enrichedMessage = attachBlocks.join("\n\n") + "\n\n" + userMessage;
  }

  if (s.showContext) {
    const activeFile = ctx.app.workspace.getActiveFile();
    if (activeFile) {
      const fileContent = await ctx.app.vault.read(activeFile).catch(() => "");
      const contextPreview =
        fileContent.length > CONTEXT_SNIPPET_MAX
          ? fileContent.slice(0, CONTEXT_SNIPPET_MAX) + "\n... (内容已截断)"
          : fileContent;
      enrichedMessage = `[当前笔记: ${activeFile.path}]\n\`\`\`\n${contextPreview}\n\`\`\`\n\n---\n\n${enrichedMessage}`;
    }
  }

  // 注意：富化后的内容只用于本次请求，不回写 ctx.messages。
  // 否则附件/上下文会被永久写进历史，下一轮再次拼接导致内容不断膨胀。
  // 同时把最后一条（刚发出的用户消息）从历史里去掉，
  // 因为 buildAgentMessages 会把 enrichedMessage 再追加一次。
  const lastIsUser = ctx.messages.length > 0 && ctx.messages[ctx.messages.length - 1].role === "user";

  // 会话绑定：同一作用域（群聊 / 某个 Agent 的独立线）只维护一条 OpenCode 会话，
  // 这一轮只发新增内容，历史由服务端保存，不再每轮重发全文。
  const scope = sessionScope(ctx);
  const bindings = (s.opencodeSessionBindings ??= {});
  const boundSessionId = bindings[scope] || "";
  // 刚重置过上下文：这一轮只重建「系统提示 + 本轮问题」，不回放历史
  const resetPending = !!s.opencodeContextReset?.[scope];
  const historyForPrompt = resetPending ? [] : lastIsUser ? ctx.messages.slice(0, -1) : ctx.messages;
  const prompt = buildAgentMessages(historyForPrompt, systemPrompt, enrichedMessage, source, buildAgentRoster(s));

  const rememberBinding = (id: string) => {
    // 旧绑定可能已在服务端失效（被删/换库），此时会新建一条，绑定必须跟着更新
    if (bindings[scope] === id) return;
    bindings[scope] = id;
    if (s.opencodeContextReset?.[scope]) delete s.opencodeContextReset[scope];
    void ctx.plugin.saveSettings();
  };

  // streamingId 必须放在 produce 外面：CLI 失败后 produce(true) 会重试，
  // 若每次都新建局部变量，就会再插一条气泡，上一条残缺的永远留在会话里。
  let streamingId = "";
  const rememberStreamingId = (id: string) => {
    streamingId = id;
    // 记到视图上，定型时按 id 找，避免被后台委托插入的消息顶掉
    ctx.streamingMessageId = id;
    return id;
  };
  const produce = async (skipCli: boolean): Promise<string> => {
    const updateThinking = (text: string) => {
      if (streamingId) updateStreamingThinking(ctx, streamingId, text);
      else rememberStreamingId(addStreamingMessage(ctx, "", text, source));
    };
    const updateText = (text: string) => {
      if (!streamingId) rememberStreamingId(addStreamingMessage(ctx, text, "", source));
      else updateStreamingMessage(ctx, streamingId, text);
    };
    const onDiffs = (diffs: FileDiff[]) => {
      ctx.pendingDiffs = diffs;
    };
    const onTool = (tool: string, status: string) => {
      if (streamingId) addToolLogEntry(ctx, streamingId, tool, status);
      else ctx.pendingToolLogs.push({ tool, status });
    };
    const result =
      target?.channel === "cli" && !skipCli
        ? await callAIWithHTTPStreaming({
            prompt,
            settings: s,
            vaultDir: getVaultBasePath(),
            signal,
            onThinking: updateThinking,
            onTextUpdate: updateText,
            onDiffs,
            onToolProgress: onTool,
            agent: target,
            opencodeSessionId: boundSessionId,
            incrementalPrompt: enrichedMessage,
            onSessionBound: rememberBinding,
            // 权限请求是服务端阻塞态，弹窗让用户拍板；关闭弹窗按拒绝处理
            onPermissionRequest: (req) => askPermission(ctx.app, req),
          })
        : await callAISession({
            prompt,
            settings: s,
            vaultDir: getVaultBasePath(),
            signal,
            skipCli,
            agent: target,
            onThinking: updateThinking,
            onTextUpdate: updateText,
          });
    return result;
  };

  const isCli = target?.channel === "cli";
  try {
    const result = await produce(false);
    if (isCli) ctx.setOpenCodeStatus(true);
    else ctx.setApiStatus(true);
    scheduleDelegations(ctx, result, target, s);
    return result;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if ((err as { name?: string } | null)?.name === "AbortError") throw err;
    if (isCli) {
      // CLI 失败且能降级：交给 callAISession 走 API（skipCli=false 会自己决定）
      const provider = getActiveProvider(s);
      if (!provider?.apiKey) throw err;
      const result = await produce(true);
      ctx.setApiStatus(true);
      scheduleDelegations(ctx, result, target, s);
      return result;
    }
    ctx.setApiStatus(false);
    throw err;
  }
}

/** 收集回复中的 @委托，按并发上限调度后台执行。 */
export function scheduleDelegations(
  ctx: ChatCtx,
  result: string,
  self: AgentConfig | undefined,
  s: XiaoyuanAgentPlugin["settings"],
): void {
  const lastMsg = ctx.messages[ctx.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant") return;
  const delegations = extractAgentDelegations(result, s, self);
  for (const d of delegations) {
    runBackgroundDelegation(ctx, d.agent, d.task);
  }
}

/**
 * 后台委托：并发上限 DELEGATION_CONCURRENCY，单项超时 DELEGATION_TIMEOUT_MS。
 * 与前台调用完全解耦，结果直接落到群里。
 */
export function runBackgroundDelegation(ctx: ChatCtx, agent: AgentConfig, task: string): void {
  addSystemMessage(ctx, t("chat.systemMsg.background", agent.name));
  void (async () => {
    try {
      await ctx.plugin.delegationQueue.run(async () => {
        const result = await callAIForAgent(ctx, agent, task);
        if (result) {
          await addMessage(ctx, "assistant", result, agent.name);
          await ctx.saveCurrentSession();
        }
      });
    } catch (err: unknown) {
      addSystemMessage(ctx, t("chat.systemMsg.bgFailed", agent.name, err instanceof Error ? err.message : String(err)));
    }
  })();
}

/** 独立的后台调用：不依赖 streaming 状态机，直接拿最终文本。 */
export async function callAIForAgent(ctx: ChatCtx, agent: AgentConfig, task: string): Promise<string> {
  const s = ctx.plugin.settings;
  const prompt = buildAgentMessages([], agent.systemPrompt || s.systemPrompt, task, agent.name, buildAgentRoster(s));
  const signal = combineAbort(undefined, DELEGATION_TIMEOUT_MS);
  if (agent.channel === "cli") {
    return callAIWithHTTPStreaming({ prompt, settings: s, vaultDir: getVaultBasePath(), signal, agent });
  }
  return callAISession({
    prompt,
    settings: s,
    vaultDir: getVaultBasePath(),
    signal,
    agent,
    skipCli: true,
  });
}

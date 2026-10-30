import { getActiveProvider } from "./constants";
import * as fs from "fs";
import type {
  AgentConfig,
  XiaoyuanAgentSettings,
  FileDiff,
  OpenCodeEvent,
  OpenCodeEventData,
  OpenCodePermissionRequest,
  OpenCodePermissionDecision,
} from "./types";
import { ensureApiUrl, parseUnifiedDiff } from "./utils";
import {
  requestOpenCode,
  connectSSE,
  combineSignals,
  normalizeEventType,
  pickDeltaText,
  waitSessionIdle,
} from "./opencode-client";
import { ensureOpenCodeServer as ensureOpenCodeServerBase, invalidateOpenCodeConnection } from "./opencode-server";
import { callAIWithAPI, processAPISSEStream } from "./api-client";
import type { SyncPlugin } from "./opencode-sync";
import { AI_REPLY_TIMEOUT_MS, API_REQUEST_TIMEOUT_MS, VIEW_TYPE_XIAOYUAN_AGENT_CHAT } from "./constants";
import { t } from "./i18n";

export { stopOpenCodeServer } from "./opencode-server";
export { fetchOpenCodeModelsFromCLI, fetchOpenCodeAgents, checkOpenCodeStatus } from "./opencode-config";
export { getVaultBasePath } from "./server";

let syncFromConnect = false;

/**
 * 从 `globalThis.app` 取 Obsidian 应用实例。
 * 只是拿 workspace / plugins 两样东西，没必要到处 `(globalThis as any)`。
 */
interface GlobalAppLike {
  workspace?: { getLeavesOfType?: (type: string) => { view?: unknown }[] };
  plugins?: {
    getPlugin?: (id: string) => SyncPlugin | undefined;
    plugins?: Record<string, SyncPlugin | undefined>;
  };
}

function globalApp(): GlobalAppLike | undefined {
  return (globalThis as { app?: GlobalAppLike }).app;
}

export async function ensureOpenCodeServer(
  cliPath: string,
  hostname: string,
  port: number,
  vaultDir: string,
  autoStart: boolean,
  opts: { plugin?: SyncPlugin; skipSync?: boolean } = {},
) {
  const conn = await ensureOpenCodeServerBase(cliPath, hostname, port, vaultDir, autoStart);
  // 连接成功后立即通知所有聊天视图把状态灯标为已连接，
  // 不走 syncOpenCodeState 避免循环（sync 内部会再调 ensureOpenCodeServer）。
  try {
    const leaves = globalApp()?.workspace?.getLeavesOfType?.(VIEW_TYPE_XIAOYUAN_AGENT_CHAT) || [];
    for (const leaf of leaves) {
      const view = leaf.view as { markOpenCodeConnected?: () => void } | undefined;
      view?.markOpenCodeConnected?.();
    }
  } catch {}
  if (opts.skipSync || syncFromConnect) return conn;
  try {
    syncFromConnect = true;
    const { ensureOpenCodeAgents, ensureOpenCodeModels } = await import("./opencode-sync");
    const app = globalApp();
    const plugin: SyncPlugin | undefined =
      opts.plugin || app?.plugins?.getPlugin?.("xiaoyuan-agent") || app?.plugins?.plugins?.["xiaoyuan-agent"];
    const s = plugin?.settings;
    if (!plugin || !s) return conn;
    if (s.execMode === "cli") {
      void ensureOpenCodeModels({ plugin, silent: true, reason: "connected" });
      void ensureOpenCodeAgents({ plugin, silent: true, reason: "connected" });
    } else {
      void ensureOpenCodeModels({ plugin, silent: true, reason: "connected" });
    }
  } catch {
    /* 同步失败不影响本次连接结果 */
  } finally {
    // 旧实现用 `setTimeout(..., 2000)` 复位：定时器没人持有也没人清，
    // 并发调用会叠加多个，2s 内其它合法的同步被静默跳过。直接同步复位即可。
    syncFromConnect = false;
  }
  return conn;
}

/** OpenCode v2 `Session.Info`（已拆掉 `{location, data}` 信封） */
interface V2SessionInfo {
  id?: string;
  title?: string;
}

/** OpenCode v2 `Session.Message.Assistant` 的一条内容块 */
interface V2ContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  executed?: boolean;
  state?: {
    status?: string;
    metadata?: {
      files?: V2FileDiff[];
      truncated?: boolean;
    };
  };
}

/** OpenCode v2 `Session.Message.Assistant` */
interface V2AssistantMessage {
  id?: string;
  type?: string;
  agent?: string;
  content?: V2ContentPart[];
  time?: { created?: number; streamed?: number; completed?: number };
  finish?: string;
  error?: { type?: string; message?: string };
}

/** OpenCode v2 `FileDiff.Info` */
interface V2FileDiff {
  file?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
}

/**
 * `write` 工具落盘前的内容快照。
 *
 * v2 的 `write` 工具是整文件覆写，既不产生 `metadata.files`，
 * 也不在非 git 仓库里留下快照，所以只能在工具执行前自己读一次原文件。
 */
interface WriteSnapshot {
  /** 相对项目根目录的路径（与其它 diff 的 file 字段保持一致） */
  file: string;
  /** 写入前的文件内容（文件不存在时为空串） */
  before: string;
  /** 写入后的文件内容 */
  after: string;
  /** 写入前文件是否存在 */
  existed: boolean;
}

type PartCallback = () => void;

/**
 * 把插件里存的 `provider/model` 转成 v2 的 `Model.Ref`（`{id, providerID, variant?}`）。
 *
 * `variant` 不能瞎带：v2 遇到模型不支持的变体会直接判这一轮失败
 * （实测 `Variant unavailable for opencode/big-pickle: low`）。所以只有在同步到的
 * 变体清单里确实存在时才写进去；拿不到清单就宁可不带——丢掉推理强度只是弱一点，
 * 带错了却是整轮对话直接失败。
 */
function buildModelRef(
  model: string | undefined,
  variant?: string,
  allowedVariants?: string[],
): { id: string; providerID: string; variant?: string } | null {
  if (!model) return null;
  const parts = model.split("/");
  if (parts.length < 2) return null;
  const ref: { id: string; providerID: string; variant?: string } = {
    id: parts.slice(1).join("/"),
    providerID: parts[0],
  };
  if (variant && variant !== "none" && allowedVariants?.includes(variant)) {
    ref.variant = variant;
  }
  return ref;
}

/**
 * 续用长会话时对齐模型 / Agent。
 *
 * 会话是长生命周期的，用户可能在中途换了模型或 @ 了别的 Agent；不重新设置就会
 * 一直沿用建会话时的选择。两个接口都是幂等的，失败也不该打断这一轮对话。
 */
async function applySessionSelection(
  conn: { url: string; authHeader: string },
  sessionId: string,
  modelRef: { id: string; providerID: string; variant?: string } | null,
  agentId: string | undefined,
): Promise<void> {
  if (modelRef) {
    try {
      await requestOpenCode(conn.url, `/session/${sessionId}/model`, "POST", { model: modelRef }, conn.authHeader);
    } catch {
      /* 对齐失败就沿用会话原模型 */
    }
  }
  if (agentId) {
    try {
      await requestOpenCode(conn.url, `/session/${sessionId}/agent`, "POST", { agent: agentId }, conn.authHeader);
    } catch {
      /* 对齐失败就沿用会话原 Agent */
    }
  }
}

function toPluginDiff(info: V2FileDiff): FileDiff {
  const parsed = parseUnifiedDiff(info.patch || "");
  return {
    file: info.file || "",
    before: parsed.before,
    after: parsed.after,
    additions: info.additions ?? 0,
    deletions: info.deletions ?? 0,
    status: info.status,
  };
}

/** 把绝对路径转成相对项目根目录的路径，便于和 opencode 返回的 diff 对齐 */
function relativizePath(filePath: string, baseDir: string): string {
  if (!filePath) return "";
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(baseDir || "");
  const target = norm(filePath);
  if (base && target.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return target.slice(base.length + 1);
  }
  return target;
}

/**
 * 在 `write` 工具真正落盘之前，把原文件内容读出来。
 *
 * 事件里带 `executed: false`，说明工具还没跑，此刻读到的就是改动前的内容。
 * 同一个文件被连续写两次时，只保留**第一次**读到的 before（那时才是原始内容），
 * 但 after 要更新成最新一次的内容。
 */
async function captureWriteSnapshot(
  filePath: string,
  after: string,
  baseDir: string,
  beforePromise: Promise<string | null>,
): Promise<WriteSnapshot> {
  const before = await beforePromise;
  return { file: relativizePath(filePath, baseDir), before: before ?? "", after, existed: before !== null };
}

function readFileOrNull(filePath: string): Promise<string | null> {
  return fs.promises.readFile(filePath, "utf-8").then(
    (v) => v,
    () => null,
  );
}

/** 根据写入前后的内容估算增删行数（与 diff 预览的逐行对比逻辑保持一致） */
function buildWriteDiff(snap: WriteSnapshot): FileDiff {
  const bLines = snap.before ? snap.before.split("\n") : [];
  const aLines = snap.after ? snap.after.split("\n") : [];
  const max = Math.max(bLines.length, aLines.length);
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < max; i++) {
    const b = bLines[i] ?? "";
    const a = aLines[i] ?? "";
    if (b === a) continue;
    if (!b) {
      additions++;
      continue;
    }
    if (!a) {
      deletions++;
      continue;
    }
    additions++;
    deletions++;
  }
  return {
    file: snap.file,
    before: snap.before,
    after: snap.after,
    additions,
    deletions,
    status: snap.existed ? "modified" : "added",
  };
}

/** 从 v2 的 `session.execution.failed` / `session.step.failed` 负载里取出可读错误 */
function extractExecutionError(data: OpenCodeEventData | undefined): string {
  const raw = (data as { error?: unknown } | undefined)?.error;
  if (!raw || typeof raw !== "object") return "";
  const err = raw as { message?: string; type?: string; status?: number };
  const message = typeof err.message === "string" ? err.message : "";
  if (!message) return "";
  const status = typeof err.status === "number" ? ` (${err.status})` : "";
  return `${message}${status}`;
}

/**
 * 从 v2 的消息列表里取出 assistant 回复的纯文本。
 *
 * 一轮对话可能产出多条 assistant 消息（多 step）。旧实现只取最后一条，
 * 前面几步的正文会整段消失；这里按消息顺序把所有 assistant 正文拼起来，
 * 与流式过程中展示的内容保持一致。
 */
function extractAssistantText(messages: V2AssistantMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const m of messages) {
    if (m?.type !== "assistant") continue;
    const text = (m.content || [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 取本轮的推理过程。
 *
 * OpenCode 2.1.4 只发 `session.usage.updated` 里的 reasoning token 数，
 * 不发 `session.reasoning.delta`，所以运行时拿不到增量，只能取最终消息里的
 * `reasoning` 分块；用户看到的是「思考结束后展开的折叠块」。
 */
function extractAssistantThinking(messages: V2AssistantMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const m of messages) {
    if (m?.type !== "assistant") continue;
    const text = (m.content || [])
      .filter((c) => c?.type === "reasoning" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 只保留本轮的消息。
 *
 * `/message` 是**最新在前**的顺序（实测 `idle/assistant/user/synthetic` 依次递减），
 * 而且续用的长会话会返回整段历史：直接全量拼起来会把上一轮的回复混进本轮，
 * 按数组下标切也会切错。这里用时间戳切：以最近一条 `user` 为界，
 * 取比它新的 assistant，再按 created 升序排回正常顺序（多 step 才不会倒序）。
 */
function currentRoundMessages(messages: V2AssistantMessage[] | undefined): V2AssistantMessage[] {
  if (!Array.isArray(messages)) return [];
  const lastUser = messages.find((m) => m?.type === "user");
  const since = lastUser?.time?.created ?? 0;
  return messages
    .filter((m) => m?.type === "assistant" && (m.time?.created ?? 0) >= since)
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
}

/**
 * 从消息里的工具调用结果里提取文件差异。
 *
 * v2 的 `GET /api/session/{id}/diff` 依赖 git 快照，只有在库被 git 管理时才有数据；
 * 工具结果里 `state.metadata.files` 同样带 per-file diff，而且不依赖 git，因此作为兜底。
 *
 * 注意：v2 的 `write` 工具不会产生 `metadata.files`（整文件覆写没有 patch），
 * 这部分靠 `writeSnapshots` 还原。
 */
function extractToolDiffs(
  messages: V2AssistantMessage[] | undefined,
  writeSnapshots?: Map<string, WriteSnapshot>,
): FileDiff[] {
  if (!Array.isArray(messages)) return [];
  const byFile = new Map<string, FileDiff>();
  for (const m of messages) {
    for (const part of m?.content || []) {
      if (part?.type !== "tool") continue;
      for (const f of part.state?.metadata?.files || []) {
        if (!f?.file) continue;
        byFile.set(f.file, toPluginDiff(f));
      }
    }
  }
  if (writeSnapshots) {
    for (const snap of writeSnapshots.values()) {
      if (!snap.existed && snap.after === "") continue;
      // 已经被工具自带的 diff 覆盖的文件以工具数据为准
      if (byFile.has(snap.file)) continue;
      byFile.set(snap.file, buildWriteDiff(snap));
    }
  }
  return [...byFile.values()];
}

export interface HttpStreamOptions {
  prompt: string;
  settings: XiaoyuanAgentSettings;
  vaultDir: string;
  signal?: AbortSignal;
  onConnected?: () => void;
  onThinking?: (text: string) => void;
  onTextUpdate?: (text: string, thinkingText?: string) => void;
  onDiffs?: (diffs: FileDiff[]) => void;
  onToolProgress?: (tool: string, status: string) => void;
  agent?: AgentConfig;
  /** 已绑定的 OpenCode 会话 id；传了就续用服务端上下文，服务端已删则自动新开 */
  opencodeSessionId?: string;
  /** 续用会话时只发这段新增内容；首次建会话仍用 prompt（含完整历史） */
  incrementalPrompt?: string;
  /** 新会话建立且 prompt 写入成功后回调，用于把绑定关系持久化到聊天会话 */
  onSessionBound?: (sessionId: string) => void;
  /**
   * 服务端弹出一条权限请求时回调，返回值决定如何 reply。
   * 不传时默认「允许一次」，避免后台委托卡在等人拍板的状态里直到超时。
   */
  onPermissionRequest?: (req: OpenCodePermissionRequest) => Promise<OpenCodePermissionDecision>;
}

export async function callAIWithHTTPStreaming(options: HttpStreamOptions): Promise<string> {
  // 十个位置参数里经常要塞六七个 `undefined`，稍微错位就是静默的功能丢失，
  // 统一改成具名 options（与 `callAISession` 一致）。
  const { prompt, settings, vaultDir, signal, onConnected, onThinking, onTextUpdate, onDiffs, onToolProgress, agent } = options;
  // 用户点了「停止」就别再往下走了：否则会先去 ensureOpenCodeServer（可能真起一个
  // 服务）、再建会话，最后才在 SSE 阶段发现信号已中止，白跑一整轮。
  if (signal?.aborted) throw new DOMException(t("error.aborted"), "AbortError");

  const conn = await ensureOpenCodeServer(
    settings.opencode.cliPath,
    settings.opencode.hostname,
    settings.opencode.port,
    vaultDir,
    settings.opencode.autoStart,
  );
  onConnected?.();

  // v2: 建会话时就要带上 agent / model / location
  const createBody: Record<string, unknown> = { location: { directory: vaultDir } };
  if (settings.opencode.agent) createBody.agent = settings.opencode.agent;
  // Agent 的 model 覆盖通道默认模型（见 DESIGN.md Q3）
  const chosenModel = agent?.model || settings.opencode.model;
  const modelRef = buildModelRef(
    chosenModel,
    settings.defaultReasoning,
    settings.opencodeModelCaps?.[chosenModel]?.variants,
  );
  if (modelRef) createBody.model = modelRef;

  // 续用已绑定的会话：服务端自己维护上下文，这一轮只发新增内容。
  // 先用 GET 探活，避免会话被删 / 服务端换库后对着不存在的 id 发 prompt。
  let sessionId = "";
  let reused = false;
  // 新会话是否已写入 prompt 并被保留（决定 finally 里删不删）
  let bound = false;
  const boundId = options.opencodeSessionId || "";
  if (boundId) {
    const existing = await requestOpenCode<V2SessionInfo>(
      conn.url,
      `/session/${boundId}`,
      "GET",
      undefined,
      conn.authHeader,
    ).catch(() => null);
    if (existing?.id) {
      sessionId = boundId;
      reused = true;
      // 会话是长生命周期的，模型/Agent 可能已被用户改过，每轮重新对齐一次
      await applySessionSelection(conn, sessionId, modelRef, settings.opencode.agent);
    }
  }

  if (!sessionId) {
    const session = await requestOpenCode<V2SessionInfo>(conn.url, "/session", "POST", createBody, conn.authHeader);
    sessionId = session?.id || "";
  }
  if (!sessionId) throw new Error(t("error.sessionCreate"));

  // 用户点「停止」时，除了掐掉本地流，还要真的停掉服务端执行，否则 AI 会在后台
  // 继续跑完、把已经停掉的内容算进上下文。只监听外部 signal：内部收尾用的是
  // sseAbort，不能误伤正常结束。
  const interruptOnAbort = () => {
    void requestOpenCode<unknown>(
      conn.url,
      `/session/${sessionId}/interrupt`,
      "POST",
      undefined,
      conn.authHeader,
    ).catch(() => {});
  };
  signal?.addEventListener("abort", interruptOnAbort, { once: true });

  // v2 的一轮对话可能包含多个 assistant message（多 step），按 messageID 分桶累计
  const textByMessage = new Map<string, string>();
  const thinkingByMessage = new Map<string, string>();
  const toolNames = new Map<string, string>();
  // 已经上报过"运行中"的工具，避免 tool.input.started / tool.called 重复触发
  const reportedTools = new Set<string>();
  // v2 的 write 工具不带 diff，这里在工具执行前先存一份原文件内容
  const writeSnapshots = new Map<string, Promise<WriteSnapshot>>();
  // 同一文件被写多次时，只保留第一次读到的「原始内容」
  const writeBefores = new Map<string, Promise<string | null>>();
  // 多 step 时每个 messageID 一个桶，展示给用户的是所有桶按顺序拼起来的内容。
  // 旧实现直接 `currentText = 当前桶`，第二个 step 一开始就把上一步的正文清掉了。
  const joinBuckets = (buckets: Map<string, string>) => [...buckets.values()].filter((v) => v).join("\n\n");
  let currentText = "";
  let currentThinking = "";

  const sseAbort = new AbortController();
  const combinedSig = combineSignals(signal, sseAbort.signal);

  let idleResolve: PartCallback | null = null;
  let idleReject: ((err: Error) => void) | null = null;
  const idlePromise = new Promise<void>((resolve, reject) => {
    idleResolve = resolve;
    idleReject = reject;
  });
  let sseError: Error | null = null;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    const resolve = idleResolve;
    idleResolve = null;
    idleReject = null;
    resolve?.();
  };
  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    const reject = idleReject;
    idleResolve = null;
    idleReject = null;
    reject?.(err);
  };

  /**
   * 事件流断线重连后的对账：用消息列表补齐断开期间丢失的正文；
   * 如果这一轮其实已经在断线期间结束了（time.idle 已写入），直接收尾，
   * 否则会一直等不到 session.idle，卡到 5 分钟超时。
   */
  const reconcileAfterReconnect = async (): Promise<void> => {
    try {
      const messages = await requestOpenCode<V2AssistantMessage[]>(
        conn.url,
        `/session/${sessionId}/message?limit=50`,
        "GET",
        undefined,
        conn.authHeader,
      );
      const text = extractAssistantText(currentRoundMessages(messages));
      if (text && text !== currentText) {
        currentText = text;
        onTextUpdate?.(text, currentThinking);
      }
      const info = await requestOpenCode<{ time?: { idle?: number } }>(
        conn.url,
        `/session/${sessionId}`,
        "GET",
        undefined,
        conn.authHeader,
      );
      const idleAt = (info as { time?: { idle?: number } } | null)?.time?.idle;
      // 旧的一轮 idle 会一直留在会话上，只有「本轮开始之后」的才算收尾
      if (idleAt && idleAt >= promptSentAt) {
        sseAbort.abort();
        settle();
        return;
      }
      // 上一轮还没收尾：`/wait` 会阻塞到服务端真正 idle，比自己猜 idle 准确。
      // 超时 / 接口不存在时返回 false，交回事件流和上层超时兜底。
      if (await waitSessionIdle(conn.url, conn.authHeader, sessionId)) {
        sseAbort.abort();
        settle();
      }
    } catch {
      // 对账失败不改变主流程，等下一帧事件或超时兜底
    }
  };

  // 权限请求是「服务端等人拍板」的阻塞状态：不 reply，这一轮就一直不结束。
  // 事件流里没有稳定可用的 permission 事件名，按契约直接轮询 pending 列表。
  const seenPermissions = new Set<string>();
  let permissionTimer: ReturnType<typeof setInterval> | undefined;
  const handlePermissions = async (): Promise<void> => {
    const pending = await requestOpenCode<OpenCodePermissionRequest[]>(
      conn.url,
      `/session/${sessionId}/permission`,
      "GET",
      undefined,
      conn.authHeader,
    ).catch(() => null);
    if (!Array.isArray(pending)) return;
    for (const req of pending) {
      if (!req?.id || seenPermissions.has(req.id)) continue;
      if (signal?.aborted) return;
      seenPermissions.add(req.id);
      let decision: OpenCodePermissionDecision = "once";
      try {
        decision = (await options.onPermissionRequest?.(req)) || "once";
      } catch {
        decision = "reject";
      }
      await requestOpenCode<unknown>(
        conn.url,
        `/session/${sessionId}/permission/${req.id}/reply`,
        "POST",
        { decision },
        conn.authHeader,
      ).catch(() => {});
    }
  };

  // 看门狗：事件流可能「不报错也不结束」（Electron net 静默挂住时就是这样），
  // 期间既没有 session.idle 也没有 EOF，这一轮就会一直等下去。
  // 直接问服务端「本轮是否已收尾」最可靠：`time.idle` 会被新的一轮复用成旧值，
  // 所以只认「发 prompt 之后写入的 idle」。
  let idleWatch: ReturnType<typeof setInterval> | undefined;
  let promptSentAt = 0;
  const checkServerIdle = async (): Promise<void> => {
    if (settled) return;
    const info = await requestOpenCode<{ time?: { idle?: number } }>(
      conn.url,
      `/session/${sessionId}`,
      "GET",
      undefined,
      conn.authHeader,
    ).catch(() => null);
    if (settled) return;
    const idleAt = info?.time?.idle;
    if (idleAt && idleAt >= promptSentAt) {
      sseAbort.abort();
      settle();
    }
  };

  try {
    connectSSE(
      conn.url,
      conn.authHeader,
      combinedSig,
      (evt: OpenCodeEvent) => {
        const data = evt.data || {};
        // 只关心本会话的事件
        const evtSessionId = data.sessionID || data.sessionId || "";
        if (evtSessionId && evtSessionId !== sessionId) return;
        const messageId = data.assistantMessageID || data.assistantMessageId || data.messageID || "";
        // 事件名归一化，扛住未来版本可能的事件重命名
        const evtType = normalizeEventType(evt.type);

        switch (evtType) {
          case "session.text.started": {
            if (!messageId) return;
            textByMessage.set(messageId, textByMessage.get(messageId) || "");
            return;
          }
          case "session.text.delta": {
            if (!messageId) return;
            textByMessage.set(messageId, (textByMessage.get(messageId) || "") + pickDeltaText(data));
            currentText = joinBuckets(textByMessage);
            onTextUpdate?.(currentText, currentThinking);
            return;
          }
          case "session.text.ended": {
            if (!messageId) return;
            const next = typeof data.text === "string" ? data.text : textByMessage.get(messageId) || "";
            textByMessage.set(messageId, next);
            currentText = joinBuckets(textByMessage);
            onTextUpdate?.(currentText, currentThinking);
            return;
          }
          case "session.reasoning.started": {
            if (!messageId) return;
            thinkingByMessage.set(messageId, thinkingByMessage.get(messageId) || "");
            return;
          }
          case "session.reasoning.delta": {
            if (!messageId) return;
            thinkingByMessage.set(messageId, (thinkingByMessage.get(messageId) || "") + pickDeltaText(data));
            currentThinking = joinBuckets(thinkingByMessage);
            onThinking?.(currentThinking);
            return;
          }
          case "session.reasoning.ended": {
            if (!messageId) return;
            const next = typeof data.text === "string" ? data.text : thinkingByMessage.get(messageId) || "";
            thinkingByMessage.set(messageId, next);
            currentThinking = joinBuckets(thinkingByMessage);
            onThinking?.(currentThinking);
            return;
          }
          case "session.tool.input.started":
          case "session.tool.called": {
            const toolId = data.id || "";
            const toolName = data.name || toolNames.get(toolId) || "";
            if (toolId && toolName) toolNames.set(toolId, toolName);
            // v2 会先后发 tool.input.started 和 tool.called，这里只上报一次
            if (toolName && (!toolId || !reportedTools.has(toolId))) {
              if (toolId) reportedTools.add(toolId);
              onToolProgress?.(toolName, "running");
            }
            // v2 的 write 工具不会给出 diff，工具执行前先把原文件内容存下来
            if (evtType === "session.tool.called" && toolName === "write") {
              const input = data.input as { path?: string; content?: string } | undefined;
              const target = input?.path;
              if (target && typeof input?.content === "string") {
                // 同一个文件连写两次时：before 沿用第一次读到的（那时才是原始内容），
                // after 更新成最新一次写入的内容。旧实现要求「没存过才存」，
                // 于是保留的是第一次的 after，diff 预览是错的。
                let before = writeBefores.get(target);
                if (!before) {
                  before = readFileOrNull(target);
                  writeBefores.set(target, before);
                }
                writeSnapshots.set(target, captureWriteSnapshot(target, input.content, vaultDir, before));
              }
            }
            return;
          }
          case "session.tool.success": {
            const toolId = data.id || "";
            const toolName = data.name || toolNames.get(toolId) || "";
            if (toolName) onToolProgress?.(toolName, "completed");
            return;
          }
          case "session.tool.error": {
            const toolId = data.id || "";
            const toolName = data.name || toolNames.get(toolId) || "";
            if (toolName) onToolProgress?.(toolName, "error");
            return;
          }
          case "session.execution.succeeded": {
            sseAbort.abort();
            settle();
            return;
          }
          case "session.execution.failed": {
            sseAbort.abort();
            fail(new Error(extractExecutionError(data) || t("error.opencodeExec")));
            return;
          }
          default:
            return;
        }
      },
      () => {
        settle();
      },
      (err) => {
        // 已经正常结束时，abort 触发的 ECONNRESET 不算错误
        if (settled) return;
        sseError = err;
        settle();
      },
      // sessionId = 开启「真 SSE + 断线重连 + 最后降级轮询」的完整通道链。
      // 重连接通后会先对账，补齐断线期间丢掉的正文。
      sessionId,
      reconcileAfterReconnect,
    );

    // 必须等 SSE 订阅建立后再发 prompt，否则会漏掉最早的事件
    // v2: prompt 正文是纯文本，agent/model 已在建会话时指定
    // 续用会话时只发这一轮的新增内容，历史由服务端保存，不再重发全文
    const promptText = reused && options.incrementalPrompt ? options.incrementalPrompt : prompt;
    promptSentAt = Date.now();
    await requestOpenCode(conn.url, `/session/${sessionId}/prompt`, "POST", { text: promptText }, conn.authHeader);
    // prompt 发出去之后才开始盯权限：上一轮残留的请求不该再弹给用户
    void handlePermissions();
    permissionTimer = setInterval(() => void handlePermissions(), 1000);
    idleWatch = setInterval(() => void checkServerIdle(), 3000);
    if (!reused && options.onSessionBound) {
      // prompt 已经进了服务端，之后才可以把它当长会话续用。
      // 没有绑定回调的调用（设置页测试、后台委托）仍然按一次性会话处理。
      bound = true;
      options.onSessionBound(sessionId);
    }

    // 超时定时器必须持有并在 race 结束后清掉：旧实现从不 clearTimeout，
    // 于是每问一次就多挂一个 5 分钟的活跃定时器。
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Error>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(t("error.replyTimeout"))), AI_REPLY_TIMEOUT_MS);
    });
    timeoutPromise.catch(() => {}); // race 输了也不会变成 unhandled rejection
    try {
      const timeoutErr = await Promise.race([idlePromise.then(() => null), timeoutPromise]);
      if (timeoutErr) throw timeoutErr;
    } finally {
      clearTimeout(timeoutTimer);
    }
    if (signal?.aborted) throw new DOMException(t("error.aborted"), "AbortError");

    sseAbort.abort();

    // 最终文本以服务端消息为准（SSE 断连期间的事件会丢失）
    let messages: V2AssistantMessage[] = [];
    // SSE 已经出错时再拉一次消息列表纯属多余的网络往返，直接把原错误抛出去
    if (sseError) throw sseError;
    try {
      messages = await requestOpenCode<V2AssistantMessage[]>(
        conn.url,
        `/session/${sessionId}/message?limit=50`,
        "GET",
        undefined,
        conn.authHeader,
      );
    } catch (err: unknown) {
      if (sseError) throw sseError;
      throw err;
    }

    // 只取本轮消息：续用会话时历史回复不能混进这一轮的结果
    const roundMessages = currentRoundMessages(messages);
    const result = extractAssistantText(roundMessages);
    // 2.1.4 不会把推理过程作为事件流出来（只有 token 计数），
    // 思考正文只存在于消息体的 reasoning 分块里，只能在一轮结束时补上
    if (!currentThinking) {
      const serverThinking = extractAssistantThinking(roundMessages);
      if (serverThinking) {
        currentThinking = serverThinking;
        onThinking?.(serverThinking);
      }
    }
    const snapshots = await Promise.all([...writeSnapshots.values()]).catch(() => [] as WriteSnapshot[]);
    if (result) {
      onTextUpdate?.(result, currentThinking);
      await pushSessionDiffs(conn.url, sessionId, conn.authHeader, roundMessages, snapshots, onDiffs, !reused);
      return result;
    }

    // 没有拿到文本：如果 SSE 正常结束说明确实没有回复，否则抛出连接错误
    if (sseError) throw sseError;
    if (currentText) {
      await pushSessionDiffs(conn.url, sessionId, conn.authHeader, roundMessages, snapshots, onDiffs, !reused);
      return currentText;
    }
    // 服务端明确标了这一轮失败（模型中止、请求报错）时给出真实原因，
    // 否则只会看到笼统的「未找到 assistant 回复」
    const lastAssistant = roundMessages[roundMessages.length - 1];
    if (lastAssistant?.error?.message) {
      if (lastAssistant.error.type === "aborted") throw new DOMException(t("error.aborted"), "AbortError");
      throw new Error(lastAssistant.error.message);
    }
    throw new Error(t("error.noAssistantReply"));
  } finally {
    signal?.removeEventListener("abort", interruptOnAbort);
    if (permissionTimer) clearInterval(permissionTimer);
    if (idleWatch) clearInterval(idleWatch);
    sseAbort.abort();
    // 绑定的长会话要留给下一轮；只有一次性调用（设置页测试、后台委托）才删
    if (!bound && !reused) {
      try {
        await requestOpenCode(conn.url, `/session/${sessionId}`, "DELETE", undefined, conn.authHeader);
      } catch {}
    }
  }
}

/**
 * v2: 会话结束后统一拉取文件差异。
 *
 * 优先用 `GET /api/session/{id}/diff`（整轮的净差异，依赖 git 快照）；
 * 拿不到时退回工具结果里的 `state.metadata.files`（不依赖 git），
 * 再兜底用 `write` 工具落盘前的内容快照。
 */
async function pushSessionDiffs(
  url: string,
  sessionId: string,
  authHeader: string,
  messages: V2AssistantMessage[] | undefined,
  writeSnapshots: WriteSnapshot[],
  onDiffs?: (diffs: FileDiff[]) => void,
  /** 续用会话时 `/diff` 会把历史轮次的改动一起返回，只能靠本轮工具结果 */
  wholeSessionDiff = true,
): Promise<void> {
  if (!onDiffs) return;
  let diffs: FileDiff[] = [];
  if (wholeSessionDiff) {
    try {
      const raw = await requestOpenCode<V2FileDiff[]>(url, `/session/${sessionId}/diff`, "GET", undefined, authHeader);
      if (Array.isArray(raw)) diffs = raw.map(toPluginDiff).filter((d) => d.file);
    } catch {}
  }
  if (!diffs.length) {
    const snapMap = new Map<string, WriteSnapshot>();
    for (const s of writeSnapshots) snapMap.set(s.file, s);
    diffs = extractToolDiffs(messages, snapMap);
  }
  if (diffs.length) onDiffs(diffs);
}

export interface CallAISessionOptions {
  prompt: string;
  settings: XiaoyuanAgentSettings;
  vaultDir: string;
  signal?: AbortSignal;
  onThinking?: (text: string) => void;
  onTextUpdate?: (text: string) => void;
  onDiffs?: (diffs: FileDiff[]) => void;
  /** 调用方已经自己跑过一次 CLI 通道时置 true，避免失败后再重复跑一整轮 CLI */
  skipCli?: boolean;
  /**
   * 目标 Agent：通道与模型都取自它；不传则按 settings.execMode（当前前台默认）。
   * 聊天里 @ 了具体 Agent 时应当传 —— 否则 CLI 默认下 @小A 会被路由到 OpenCode，
   * 「随时 @ 另一个」就落空了。
   */
  agent?: AgentConfig;
  /**
   * 单独注入的 system 角色消息；不传表示「系统提示词已经拼在 prompt 里了」。
   * chat-view 会把系统提示词和「当前助手: X」写成 [系统]: ... 嵌进 prompt。
   * 再传一份会变成两份措辞不同的提示词互相打架，还会丢掉身份标识。
   */
  systemPrompt?: string;
}

export async function callAISession(options: CallAISessionOptions): Promise<string> {
  const { prompt, settings, vaultDir, signal, onThinking, onTextUpdate, onDiffs, skipCli, agent, systemPrompt } = options;
  const target = agent;
  const channel = target?.channel ?? settings.execMode;
  const useCli = channel === "cli";
  if (!skipCli && useCli) {
    try {
      return await callAIWithHTTPStreaming({
        prompt,
        settings,
        vaultDir,
        signal,
        onThinking,
        onTextUpdate,
        onDiffs,
        agent: target,
      });
    } catch (err: unknown) {
      // 中断是用户意图，不能吞掉后继续往 API 发请求
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (signal?.aborted) throw err;
      console.warn("CLI 调用失败，降级到 API:", err);
      // 丢掉缓存的连接，下次调用重新解析（服务可能重启 / 端口变了 / 密码变了）
      invalidateOpenCodeConnection();
    }
  }
  const provider = getActiveProvider(settings);
  if (!provider || !provider.apiKey) throw new Error(t("chat.ai.error.apiKey"));
  // Agent 的 model 覆盖 API 通道默认模型（见 DESIGN.md Q3）
  const model = target?.model || provider.model;
  // 系统提示词只在调用方明确要求时注入，不再由这里猜「当前 Agent 是谁」
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });
  const resp = await callAIWithAPI(
    ensureApiUrl(provider.baseUrl),
    provider.apiKey,
    model,
    messages,
    settings.maxTokens,
    settings.temperature,
    true,
    signal,
    settings.apiReasoningEffort,
    // 普通对话没传 signal 时请求可以无限挂住，这里兜一个超时
    API_REQUEST_TIMEOUT_MS,
  );
  return processAPISSEStream(resp, onThinking, onTextUpdate);
}

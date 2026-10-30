import { Notice, requestUrl } from "obsidian";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import type { OpenCodeEvent } from "./types";
import { t } from "./i18n";

/**
 * OpenCode v2 客户端。
 *
 * 传输层的两个关键决定（针对本机 Obsidian 环境实测调整）：
 *
 * 1) **REST 一律走 Obsidian 的 requestUrl()**，不再用渲染进程的 Node http。
 *    之前 Node http 的 GET 会被卡住约 8~12 秒后 ECONNRESET（连不存在的端口也会
 *    等满同样的时间），说明请求压根没到本机服务，而是被渲染进程的网络栈/代理路径
 *    吞掉了；而同一个进程里 POST /api/session 却能 49ms 成功。requestUrl 跑在
 *    Electron 主进程，是插件里发 HTTP 的正道，绕开了这个坑。
 *
 * 2) **事件流用 fetch 流式**读 SSE。requestUrl 不支持流式，所以 /api/event 只能靠
 *    fetch；插件的 API 通道本来就是用 fetch 处理流式响应的，路径一致。
 */

/** OpenCode v2 服务端连接（url + 鉴权头） */
export interface ServerConn {
  url: string;
  authHeader: string;
}

const API_PREFIX = "/api";
const AUTH_USER = "opencode";

/** v2 鉴权方式：Basic opencode:<password> */
export function buildAuthHeader(password?: string | null): string {
  if (!password) return "";
  return `Basic ${Buffer.from(`${AUTH_USER}:${password}`).toString("base64")}`;
}

export function toApiPath(apiPath: string): string {
  if (!apiPath) return API_PREFIX;
  const clean = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (clean === API_PREFIX || clean.startsWith(`${API_PREFIX}/`)) return clean;
  return `${API_PREFIX}${clean}`;
}

/** 把 v2 的 `{ location, data }` 信封里的 `data` 拆出来 */
export function unwrapEnvelope<T>(parsed: unknown): T {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if ("data" in obj) {
      // v2 实际有三种信封，缺一个就会把包装对象当成业务数据：
      //   { location, data }  —— /model /provider /agent
      //   { data }            —— /session/:id 之类（单键）
      //   { data, cursor }    —— 列表型（/session、/session/:id/message）
      // 这里只认这三种，其余（比如 /info 的 {version,pid,...}）原样返回。
      const others = Object.keys(obj).filter((k) => k !== "data");
      const isEnvelope =
        others.length === 0 || others.every((k) => k === "location" || k === "cursor");
      if (isEnvelope) return obj.data as T;
    }
  }
  return parsed as T;
}

/** 把 SSE 事件名归一化成插件内部使用的标准名 */
export function normalizeEventType(rawType: string): string {
  if (!rawType) return "";
  const type = rawType.trim();
  const segments = type.split(".");
  const action = segments[segments.length - 1];
  const has = (name: string) => segments.includes(name);
  if (has("reasoning") && /^(started|delta|ended)$/.test(action)) return `session.reasoning.${action}`;
  if (has("text") && /^(started|delta|ended)$/.test(action)) return `session.text.${action}`;
  if (/\.tool\.input\.started$/.test(type)) return "session.tool.input.started";
  if (/\.tool\.called$/.test(type)) return "session.tool.called";
  if (/\.tool\.success$/.test(type)) return "session.tool.success";
  if (/\.tool\.succeed(?:s|ed)?$/.test(type)) return "session.tool.success";
  if (/\.tool\.error(?:ed)?$/.test(type)) return "session.tool.error";
  if (/\.execution\.succeeded$/.test(type)) return "session.execution.succeeded";
  if (/\.execution\.failed$/.test(type)) return "session.execution.failed";
  return type;
}

/** 从增量事件里取文本内容（兼容可能的字段改名） */
export function pickDeltaText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  for (const key of ["delta", "text", "content", "chunk", "value"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** 从 v2 的错误响应体里提取可读信息 */
export function extractErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.error) {
    const errObj = obj.error;
    if (typeof errObj === "string") return errObj;
    const errMap = errObj as Record<string, unknown>;
    return (
      (errMap.message as string)
      || ((errMap.data as Record<string, unknown>)?.message as string)
      || JSON.stringify(errObj)
    );
  }
  if (typeof obj._tag === "string" && typeof obj.message === "string") return obj.message;
  return null;
}

/** 合并多个 AbortSignal，任意一个 abort 即整体 abort */
export function combineSignals(...sigs: (AbortSignal | undefined)[]): AbortSignal {
  const ctrl = new AbortController();
  const cleanup: (() => void)[] = [];
  for (const s of sigs) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    const handler = () => {
      ctrl.abort(s.reason);
    };
    s.addEventListener("abort", handler, { once: true });
    cleanup.push(() => s.removeEventListener("abort", handler));
  }
  const origAbort = ctrl.abort.bind(ctrl);
  ctrl.abort = (reason?: unknown) => {
    for (const c of cleanup) c();
    origAbort(reason);
  };
  return ctrl.signal;
}

// ============================================================================
// 服务注册信息（service.json）——自建实例的密码来源
// ============================================================================

/**
 * `serve` 没有 --password 参数，但支持 `OPENCODE_SERVER_PASSWORD` 环境变量（官方文档）；
 * 不指定时由 opencode 自行生成密码并写到用户级 service.json。
 *
 * 顺序很重要：**state 目录里的那份才带 url / pid / version**，`.config` 下的只有
 * password。先读 state，才能直接复用已运行的托管实例，而不是每次去猜端口。
 */
function serviceJsonPaths(): string[] {
  const home = os.homedir();
  return [
    process.env.XDG_STATE_HOME
      ? path.join(process.env.XDG_STATE_HOME, "opencode", "service.json")
      : "",
    path.join(home, ".local", "state", "opencode", "service.json"),
    path.join(home, ".config", "opencode", "service.json"),
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode", "service.json")
      : "",
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode", "service.json")
      : "",
    path.join(home, ".local", "share", "opencode", "service.json"),
    path.join(home, ".opencode", "service.json"),
  ].filter(Boolean);
}

function readServiceJson(): Record<string, unknown> | null {
  for (const file of serviceJsonPaths()) {
    try {
      if (!fsSync.existsSync(file)) continue;
      const raw = fsSync.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 没有 password 的文件（半截写入 / 旧格式）直接跳过，继续找下一份
      if (parsed && typeof parsed === "object" && typeof parsed.password === "string" && parsed.password.trim()) {
        return parsed;
      }
    } catch {
      // 文件可能正在被写或被锁，跳过换下一个候选
    }
  }
  return null;
}

/** 候选密码：service.json 里那份（这是 v2 唯一的真实来源） */
export function candidatePasswords(): string[] {
  const reg = readServiceJson();
  const pw = typeof reg?.password === "string" ? (reg.password as string).trim() : "";
  return pw ? [pw] : [];
}

/** 读取 service.json 里的注册信息（password 是唯一可靠字段） */
export function readServiceRegistration(): { url: string; password: string } | null {
  const reg = readServiceJson();
  if (!reg) return null;
  const password = typeof reg.password === "string" ? reg.password.trim() : "";
  if (!password) return null;
  const url = typeof reg.url === "string" ? reg.url : "";
  return { url, password };
}

// ============================================================================
// REST 请求（requestUrl 实现）
// ============================================================================

function joinUrl(base: string, apiPath: string): string {
  const root = (base || "").replace(/\/+$/, "");
  const tail = toApiPath(apiPath);
  return `${root}${tail.startsWith("/") ? tail : `/${tail}`}`;
}

function parseBody(text: string): unknown {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function describeStatus(status?: number): string {
  return `OpenCode API HTTP ${status ?? "??"}`;
}

/**
 * 统一的 requestUrl 调用。
 *
 * requestUrl 没有 timeout 参数，这里自己兜一层超时：超时后 reject（请求本身还在飞，
 * 但响应会被丢掉，不会让 UI 干等到天荒地老）。
 */
async function doRequest(
  url: string,
  method: string,
  authHeader?: string,
  body?: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("OpenCode API 请求超时")), timeoutMs);
  });
  timeoutPromise.catch(() => {}); // 别让它变成 unhandled rejection

  try {
    const resp = await Promise.race([
      requestUrl({
        url,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
      }),
      timeoutPromise,
    ]);
    const text = typeof resp.text === "string" ? resp.text : "";
    if (resp.status < 200 || resp.status >= 300) {
      const parsed = parseBody(text);
      const detail = extractErrorMessage(parsed);
      throw new Error(detail || `${describeStatus(resp.status)} ${text.slice(0, 200)}`.trim());
    }
    return parseBody(text);
  } finally {
    clearTimeout(timer);
  }
}

/** GET 请求（自动拆信封） */
export function httpGetOpenCode(baseUrl: string, apiPath: string, authHeader?: string): Promise<unknown> {
  return doRequest(joinUrl(baseUrl, apiPath), "GET", authHeader).then((raw) => unwrapEnvelope(raw));
}

/** 通用请求（自动拆信封） */
export function requestOpenCode<T>(
  base: string,
  apiPath: string,
  method: string,
  body?: Record<string, unknown> | undefined,
  authHeader?: string,
): Promise<T> {
  return doRequest(joinUrl(base, apiPath), method, authHeader, body).then((raw) => unwrapEnvelope<T>(raw));
}

/**
 * 阻塞等待会话进入 idle：`POST /experimental/session/{id}/wait` → 204。
 *
 * 断线重连后用它替代反复 GET 猜 idle：服务端自己知道这一轮什么时候收尾。
 * requestUrl 没有 abort 能力，只能靠超时兜底；超时 / 接口不存在都返回 false，
 * 由事件流与上层超时继续兜。
 */
export async function waitSessionIdle(
  base: string,
  authHeader: string | undefined,
  sessionId: string,
  timeoutMs = 60000,
): Promise<boolean> {
  try {
    await doRequest(
      joinUrl(base, `/experimental/session/${sessionId}/wait`),
      "POST",
      authHeader,
      undefined,
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

/** 读取服务端信息：GET /api/info（该响应不走信封，unwrapEnvelope 会原样返回） */
export function getServerInfo(
  baseUrl: string,
  authHeader?: string,
  timeoutMs = 6000,
): Promise<{ version?: string; pid?: number; urls?: string[] }> {
  return doRequest(joinUrl(baseUrl, "/info"), "GET", authHeader, undefined, timeoutMs).then((raw) => {
    const val = unwrapEnvelope<{ version?: string; pid?: number; urls?: string[] }>(raw);
    return val ?? {};
  });
}

/** 健康检查：能吃下 /api/info 就算活着。timeoutMs 短一些，避免偶发卡住把状态判死 */
export async function healthCheck(baseUrl: string, authHeader?: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const info = await getServerInfo(baseUrl, authHeader, timeoutMs);
    return !!info && Object.keys(info).length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// 事件流（SSE，fetch 流式实现）
// ============================================================================

function parseSseFrames(buffer: string, onFrame: (payload: string) => void): string {
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const payloads: string[] = [];
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      // v2 的心跳是 `: heartbeat`，空行和注释都不能当数据
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data:")) payloads.push(trimmed.slice(5).trim());
    }
    if (payloads.length) onFrame(payloads.join("\n"));
    boundary = rest.indexOf("\n\n");
  }
  return rest;
}

/** 事件流连续中断多少次后放弃重连 */
const SSE_RECONNECT_MAX = 5;
/** 重连退避起始值，指数退避，上限 30 秒 */
const SSE_RECONNECT_BASE_MS = 500;
/** 一条连接活过这么久就认为它是稳定的，重新计数 */
const SSE_STABLE_MS = 5000;

/**
 * 订阅 `/api/event` 事件流。
 *
 * 结束/中止语义：
 * - 收到终止事件 / ai.ts 主动 abort → 由 ai.ts 自己收尾
 * - 中途 EOF / 报错 → **不当作完成**，退避后重连（最多 5 次）
 * - 重连成功后先回调 onReconnect，让上层用消息列表补齐断流期间丢失的内容
 *
 * `/api/event` 是易失流（服务端契约如此），断流期间的事件不会重放；所以重连后
 * 必须靠 onReconnect 做一次对账，否则正文会停在断开那一刻。
 */
export function connectSSE(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone?: () => void,
  onError?: (err: Error) => void,
  sessionId?: string,
  onReconnect?: () => void,
): void {
  // 没有 sessionId 的场景（探测/一次性监听）保持原样，不做重连
  if (!sessionId) {
    startSseFetch(base, authHeader, signal, onEvent, onDone, onError);
    return;
  }

  let attempt = 0;
  let reconnecting = false;
  let stopped = false;
  let openedAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
  signal.addEventListener("abort", stop, { once: true });
  // 主动中止（用户点「停止」）不会再走重连，必须在这里通知上层收尾。
  // 各条通道在 abort 时只会 close，不会回调 onDone，否则 idlePromise 永远等不到
  // 结算，表现就是「点了停止没反应，一直转到超时」。
  signal.addEventListener("abort", () => onDone?.(), { once: true });

  const fetchFallback = () => {
    startSseFetchWithFallback(
      base,
      authHeader,
      signal,
      handleEvent,
      onDone,
      onError,
      sessionId,
      scheduleReconnect,
    );
  };
  const run = () => {
    reconnectTimer = undefined;
    if (stopped) return;
    openedAt = Date.now();
    // 轮询是最后一条通道，它能自己判断整轮结束；只有「真 SSE 出过事件后断流」
    // 才交回重连，避免把断线当完成、也避免和轮询互相打架。
    //
    // 注意降级顺序：Electron net 在 Obsidian 里很可能握手静默失败，这时不能直接
    // 跳到 fetch（渲染进程会被 CORS 拦），也不能直接跳到轮询——原始 TCP 仍然可用，
    // 而且逐字流式。所以 net 失败后先试 TCP，TCP 也不行才走 fetch / 轮询。
    const degraded = () => {
      if (startSseRawSocket(base, authHeader, signal, handleEvent, scheduleReconnect, fetchFallback)) return;
      fetchFallback();
    };
    if (startSseNet(base, authHeader, signal, handleEvent, scheduleReconnect, degraded)) return;
    if (startSseRawSocket(base, authHeader, signal, handleEvent, scheduleReconnect, degraded)) return;
    degraded();
  };

  function scheduleReconnect(): void {
    if (stopped) return;
    // 同一条连接可能同时触发 end 和 error（两个回调都会打到这里），
    // 已经在等重连时直接返回，否则会并行开出两条连接、且计数被双倍消耗。
    if (reconnectTimer) return;
    // 关键：不能「收到任何事件就重置计数」。服务端连上就发 server.connected，
    // 如果它紧接着断开，按事件重置会导致 500ms 一次无限重连、永远不退出。
    // 只有这条连接活过 SSE_STABLE_MS 才算稳定，才允许重新从 0 计数。
    const lived = openedAt ? Date.now() - openedAt : 0;
    if (lived >= SSE_STABLE_MS) attempt = 0;
    if (attempt >= SSE_RECONNECT_MAX) {
      onError?.(new Error(t("error.streamDropped")));
      return;
    }
    const delay = Math.min(30000, SSE_RECONNECT_BASE_MS * 2 ** attempt);
    attempt += 1;
    reconnecting = true;
    reconnectTimer = setTimeout(run, delay);
  }

  function handleEvent(evt: OpenCodeEvent): void {
    if (reconnecting) {
      // 重连接通后先对账，再继续消费实时事件
      reconnecting = false;
      onReconnect?.();
    }
    onEvent(evt);
  }

  run();
}

/** Electron `net` 的最小可用面（只用到 request，避免为了类型去依赖 electron 包） */
interface ElectronNetLike {
  request: (options: { url: string; method: string; headers: Record<string, string> }) => {
    on: (event: string, cb: (arg?: unknown) => void) => void;
    end: () => void;
    abort: () => void;
  };
}

/**
 * 取 Electron 的 `net` 模块。
 *
 * VS Code 扩展能用 SSE 是因为它跑在 Node 里，压根没有 CORS 这一层；Obsidian 插件跑在
 * Chromium 渲染进程，fetch 会被同源策略拦。`net` 走的是主进程网络栈，既不看 CORS 又
 * 支持流式，能拿到就等于拿到了 VS Code 那边的体验。拿不到（沙箱/版本限制）就返回 null，
 * 调用方走后面的降级链。
 */
function getElectronNet(): ElectronNetLike | null {
  try {
    const electron = require("electron") as { net?: ElectronNetLike } | undefined;
    const net = electron?.net;
    if (net && typeof net.request === "function") return net;
  } catch {
    // 拿不到就用别的通道
  }
  return null;
}

/**
 * 通道可用性缓存。
 *
 * 某个环境里某条通道「握手成功但永远不来数据」是稳定特性（Electron net 就出现过），
 * 每次都先等 3 秒超时再降级，用户每轮都要白等。只记「握手期一个事件都没收到」，
 * 中途断流仍然照常重连。
 */
let netChannelBroken = false;
let rawChannelBroken = false;

/**
 * 用 Electron `net` 订阅事件流；返回 false 表示这个通道不可用（调用方应降级）。
 * 通道本身启动成功但中途失败、且一个事件都没收到时，同样交给调用方降级。
 */
function startSseNet(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone: (() => void) | undefined,
  onUnusable: () => void,
): boolean {
  const net = getElectronNet();
  if (!net || netChannelBroken) return false;

  const url = joinUrl(base, "/event");
  let sawEvent = false;
  let closed = false;
  let req: ReturnType<ElectronNetLike["request"]> | null = null;
  // 和原始 TCP 通道一样要有握手超时：Electron net 在部分环境里订阅成功却
  // 永远不回调 response（静默挂住），既没事件也不报错，界面就变成「整段一起出现」。
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    try {
      req?.abort();
    } catch {
      // 已经结束了
    }
  };
  signal.addEventListener("abort", () => {
    close();
  }, { once: true });

  try {
    req = net.request({
      url,
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return false;
  }

  let buffer = "";
  req.on("response", (arg?: unknown) => {
    const res = arg as { on: (event: string, cb: (chunk?: unknown) => void) => void } | undefined;
    if (!res) return;
    res.on("data", (chunk?: unknown) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      buffer += text.replace(/\r\n/g, "\n");
      buffer = parseSseFrames(buffer, (payload) => {
        try {
          const evt = JSON.parse(payload) as OpenCodeEvent;
          if (evt && typeof evt.type === "string") {
            if (!sawEvent) {
              sawEvent = true;
              clearTimeout(handshakeTimer);
              console.info(`[xiaoyuanAgent] Electron net 通道收到首个事件：${evt.type}`);
            }
            onEvent(evt);
          }
        } catch {
          // 单帧解析失败不影响后续帧
        }
      });
    });
    res.on("end", () => {
      close();
      onDone?.();
    });
  });
  req.on("error", () => {
    if (sawEvent) {
      close();
      onDone?.();
      return;
    }
    close();
    onUnusable();
  });
  req.end();
  handshakeTimer = setTimeout(() => {
    if (sawEvent || closed) return;
    console.info("[xiaoyuanAgent] Electron net 通道未收到任何事件，判定不可用，降级");
    netChannelBroken = true;
    close();
    onUnusable();
  }, SSE_HANDSHAKE_TIMEOUT_MS);
  console.info("[xiaoyuanAgent] 事件流通道：Electron net（不受 CORS 限制，逐字流式）");
  return true;
}

/** Node `net` 的最小可用面（只建 TCP 连本机回环，自己写 HTTP 报文） */
interface NodeNetLike {
  connect: (options: { host: string; port: number }) => {
    on: (event: string, cb: (arg?: unknown) => void) => void;
    write: (data: string) => void;
    end: () => void;
    destroy: () => void;
  };
}

function getNodeNet(): NodeNetLike | null {
  try {
    const nodeNet = require("net") as NodeNetLike | undefined;
    if (nodeNet && typeof nodeNet.connect === "function") return nodeNet;
  } catch {
    // 拿不到就用别的通道
  }
  return null;
}

/**
 * 用原始 TCP 自己发一次 HTTP GET 读 SSE。
 *
 * 这是最后一条能同时做到「连共享实例 + 逐字流式」的路：浏览器 fetch 要 CORS，
 * Obsidian 的 requestUrl 不支持流式，Electron net 在渲染进程拿不到，Node 的 http
 * 历史上在本机会被卡住十几秒。直接连回环地址写报文则没有这些中间层。
 * 代价是要自己解析响应头与 chunked 编码，拿不到或连不上就交给调用方降级。
 */
function startSseRawSocket(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone: (() => void) | undefined,
  onUnusable: () => void,
): boolean {
  const nodeNet = getNodeNet();
  if (!nodeNet || rawChannelBroken) return false;

  let target: { host: string; port: number; path: string };
  try {
    const url = new URL(joinUrl(base, "/event"));
    target = {
      host: url.hostname || "127.0.0.1",
      port: Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
    };
  } catch {
    return false;
  }

  let sawEvent = false;
  let closed = false;
  let socket: ReturnType<NodeNetLike["connect"]> | null = null;
  // 服务端一连上就会发 `server.connected`（实测几十毫秒），几秒钟还一个事件都没有，
  // 就说明这条通道其实没在传数据——直接判不可用降级，别挂着等到超时。
  // 显式初始化：close() 可能在赋值前就被 abort 触发，用 const 会踩 TDZ
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    try {
      socket?.destroy();
    } catch {
      // 已经关了
    }
  };
  signal.addEventListener("abort", () => close(), { once: true });

  let headDone = false;
  let chunked = false;
  /**
   * chunked 的分块大小是**字节数**，缓冲必须按字节保存。
   *
   * 之前把数据包解码成字符串再按字符下标切片，播到一半会卡死：事件体里的
   * `location.directory` 带中文路径（如 `E:\我的资料库\...`），UTF-8 多字节字符让
   * 「字符偏移」和「字节偏移」越差越多，切出来的块边界全错，解析在第一个事件后
   * 就再也吐不出帧——界面上表现为「先出一点内容，然后整段在结尾一次性出现」。
   */
  let pending: Buffer = Buffer.alloc(0);
  let sseBuffer = "";

  const feed = (text: string) => {
    sseBuffer += text;
    sseBuffer = parseSseFrames(sseBuffer, (payload) => {
      try {
        const evt = JSON.parse(payload) as OpenCodeEvent;
        if (evt && typeof evt.type === "string") {
          if (!sawEvent) {
            clearTimeout(handshakeTimer);
            console.info(`[xiaoyuanAgent] 原始 TCP 通道收到首个事件：${evt.type}`);
          }
          sawEvent = true;
          onEvent(evt);
        }
      } catch {
        // 单帧解析失败不影响后续帧
      }
    });
  };

  /** chunked 编码：`<hex-size>\r\n<data>\r\n`，0 长度块表示结束（长度按字节算） */
  const drainChunks = () => {
    for (;;) {
      const lf = pending.indexOf("\r\n");
      if (lf < 0) return;
      const sizeLine = pending.subarray(0, lf).toString("utf8").trim();
      const size = parseInt(sizeLine, 16);
      if (!Number.isFinite(size)) return;
      const start = lf + 2;
      // 数据块还没收全（含结尾 CRLF），等下一包
      if (pending.length < start + size + 2) return;
      if (size === 0) {
        close();
        onDone?.();
        return;
      }
      feed(pending.subarray(start, start + size).toString("utf8"));
      pending = pending.subarray(start + size + 2);
    }
  };

  try {
    socket = nodeNet.connect({ host: target.host, port: target.port });
  } catch {
    return false;
  }

  socket.on("data", (arg?: unknown) => {
    const chunk = typeof arg === "string" ? Buffer.from(arg, "utf8") : Buffer.from(arg as Uint8Array);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (!headDone) {
      const sep = pending.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const head = pending.subarray(0, sep).toString("utf8");
      pending = pending.subarray(sep + 4);
      headDone = true;
      chunked = /transfer-encoding:\s*chunked/i.test(head);
      // 401 说明密码不对，别赖在这条通道上
      if (/^HTTP\/\S+\s+4\d\d/.test(head)) {
        close();
        onUnusable();
        return;
      }
    }
    if (chunked) {
      drainChunks();
      return;
    }
    feed(pending.toString("utf8"));
    pending = Buffer.alloc(0);
  });
  socket.on("error", () => {
    if (sawEvent) {
      close();
      onDone?.();
      return;
    }
    close();
    onUnusable();
  });
  socket.on("close", () => {
    if (sawEvent) {
      close();
      onDone?.();
      return;
    }
    close();
    onUnusable();
  });

  socket.write(
    `GET ${target.path} HTTP/1.1\r\n`
    + `Host: ${target.host}:${target.port}\r\n`
    + `Authorization: ${authHeader}\r\n`
    + `Accept: text/event-stream\r\n`
    + `Cache-Control: no-cache\r\n`
    + `Connection: keep-alive\r\n\r\n`,
  );
  handshakeTimer = setTimeout(() => {
    if (sawEvent || closed) return;
    console.info("[xiaoyuanAgent] 原始 TCP 通道未收到任何事件，判定不可用，降级");
    rawChannelBroken = true;
    close();
    onUnusable();
  }, SSE_HANDSHAKE_TIMEOUT_MS);
  console.info("[xiaoyuanAgent] 事件流通道：原始 TCP 直连（不受 CORS 限制，逐字流式）");
  return true;
}

/**
 * 用渲染进程 fetch 订阅 /api/event，收不到任何事件就降级为轮询。
 *
 * 降级只在「一个事件都还没收到」时才做：一旦已经出过事件，ai.ts 那边已经按增量
 * 累计过内容了，再从头轮询会把同一段正文重复拼一遍。
 */
function startSseFetchWithFallback(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone: (() => void) | undefined,
  onError: ((err: Error) => void) | undefined,
  sessionId: string,
  onPremature: () => void,
): void {
  const ctrl = new AbortController();
  const forwardAbort = () => ctrl.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });

  let sawEvent = false;
  let fellBack = false;
  startSseFetch(
    base,
    authHeader,
    ctrl.signal,
    (evt) => {
      sawEvent = true;
      onEvent(evt);
    },
    () => {
      // 已经出过事件的流不该以 EOF 收场：交给上层重连，别当成整轮结束
      if (fellBack) return;
      if (sawEvent) {
        onPremature();
        return;
      }
      onDone?.();
    },
    (err) => {
      if (fellBack) return;
      // 已经出过事件说明 SSE 本来是通的，这时断了同样重连（重连后会先对账）
      if (sawEvent) {
        onPremature();
        return;
      }
      fellBack = true;
      ctrl.abort();
      signal.removeEventListener("abort", forwardAbort);
      console.info("[xiaoyuanAgent] 事件流通道：退回 requestUrl 轮询（SSE 被拦：" + err.message + "）");
      if (!fallbackNoticed) {
        fallbackNoticed = true;
        try {
          new Notice(t("notice.opencodePollFallback"));
        } catch {
          // 提示失败不影响主流程
        }
      }
      startPolling(base, authHeader, signal, onEvent, onDone, onError, sessionId);
    },
  );
}

function startSseFetch(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone?: () => void,
  onError?: (err: Error) => void,
): void {
  const url = joinUrl(base, "/event");
  (async () => {
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal,
      });
      if (!resp.ok) {
        onError?.(new Error(`${describeStatus(resp.status)}（事件流订阅失败）`));
        return;
      }
      if (!resp.body) {
        onError?.(new Error("OpenCode 事件流没有响应体"));
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        buffer = parseSseFrames(buffer, (payload) => {
          try {
            const evt = JSON.parse(payload) as OpenCodeEvent;
            if (evt && typeof evt.type === "string") onEvent(evt);
          } catch {
            // 单帧解析失败不影响后续帧
          }
        });
      }
      onDone?.();
    } catch (err: unknown) {
      if (signal?.aborted) {
        onDone?.();
        return;
      }
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
}

/** 轮询间隔：太快会打爆服务端，太慢用户会觉得卡（只在 SSE 不可用时才用） */
const POLL_INTERVAL_MS = 500;
/** 事件流握手等待：连上后这么久还一个事件都没有，就认为这条通道没在传数据 */
const SSE_HANDSHAKE_TIMEOUT_MS = 3000;
/** 「已退回轮询」只提示一次，别每问一句都弹 */
let fallbackNoticed = false;

/**
 * 从 v2 的 idle 收尾消息里取出错误明细。
 *
 * 失败原因（额度、限流、模型参数不合法……）服务端都放在这条消息的 error 里，
 * 以前只报一句"OpenCode 执行失败"，用户根本看不出是哪出了问题。
 */
function extractIdleError(
  msg: { error?: unknown } | null,
): { message?: string; type?: string; status?: number } | null {
  const err = msg?.error;
  if (!err || typeof err !== "object") return null;
  const e = err as { message?: string; type?: string; status?: number };
  return {
    message: typeof e.message === "string" ? e.message : "",
    type: typeof e.type === "string" ? e.type : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
  };
}

/**
 * 轮询会话消息，把增量合成 ai.ts 认识的事件流。
 *
 * 走 requestUrl（主进程），因此不受 CORS 限制；失败重试由轮询自身承担，
 * 单次失败不终止。结束判定是「idle 收尾消息 / 会话 outcome / idle 变化 /
 * 内容长时间不再增长」四条里任一命中——只靠 idle 时间戳变化会在跑得极快的
 * 一轮（几十毫秒就失败）上永远等不到变化，最后撞 ai.ts 的 5 分钟超时。
 */
function startPolling(
  base: string,
  authHeader: string,
  signal: AbortSignal,
  onEvent: (evt: OpenCodeEvent) => void,
  onDone: (() => void) | undefined,
  onError: ((err: Error) => void) | undefined,
  sessionId: string,
): void {
  interface PollPart {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    state?: { status?: string };
  }
  interface PollMessage {
    id?: string;
    type?: string;
    content?: PollPart[];
    /** v2 的收尾消息（`type: "idle"`）带 outcome，失败时还带 error */
    outcome?: string;
    error?: unknown;
  }

  const textSeen = new Map<string, string>();
  const reasoningSeen = new Map<string, string>();
  const toolStatus = new Map<string, string>();
  let idleBaseline: number | null = null;
  let finished = false;
  /** 正文/推理/工具的签名，用来判断"已经不再变化" */
  let lastSignature = "";
  let lastChangeAt = Date.now();
  /** 兜底：内容连续这么久没变化、且没有在跑的工具，就认为这一轮结束了 */
  const STABLE_FINISH_MS = 15000;
  // 显式初始化：finish() 可能在 setInterval 之前就被 abort 触发，
  // 用 const 会踩到 TDZ，所以这里保持可重赋值。
  let timer: ReturnType<typeof setInterval> | undefined = undefined;

  const emit = (type: string, data: Record<string, unknown>): void => {
    onEvent({ type, data: { sessionID: sessionId, ...data } as OpenCodeEvent["data"] });
  };
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    clearInterval(timer);
    return true;
  };

  const poll = async (): Promise<void> => {
    if (finished) return;
    if (signal.aborted) {
      finish();
      onDone?.();
      return;
    }
    try {
      const session = (await httpGetOpenCode(base, `/session/${sessionId}`, authHeader)) as
        | { time?: { idle?: number }; outcome?: string }
        | null;
      const idle = Number(session?.time?.idle ?? 0);
      const outcome = typeof session?.outcome === "string" ? session.outcome : "";
      if (idleBaseline === null) idleBaseline = idle;

      const messages = (await httpGetOpenCode(
        base,
        `/session/${sessionId}/message?limit=50`,
        authHeader,
      )) as PollMessage[] | null;

      // v2 每跑完一轮都会写一条 `type: "idle"` 的消息（带 outcome / error）。
      // 它比 time.idle 的"基线对比"可靠得多：跑得极快（例如模型参数不合法，
      // 几十毫秒就失败）时，第一次轮询拿到的 idle 已经是终值，基线永远不变，
      // 只靠 idle 变化判断就会一直等到 ai.ts 的 5 分钟超时。
      let idleMsg: PollMessage | null = null;
      let runningTools = 0;
      let textLen = 0;
      let reasoningLen = 0;

      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (!m) continue;
          if (m.type === "idle") {
            idleMsg = idleMsg || m;
            continue;
          }
          if (m.type !== "assistant") continue;
          const mid = m.id || "";
          const parts = Array.isArray(m.content) ? m.content : [];

          const text = parts
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text || "")
            .join("");
          const prevText = textSeen.get(mid) ?? "";
          if (text.length > prevText.length) {
            textSeen.set(mid, text);
            emit("session.text.delta", { assistantMessageID: mid, delta: text.slice(prevText.length) });
          }

          const reasoning = parts
            .filter((c) => (c?.type === "reasoning" || c?.type === "thinking") && typeof c.text === "string")
            .map((c) => c.text || "")
            .join("");
          const prevReasoning = reasoningSeen.get(mid) ?? "";
          if (reasoning.length > prevReasoning.length) {
            reasoningSeen.set(mid, reasoning);
            emit("session.reasoning.delta", { assistantMessageID: mid, delta: reasoning.slice(prevReasoning.length) });
          }
          textLen += text.length;
          reasoningLen += reasoning.length;

          for (const c of parts) {
            if (!c) continue;
            const isTool = c.type === "tool" || !!c.name;
            if (!isTool) continue;
            const tid = c.id || c.name || "";
            if (!tid) continue;
            const status = c.state?.status || "";
            // 还在跑的工具：正文不长的时候不能拿"内容没变化"当结束
            if (status && status !== "completed" && status !== "success" && status !== "error") runningTools += 1;
            if (toolStatus.get(tid) === status) continue;
            toolStatus.set(tid, status);
            const name = c.name || "";
            if (status === "completed" || status === "success") emit("session.tool.success", { id: tid, name });
            else if (status === "error") emit("session.tool.error", { id: tid, name });
            else emit("session.tool.called", { id: tid, name });
          }
        }
      }

      // 结束判定（任一命中就收尾，别再死等）：
      //   1) 消息列表里出现 `idle` 收尾消息 —— 最可靠，跑得快也不会漏
      //   2) 会话上已经有 outcome —— 新建的会话本来没有 outcome，有值就说明跑完过
      //   3) time.idle 相对基线变化 —— 长任务兜住（老判据，保留）
      //   4) 有内容且长时间不再增长、也没有在跑的工具 —— 最后的兜底
      const signature = `${messages?.length ?? 0}|${textLen}|${reasoningLen}|${toolStatus.size}|${runningTools}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangeAt = Date.now();
      }
      const idleChanged = idle > 0 && idleBaseline !== null && idle !== idleBaseline;
      const outcomeKnown = outcome !== "";
      const stable = (textLen > 0 || reasoningLen > 0) && runningTools === 0 && Date.now() - lastChangeAt >= STABLE_FINISH_MS;
      if (!idleMsg && !outcomeKnown && !idleChanged && !stable) return;

      if (!finish()) return;
      const failed = outcome === "failed" || idleMsg?.outcome === "failed";
      if (failed) {
        emit("session.execution.failed", { error: extractIdleError(idleMsg) ?? {} });
      } else {
        emit("session.execution.succeeded", {});
      }
      onDone?.();
      return;
    } catch {
      // 单次轮询失败不终止（服务瞬时抖动），下一轮继续
    }
  };

  signal.addEventListener("abort", () => {
    finish();
    onDone?.();
  }, { once: true });
  timer = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
  void poll();
}

/**
 * 探测能否读到会话数据（流式轮询依赖它）。
 * 不再直接探 SSE：渲染进程 fetch 会被 CORS 拦，探了也永远是 false。
 */
export async function probeEventStream(base: string, authHeader?: string): Promise<boolean> {
  try {
    const sessions = (await httpGetOpenCode(base, "/session", authHeader)) as unknown[] | null;
    return Array.isArray(sessions);
  } catch {
    return false;
  }
}

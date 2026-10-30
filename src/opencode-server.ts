import { Notice } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import {
  DEFAULT_OPENCODE_PORT,
  OPENCODE_ALLOWED_HOSTS,
  OPENCODE_START_TIMEOUT_MS,
  OPENCODE_PORT_FALLBACK_ATTEMPTS,
  OPENCODE_CORS_ORIGIN,
} from "./constants";
import type { OpenCodeServerState } from "./types";
import { t } from "./i18n";
import { buildAuthHeader, candidatePasswords, getServerInfo, healthCheck, readServiceRegistration } from "./opencode-client";
import type { ServerConn } from "./opencode-client";

/**
 * OpenCode 服务的建立 / 进程管理。
 *
 * 连接策略只有三步，不再做多路探测：
 *
 * 1) 读 `~/.local/state/opencode/service.json` 拿到正在运行的托管实例（url + password），
 *    直接用它 —— 这是绝大多数用户的实际场景。
 * 2) 没有注册信息就用设置页里的 host:port。
 * 3) 都没有且开了 autoStart，才自己拉起一个 `serve`，并用 `OPENCODE_SERVER_PASSWORD`
 *    指定密码（官方文档支持的唯一方式，serve 本身没有 --password）。
 *
 * 结果缓存在内存里，只有请求失败时才重新解析，避免每轮对话都做健康检查。
 */

/** 设置页里的代理配置 */
export interface ProxyConfig {
  enabled: boolean;
  url: string;
}

let proxyConfig: ProxyConfig | null = null;
let portFallbackListener: ((info: { requested: number; actual: number }) => void) | null = null;
const stateListeners = new Set<(state: OpenCodeServerState | null) => void>();
/** 记住上次成功的连接，避免每次都绕一圈探测 */
let stickyConn: ServerConn | null = null;
/** 连接缓存的写入时间：过期后允许重新解析 */
let connCachedAt = 0;
/** 连接缓存有效期；期间直接用缓存，不做健康检查 */
const CONN_CACHE_MS = 60 * 1000;
/** 插件自己拉起的进程，卸载时要收掉 */
let autoStartedProc: ChildProcess | null = null;
/** 同一时刻只拉起一次，避免多处并发调用导致重复 spawn */
let ensurePromise: Promise<ServerConn> | null = null;

/**
 * 收敛 hostname：只允许本机回环，外网地址明确拒绝并回退到 127.0.0.1。
 */
export function sanitizeHostname(hostname: string): string {
  const raw = (hostname || "").trim();
  const h = raw.toLowerCase();
  if (!h) return "127.0.0.1";
  if ((OPENCODE_ALLOWED_HOSTS as readonly string[]).includes(h)) {
    return h === "[::1]" ? "::1" : h;
  }
  new Notice(t("notice.opencodeHostRejected", raw));
  console.warn("[xiaoyuanAgent] 非本机 OpenCode 地址已被拒绝，回退到 127.0.0.1:", raw);
  return "127.0.0.1";
}

/** 注入代理配置（仅持久化到内存，供子进程环境继承） */
export function setProxyConfig(cfg?: ProxyConfig | null): void {
  const url = cfg?.url?.trim?.() ?? "";
  proxyConfig = cfg?.enabled && url ? { enabled: true, url } : null;
}

/** 组装子进程环境变量：给 opencode 自己的出网请求配代理，但回环必须直连 */
export function buildChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (proxyConfig) {
    env.HTTP_PROXY = proxyConfig.url;
    env.HTTPS_PROXY = proxyConfig.url;
    env.http_proxy = proxyConfig.url;
    env.https_proxy = proxyConfig.url;
    const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost", "::1"]
      .filter((v): v is string => !!v)
      .join(",");
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

function publishServerState(): void {
  for (const cb of stateListeners) {
    try {
      cb(stickyConn ? { url: stickyConn.url, password: stickyConn.authHeader ? extractPassword(stickyConn) : "" } : null);
    } catch {
      // 某个监听者炸了不能影响其他人
    }
  }
}

/**
 * 设定当前连接，并只在「连接身份」变化时通知监听者。
 *
 * 关键：状态仓储的监听者在收到通知后会去重新探测，而探测又会走到这里。如果每次成功
 * 都无条件 publish，就会形成「探测 → publish → 探测 → publish …」的异步死循环，表现为
 * 状态条不停地弹「断开 / 连接」。只有连没连、连到哪个 url 真的变了才发通知。
 */
function commitConn(conn: ServerConn | null): void {
  const changed = (conn?.url ?? null) !== (stickyConn?.url ?? null);
  stickyConn = conn;
  if (changed) publishServerState();
}

/** 从 Basic 头里还原密码（只用于对外发布状态） */
function extractPassword(conn: ServerConn): string {
  const prefix = "Basic ";
  if (!conn.authHeader.startsWith(prefix)) return "";
  try {
    const decoded = Buffer.from(conn.authHeader.slice(prefix.length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return "";
  }
}

function buildUrl(hostname: string, port: number): string {
  const host = sanitizeHostname(hostname);
  // IPv6 裸地址要用方括号包起来
  const safe = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${safe}:${port}`;
}

/**
 * 探测 opencode 可执行文件路径。
 * 给的是可执行文件路径就直接用；给的是命令名就走 where/which 找一次。
 */
export async function resolveOpenCodePath(hint: string): Promise<string> {
  const raw = (hint || "").trim() || "opencode";
  // 明确指向某个文件（含路径分隔符）时以它为准
  if (raw.includes("/") || raw.includes("\\")) return raw;

  const isWin = process.platform === "win32";
  const probe = isWin ? "where" : "which";
  try {
    const found = await new Promise<string>((resolve) => {
      const p = spawn(probe, [raw], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      p.on("error", () => resolve(""));
      p.on("close", () => resolve(out.split(/\r?\n/)[0]?.trim() || ""));
    });
    if (found) return found;
  } catch {
    // 探测失败就用原样
  }
  return raw;
}

/** 用当前候选密码试着连一下，能拿到 /api/info 就算成功 */
async function tryConnect(url: string, extraPassword?: string): Promise<ServerConn | null> {
  const passwords = [extraPassword, ...candidatePasswords()]
    .map((p) => (p || "").trim())
    .filter((p, i, arr): p is string => !!p && arr.indexOf(p) === i);
  for (const pw of passwords) {
    const conn: ServerConn = { url, authHeader: buildAuthHeader(pw) };
    try {
      const ok = await healthCheck(url, conn.authHeader);
      if (ok) return conn;
    } catch {
      // 换下一个候选密码
    }
  }
  return null;
}

/**
 * 启动一个 opencode serve 实例。
 * 用 `OPENCODE_SERVER_PASSWORD` 固定密码（官方支持的方式），启动后轮询健康检查，
 * 直到超时或进程提前退出。
 */
export function startTempOpenCodeServer(
  bin: string,
  vaultDir: string,
  port: number,
  hostname = "127.0.0.1",
): Promise<{ url: string; proc: ChildProcess; password: string }> {
  const url = buildUrl(hostname, port);
  const password = randomBytes(16).toString("hex");
  // 带上 --cors：插件渲染进程的 fetch 要拿到 Access-Control-Allow-Origin 才能读
  // /api/event（真正的逐字增量）。没有它，事件流会被浏览器以 CORS 拦掉，只能退回
  // requestUrl 轮询——而轮询读的是消息列表，中间态根本不落库，只能等到结束才有内容。
  const args = [
    "serve",
    "--hostname",
    sanitizeHostname(hostname),
    "--port",
    String(port),
    "--cors",
    OPENCODE_CORS_ORIGIN,
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const proc = spawn(bin, args, {
      cwd: vaultDir || process.cwd(),
      env: buildChildEnv({ OPENCODE_SERVER_PASSWORD: password }),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });

    const finish = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(limitTimer);
      reject(err);
    };

    proc.on("error", (err) => finish(new Error(t("error.serveNotRunning") + "\n" + err.message)));
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    proc.on("close", (code) => {
      if (!settled) {
        finish(new Error(t("error.serverExited", String(code ?? "?"), stderr.slice(-500))));
      }
    });

    const deadline = Date.now() + OPENCODE_START_TIMEOUT_MS;
    // 每 500ms 试一次：优先用我们注入的环境变量密码，同时兼容 serve 自行生成密码的情况
    // （那种情况下 service.json 会在启动后写出真实密码）
    const pollTimer = setInterval(async () => {
      if (settled) return;
      const conn = await tryConnect(url, password);
      if (conn) {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(limitTimer);
        resolve({ url: conn.url, proc, password: extractPassword(conn) || password });
        return;
      }
      if (Date.now() > deadline) {
        try {
          proc.kill();
        } catch {
          /* 已经退出了就无所谓 */
        }
        finish(new Error(t("error.serverStartTimeout", `${OPENCODE_START_TIMEOUT_MS / 1000}s`)));
      }
    }, 500);

    const limitTimer = setTimeout(() => {
      if (settled) return;
      try {
        proc.kill();
      } catch {
        /* noop */
      }
      finish(new Error(t("error.serverStartTimeout", `${OPENCODE_START_TIMEOUT_MS / 1000}s`)));
    }, OPENCODE_START_TIMEOUT_MS + 1000);
  });
}

/** 停止临时服务器 */
export function stopTempServer(proc: ChildProcess): void {
  try {
    proc.kill();
  } catch {
    /* 已经退出 */
  }
}

/**
 * 清理遗留的 opencode serve 孤儿进程。
 *
 * 只清理插件自己这段端口范围（configuredPort 起 N 个），并且**只杀进程名里确实带
 * opencode 的**，绝不碰用户手动跑的托管实例（比如 28894 那个）。
 */
export function cleanupOrphanedOpenCodeServers(
  configuredPort: number,
  managedReg?: { url?: string } | null,
): void {
  const startPort = configuredPort || DEFAULT_OPENCODE_PORT;
  const attempts = OPENCODE_PORT_FALLBACK_ATTEMPTS || 1;
  const owned = new Set<number>();
  for (let i = 0; i < attempts; i += 1) owned.add(startPort + i);
  // 托管实例的端口排除掉
  try {
    if (managedReg?.url) {
      const u = new URL(managedReg.url);
      const p = Number(u.port);
      if (p) owned.delete(p);
    }
  } catch {
    /* url 不合法就算了 */
  }

  for (const port of owned) {
    for (const pid of pidsListeningOn(port)) {
      if (!isOpenCodeProcess(pid)) continue;
      try {
        process.kill(pid, 0); // 先确认还在
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        /* 进程可能已经没了 */
      }
    }
  }
}

/** 找出监听某个端口的 PID（跨平台，失败就返回空） */
function pidsListeningOn(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = require("child_process").execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
      }) as string;
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`\\s(?:127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0):${port}\\s+.*?LISTENING\\s+(\\d+)\\s*$`, "i"));
        if (m) pids.add(Number(m[1]));
      }
      return [...pids];
    }
    const out = require("child_process").execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
    }) as string;
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** 确认这个 PID 确实是 opencode（避免误杀别的程序） */
function isOpenCodeProcess(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    if (process.platform === "win32") {
      const out = require("child_process").execFileSync(
        "tasklist",
        ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
        { encoding: "utf8", windowsHide: true },
      ) as string;
      return /opencode/i.test(out);
    }
    const out = require("child_process").execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }) as string;
    return /opencode/i.test(out);
  } catch {
    return false;
  }
}

/** 端口被占用时顺延：先试着连现有实例，不行就换端口 */
export async function startOpenCodeServerWithFallback(
  bin: string,
  vaultDir: string,
  port: number,
  hostname = "127.0.0.1",
  maxAttempts = OPENCODE_PORT_FALLBACK_ATTEMPTS,
): Promise<{ url: string; proc: ChildProcess; password: string }> {
  const requested = port || DEFAULT_OPENCODE_PORT;
  const attempts = Math.max(1, maxAttempts);
  let lastErr: Error | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const tryPort = requested + i;
    try {
      const started = await startTempOpenCodeServer(bin, vaultDir, tryPort, hostname);
      if (i > 0) {
        portFallbackListener?.({ requested, actual: tryPort });
        new Notice(t("notice.opencodePortFallback", String(requested), String(tryPort)));
      }
      return started;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error(t("error.serveNotRunning"));
}

/** 端口自动顺延回调 */
export function onOpenCodePortFallback(cb: ((info: { requested: number; actual: number }) => void) | null): void {
  portFallbackListener = cb;
}

/**
 * 外部（插件加载 / 设置页）状态变更：丢掉连接缓存，下次重新解析。
 * 参数保留是为了不打断现有调用方。
 */
export function setOpenCodeServerState(_state?: OpenCodeServerState | null): void {
  invalidateOpenCodeConnection();
}

/** 丢掉缓存的连接，让下次 findOpenCodeConnection 重新解析（请求失败时调用） */
export function invalidateOpenCodeConnection(): void {
  commitConn(null);
  connCachedAt = 0;
}

/** 注册实例状态变化的监听者 */
export function onOpenCodeServerStateChange(cb: (state: OpenCodeServerState | null) => void): void {
  stateListeners.add(cb);
}

/**
 * 查找已有 OpenCode 连接（只探测，不启动）。
 *
 * 只做两件事：读 service.json 里正在运行的托管实例 → 退回到设置页里的 host:port。
 * 结果缓存 60 秒，期间不做任何健康检查；缓存失效或请求报错后再重新解析。
 */
export async function findOpenCodeConnection(port: number, hostname = "127.0.0.1"): Promise<ServerConn | null> {
  if (stickyConn && Date.now() - connCachedAt < CONN_CACHE_MS) {
    return stickyConn;
  }

  // 1) 官方托管实例：state 目录下 service.json 的 url + password 是唯一可靠来源
  const reg = readServiceRegistration();
  if (reg?.url) {
    const managed = await tryConnect(reg.url, reg.password);
    if (managed) {
      commitConn(managed);
      connCachedAt = Date.now();
      return managed;
    }
  }

  // 2) 设置页里配置的 host:port
  const conn = await tryConnect(buildUrl(hostname, port));
  if (conn) {
    commitConn(conn);
    connCachedAt = Date.now();
  }
  return conn;
}

/** 确保 OpenCode 服务可用（找不到就自建，autoStart 关着则直接报错） */
export async function ensureOpenCodeServer(
  cliPath: string,
  hostname: string,
  port: number,
  vaultDir: string,
  autoStart: boolean,
): Promise<ServerConn> {
  // 多处同时调用时只拉起一次
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const existing = await findOpenCodeConnection(port, hostname);
    if (existing) return existing;

    if (!autoStart) {
      throw new Error(t("error.serverNotFound", sanitizeHostname(hostname), String(port)));
    }

    const bin = await resolveOpenCodePath(cliPath);
    const started = await startOpenCodeServerWithFallback(bin, vaultDir, port, hostname);
    autoStartedProc = started.proc;
    const conn: ServerConn = { url: started.url, authHeader: buildAuthHeader(started.password) };
    commitConn(conn);
    connCachedAt = Date.now();
    return conn;
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

/** 停止 OpenCode 服务（只收插件自己拉起的那个） */
export function stopOpenCodeServer(): void {
  if (autoStartedProc) {
    try {
      autoStartedProc.kill();
    } catch {
      /* 已经退出 */
    }
    autoStartedProc = null;
  }
  invalidateOpenCodeConnection();
}

/** 额外暴露：读取服务端信息（版本号等），供状态卡片显示 */
export async function fetchServerVersion(baseUrl: string, authHeader?: string): Promise<string> {
  const info = await getServerInfo(baseUrl, authHeader);
  return info?.version || "";
}

export type { OpenCodeServerState };

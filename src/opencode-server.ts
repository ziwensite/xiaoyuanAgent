import { Notice } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import {
  DEFAULT_OPENCODE_PORT,
  OPENCODE_ALLOWED_HOSTS,
  OPENCODE_START_TIMEOUT_MS,
  OPENCODE_PORT_FALLBACK_ATTEMPTS,
  OPENCODE_CORS_ORIGIN,
} from "./constants";
import type { OpenCodeServerState } from "./types";
import { t } from "./i18n";
import { buildAuthHeader, candidatePasswords, getServerInfo, healthCheck } from "./opencode-client";
import type { ServerConn } from "./opencode-client";

/**
 * OpenCode 服务的建立 / 进程管理。
 *
 * 与 v2.1.4 对齐的两个要点：
 *
 * 1) **`serve` 没有 --password 参数**（实测 `opencode serve --help` 只有
 *    --hostname / --port / --cors / --service / --stdio）。密码由 opencode 自己生成并
 *    持久化到 `~/.config/opencode/service.json`，所以插件启动服务后是从那个文件里读
 *    密码，而不是像旧实现那样“自己生成一个密码传给 serve”。
 *
 * 2) **先找已有实例，再自建**。本来就有一个 opencode 在跑时直接复用（本机的
 *    28894 就是这种），避免同一个 vault 起一堆孤儿进程。
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
/** 上次记录的实例信息（插件重载后用来判断要不要复用） */
let rememberedState: OpenCodeServerState | null = null;
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

/**
 * 官方托管服务（`opencode service`）的端口是它自己挑的，换机器/重装都会变
 * （本机这次是 28894）。所以不能把某个端口写死成默认值，得问一次
 * `opencode service status`——它的输出就是 `http://127.0.0.1:28894` 这样的地址。
 */
let managedPortCache: { port: number | null; at: number } | null = null;
// 起一次 opencode 进程在 Windows 上要 1~3 秒（Bun 单文件二进制不小），所以探测结果
// 要缓存久一点，否则"接口自检"这类一次性操作会被它拖慢。
const MANAGED_PORT_CACHE_MS = 10 * 60 * 1000;

/** 官方托管服务的默认监听端口（opencode service 默认就它，除非用户显式改过） */
const OPENCODE_MANAGED_DEFAULT_PORT = 28894;

async function detectManagedServicePort(cliPath?: string): Promise<number | null> {
  if (managedPortCache && Date.now() - managedPortCache.at < MANAGED_PORT_CACHE_MS) {
    return managedPortCache.port;
  }
  // 注意：28894 默认端口的直连探活已在 findOpenCodeConnection 里优先做过，
  // 这里只在「28894 不通（用户改过托管端口）」时才走到，所以直接 spawn 查真实端口。
  // Windows 上起 opencode 进程要 1~3 秒，靠缓存（10 分钟）和下面的失败兜底来避免抖动。
  const bin = await resolveOpenCodePath(cliPath || "opencode");
  const port = await new Promise<number | null>((resolve) => {
    let out = "";
    let done = false;
    const settle = (value: number | null) => {
      if (done) return;
      done = true;
      const m = out.match(/https?:\/\/[^:\s]+:(\d+)/);
      resolve(m ? Number(m[1]) : value);
    };
    try {
      const p = spawn(bin, ["service", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
      p.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      p.stderr?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      p.on("error", () => settle(null));
      p.on("close", () => settle(null));
      setTimeout(() => {
        if (!done) {
          try {
            p.kill();
          } catch {
            /* noop */
          }
          settle(null);
        }
      }, 3000);
    } catch {
      settle(null);
    }
  });
  if (port) {
    managedPortCache = { port, at: Date.now() };
    return port;
  }
  // spawn 失败：宁可沿用上次缓存的端口（端口不会频繁变），也不要误判「断开」
  // 导致状态条反复弹窗。
  if (managedPortCache) return managedPortCache.port;
  return null;
}

/** 用当前候选密码试着连一下，能拿到 /api/info 就算成功 */
async function tryConnect(url: string): Promise<ServerConn | null> {
  const passwords = candidatePasswords();
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
 * 启动后轮询健康检查（密码从 service.json 读），直到超时或进程提前退出。
 */
export function startTempOpenCodeServer(
  bin: string,
  vaultDir: string,
  port: number,
  hostname = "127.0.0.1",
): Promise<{ url: string; proc: ChildProcess; password: string }> {
  const url = buildUrl(hostname, port);
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
      env: buildChildEnv(),
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
    // 每 500ms 试一次；密码要每次重新读，service.json 可能是启动后才写出来的
    const pollTimer = setInterval(async () => {
      if (settled) return;
      const conn = await tryConnect(url);
      if (conn) {
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(limitTimer);
        resolve({ url: conn.url, proc, password: extractPassword(conn) });
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

/** 注入上次记录的实例信息 */
export function setOpenCodeServerState(state?: OpenCodeServerState | null): void {
  rememberedState = state ?? null;
  // 换了实例就不能再复用旧连接
  if (rememberedState && stickyConn && stickyConn.url !== rememberedState.url) {
    stickyConn = null;
  }
}

/** 注册实例状态变化的监听者 */
export function onOpenCodeServerStateChange(cb: (state: OpenCodeServerState | null) => void): void {
  stateListeners.add(cb);
}

/** 查找已有 OpenCode 连接（只探测，不启动）。cliPath 用于探测托管服务端口时定位 opencode 可执行文件。 */
export async function findOpenCodeConnection(port: number, hostname = "127.0.0.1", cliPath?: string): Promise<ServerConn | null> {
  const url = buildUrl(hostname, port);
  // 已记住的连接：命中即返回，不做健康检查（真实断网由 stop 事件/手动刷新纠正）。
  if (stickyConn && stickyConn.url === url) {
    return stickyConn;
  }
  // 官方托管服务默认就是 28894（回环本机正常 <100ms），绝大多数情况这里秒命中。
  // 必须放在「上次记录的旧实例」之前：否则会先白等旧端口的超时，再把 2~3 秒拖给
  // 用户，且偶发全部超时就误判「断开」。
  try {
    const managedUrl = buildUrl(hostname, OPENCODE_MANAGED_DEFAULT_PORT);
    if (await healthCheck(managedUrl, undefined, 1500)) {
      const authHeader = rememberedState
        ? buildAuthHeader(rememberedState.password)
        : (stickyConn?.authHeader ?? "");
      const managed: ServerConn = { url: managedUrl, authHeader };
      commitConn(managed);
      return managed;
    }
  } catch {
    /* 28894 不通，往下找 */
  }
  // 28894 不通（用户改过托管端口）：spawn 问真实端口
  const managedPort = await detectManagedServicePort(cliPath);
  if (managedPort && managedPort !== port && managedPort !== OPENCODE_MANAGED_DEFAULT_PORT) {
    const managed = await tryConnect(buildUrl(hostname, managedPort));
    if (managed) {
      commitConn(managed);
      return managed;
    }
  }
  // 兜底：上次记录的实例（可能是非默认端口的旧实例）
  if (rememberedState?.url) {
    const remembered: ServerConn = {
      url: rememberedState.url,
      authHeader: buildAuthHeader(rememberedState.password),
    };
    try {
      if (await healthCheck(remembered.url, remembered.authHeader, 1200)) {
        stickyConn = remembered;
        commitConn(remembered);
        return remembered;
      }
    } catch {
      /* 旧实例没了，继续往下找 */
    }
  }

  const conn = await tryConnect(url);
  if (conn) {
    commitConn(conn);
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
    stickyConn = conn;
    rememberedState = { url: started.url, password: started.password };
    publishServerState();
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
  stickyConn = null;
  commitConn(null);
}

/** 额外暴露：读取服务端信息（版本号等），供状态卡片显示 */
export async function fetchServerVersion(baseUrl: string, authHeader?: string): Promise<string> {
  const info = await getServerInfo(baseUrl, authHeader);
  return info?.version || "";
}

export type { OpenCodeServerState };

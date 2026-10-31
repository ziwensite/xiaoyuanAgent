import { Notice } from "obsidian";
import type XiaoyuanAgentPlugin from "../main";
import { checkConnection } from "../connection-checker";
import { getWorkspaceDir } from "../server";
import { checkOpenCodeStatus } from "../opencode-config";
import { onOpenCodeServerStateChange } from "../opencode-server";
import { t } from "../i18n";

/**
 * 状态仓储（单例）。
 *
 * 设计目标：状态「启动探测一次存快照 → 变化才更新 → 手动刷新重探」，避免设置面板
 * 切标签时重复探测。状态卡（settings/status-card.ts）订阅本仓储，只在 snapshot
 * 变化时更新对应行；模型/代理这类纯设置派生值由 `saveSettings` 钩子直绑更新。
 *
 * 连接状态的自动更新来源：
 * - CLI 连接 / 版本：订阅 `onOpenCodeServerStateChange`（OpenCode 服务启停事件）
 * - API 连接：由 API 配置变更（baseUrl/apiKey/activeProvider）与手动刷新触发；
 *   运行期纯网络掉线无事件源，靠手动刷新兜底（不轮询）。
 */
export interface StatusSnapshot {
  /** null = 尚未探测 */
  cliConnected: boolean | null;
  apiConnected: boolean | null;
  version: string;
  lastSyncedAt: string;
}

const VERSION_CACHE_TTL_MS = 60_000;
const versionCache = new Map<string, { version: string; ts: number }>();

type Listener = (snap: StatusSnapshot) => void;

class StatusStore {
  private plugin: XiaoyuanAgentPlugin | null = null;
  private snapshot: StatusSnapshot = {
    cliConnected: null,
    apiConnected: null,
    version: "",
    lastSyncedAt: "",
  };
  private listeners = new Set<Listener>();
  private subscribed = false;
  private netListenersRegistered = false;
  /** 上次探测到的连接布尔值，仅用于在「已初始化后」的状态跳变时弹 Notice */
  private prevCli: boolean | null = null;
  private prevApi: boolean | null = null;
  /** 与 prev 不一致、但还没被第二次探测确认的新值（防单次抖动刷屏） */
  private pendingCli: boolean | null = null;
  private pendingApi: boolean | null = null;

  init(plugin: XiaoyuanAgentPlugin): void {
    this.plugin = plugin;
    if (this.subscribed) return;
    this.subscribed = true;
    // OpenCode 服务启停：CLI 连接与版本都可能变化，交给各自探测
    onOpenCodeServerStateChange(() => {
      void this.detectCli();
      void this.detectVersion();
    });
    // 设备网络变更（WiFi 掉线/恢复）由 Obsidian/Electron 的 online/offline
    // 事件驱动重探——事件式、零轮询，正好覆盖纯网络抖动这类无进程事件的场景
    this.registerNetworkListeners();
  }

  /** 订阅浏览器/系统的 online/offline 事件，网络变化时重探 CLI/API 连接 */
  private registerNetworkListeners(): void {
    if (this.netListenersRegistered) return;
    if (typeof window === "undefined" || !window.addEventListener) return;
    this.netListenersRegistered = true;
    const recheck = () => {
      void this.detect();
    };
    window.addEventListener("offline", recheck);
    window.addEventListener("online", recheck);
  }

  get(): StatusSnapshot {
    return this.snapshot;
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.snapshot);
  }

  private patch(p: Partial<StatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...p };
    this.emit();
  }

  /** 启动 / 手动刷新：全量探测 */
  async detect(): Promise<void> {
    await Promise.all([this.detectCli(), this.detectApi(), this.detectVersion()]);
  }

  async detectCli(): Promise<void> {
    const s = this.plugin?.settings;
    if (!s) return;
    const ok = await checkConnection(s, getWorkspaceDir(), "cli", false).catch(() => false);
    this.applyConnection("cli", ok);
  }

  async detectApi(): Promise<void> {
    const s = this.plugin?.settings;
    if (!s) return;
    const ok = await checkConnection(s, getWorkspaceDir(), "api").catch(() => false);
    this.applyConnection("api", ok);
  }

  /**
   * 写入单路连接状态，并在「已初始化之后」发生 通↔断 跳变时弹 Notice。
   * 初始探测（prev 为 null）不弹，避免启动即刷屏。
   */
  private applyConnection(kind: "cli" | "api", ok: boolean): void {
    const prev = kind === "cli" ? this.prevCli : this.prevApi;
    const pending = kind === "cli" ? this.pendingCli : this.pendingApi;
    const setPending = (v: boolean | null) => {
      if (kind === "cli") this.pendingCli = v;
      else this.pendingApi = v;
    };
    const commit = () => {
      if (kind === "cli") this.prevCli = ok;
      else this.prevApi = ok;
      setPending(null);
      this.patch(kind === "cli" ? { cliConnected: ok } : { apiConnected: ok });
    };

    // 首次探测只定状态，不弹提示
    if (prev === null) {
      commit();
      return;
    }
    // 和当前一致：把待确认的抖动值清掉
    if (ok === prev) {
      setPending(null);
      return;
    }
    // 第一次看到新状态先记着：单次探测失败很可能是服务端被一时打满，
    // 直接弹「已断开/已恢复」会刷屏，等下一次探测还是这个值才认。
    if (pending !== ok) {
      setPending(ok);
      return;
    }
    commit();
    new Notice(
      kind === "cli"
        ? ok ? t("notice.cli.recovered") : t("notice.cli.disconnected")
        : ok ? t("notice.api.recovered") : t("notice.api.disconnected"),
    );
  }

  async detectVersion(): Promise<void> {
    const s = this.plugin?.settings;
    if (!s) return;
    const cacheKey = s.opencode.cliPath || "opencode";
    const cached = versionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < VERSION_CACHE_TTL_MS) {
      if (cached.version !== this.snapshot.version) this.patch({ version: cached.version });
      return;
    }
    const version = await checkOpenCodeStatus(s.opencode.cliPath, getWorkspaceDir(), s.opencode.port, s.opencode.hostname)
      .then((st) => (st?.version || "").trim())
      .catch(() => "");
    versionCache.set(cacheKey, { version, ts: Date.now() });
    this.patch({ version });
  }
}

export const statusStore = new StatusStore();

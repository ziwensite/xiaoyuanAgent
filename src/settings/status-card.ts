import type { SettingsCtx } from "./context";
import manifest from "../../manifest.json";
import { getAgentForChannel } from "../agent-registry";
import { getActiveProvider, VERIFIED_OPENCODE_VERSION } from "../constants";
import { t } from "../i18n";
import { getVaultBasePath } from "../server";
import { XiaoyuanAgentSettings } from "../types";
import { compareVersions, majorVersion } from "../utils";
import { Notice } from "obsidian";
import { statusStore } from "./status-store";

// ─── ① Status Card ───────────────────────────────────────────────

/** 状态卡是异步刷新的，每次都要重新查 DOM，不能缓存引用 */
export function currentStatusCard(ctx: SettingsCtx): HTMLElement | null {
  return ctx.containerEl.querySelector<HTMLElement>(".xyag-settings-status");
}

/** 把连接布尔值转成展示文本（null = 尚未探测） */
function connLabel(v: boolean | null): string {
  if (v === null) return t("status.checking");
  return v ? t("status.connected") : t("status.disconnected");
}

/** API 连接：未配置或不可达都归为「未配置」，与原有行为一致 */
function apiLabel(v: boolean | null): string {
  if (v === null) return t("status.checking");
  return v ? t("status.connected") : t("status.notConfigured");
}

/** 把原始版本号转成状态卡要显示的文本 + 需要给出的告警 */
function describeOpenCodeVersion(version: string): { value: string; warn: string } {
  const major = majorVersion(version);
  const compatible = major === 2;
  // 同主版本、但比已验证版本更新：不阻断连接，只提示「未经验证」
  const unverified = compatible && compareVersions(version, VERIFIED_OPENCODE_VERSION) > 0;
  const value = !version
    ? t("status.version.unknown")
    : !compatible
      ? `${version} · ${t("status.version.unsupported")}`
      : unverified
        ? `${version} · ${t("status.version.unverified")}`
        : version;
  // 告警只在「主版本不是 2」时出现
  const warn = !version || compatible ? "" : t("status.version.warning", version);
  return { value, warn };
}

/** 写版本行 + 告警区 */
function applyOpenCodeVersion(ctx: SettingsCtx, card: HTMLElement, version: string) {
  const { value, warn } = describeOpenCodeVersion(version);
  ctx.updateRow(card, 1, value);
  const warnEl = card.querySelector<HTMLElement>(".xyag-settings-status-warning");
  if (warnEl) {
    warnEl.textContent = warn;
    warnEl.style.display = warn ? "" : "none";
  }
}

/**
 * 把模型/代理等纯设置派生值直绑到状态卡对应行（不重探连接）。
 * 由 `saveSettings` 钩子在任意设置落盘后调用，覆盖设置面板与聊天工具栏的改动。
 */
export function applySettingsDerivedRows(ctx: SettingsCtx): void {
  const card = ctx.currentStatusCard();
  if (!card) return;
  const s = ctx.s();
  ctx.updateRow(card, 3, getAgentForChannel(s, "cli")?.model || s.opencode.model || t("status.notSelected"));
  ctx.updateRow(card, 4, getAgentForChannel(s, "api")?.model || getActiveProvider(s)?.model || t("status.notSelected"));
  ctx.updateRow(card, 5, s.proxyEnabled ? s.proxyUrl : t("status.closed"));
}

// 订阅只需注册一次；状态卡 DOM 在切标签时不销毁，回调每次重新查活节点
let storeSubscribed = false;
let lastSeenVersion: string | null = null;

export function buildStatusCard(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();
  const snap = statusStore.get();
  const card = container.createDiv({ cls: "xyag-settings-status" });

  ctx.addStatusRow(card, "terminal-square", t("status.cli"), connLabel(snap.cliConnected));
  ctx.addStatusRow(card, "package", t("status.opencode.version"), describeOpenCodeVersion(snap.version).value);
  ctx.addStatusRow(card, "key-round", t("status.api"), apiLabel(snap.apiConnected));
  ctx.addStatusRow(card, "box", t("status.cli.model"), getAgentForChannel(s, "cli")?.model || s.opencode.model || t("status.notSelected"));
  ctx.addStatusRow(card, "box", t("status.api.model"), getAgentForChannel(s, "api")?.model || getActiveProvider(s)?.model || t("status.notSelected"));
  ctx.addStatusRow(card, "waypoints", t("status.proxy"), s.proxyEnabled ? s.proxyUrl : t("status.closed"));

  const warn = card.createDiv({ cls: "xyag-settings-status-warning" });
  warn.style.display = "none";

  const actions = card.createDiv({ cls: "xyag-settings-status-actions" });
  // 版本号常驻在状态卡上：插件热重载之后设置面板不会重建，
  // 光看界面分不清跑的是新包还是旧包，一眼就能确认。
  actions.createSpan({ cls: "xyag-settings-status-stamp", text: `v${manifest.version}` });
  const stamp = actions.createSpan({ cls: "xyag-settings-status-stamp" });
  if (ctx.lastSyncedAt) stamp.textContent = t("status.syncedAt", ctx.lastSyncedAt);
  const refreshBtn = actions.createEl("button", { cls: "xyag-status-btn", text: t("status.refresh") });
  refreshBtn.addEventListener("click", async () => {
    // 刷新要跑子进程 + HTTP 探测，await 期间必须禁用按钮，否则连点会并发跑好几轮
    refreshBtn.disabled = true;
    refreshBtn.setText("…");
    try {
      // 启动探测一次存快照、变化才更新、手动刷新重探（不再重建状态卡）
      await statusStore.detect();
      try {
        const { ensureOpenCodeModels, ensureOpenCodeAgents } = await import("../opencode-sync");
        await ensureOpenCodeModels({ plugin: ctx.plugin, silent: false, force: true, reason: "manual" });
        await ensureOpenCodeAgents({ plugin: ctx.plugin, silent: false, force: true, reason: "manual" });
        await ctx.plugin.saveSettings();
      } catch {}
      // 时间戳存在字段上：写完立刻 display() 会重建 DOM，局部变量会被丢掉
      ctx.lastSyncedAt = new Date().toLocaleTimeString();
      stamp.textContent = t("status.syncedAt", ctx.lastSyncedAt);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.setText(t("status.refresh"));
    }
  });

  // 订阅状态仓储：连接 / 版本变化直接更新对应行，无需整页重建
  if (!storeSubscribed) {
    storeSubscribed = true;
    statusStore.subscribe((snap) => {
      const c = ctx.currentStatusCard();
      if (!c) return;
      ctx.updateRow(c, 0, connLabel(snap.cliConnected));
      ctx.updateRow(c, 2, apiLabel(snap.apiConnected));
      applyOpenCodeVersion(ctx, c, snap.version);
      // 版本真正变化（且尚未做过能力自检）才触发接口自检
      if (snap.version && snap.version !== lastSeenVersion && snap.version !== ctx.s().lastAutoProbeOpenCodeVersion) {
        lastSeenVersion = snap.version;
        void runAutoCapabilityCheck(ctx, ctx.statusGeneration, ctx.s(), snap.version, getVaultBasePath());
      }
    });
  }
}

export async function runAutoCapabilityCheck(ctx: SettingsCtx, gen: number, s: XiaoyuanAgentSettings, version: string, vaultDir: string) {
  const bail = () => gen !== ctx.statusGeneration;
  try {
    const { findOpenCodeConnection } = await import("../opencode-server");
    const { probeOpenCodeCapabilities } = await import("../opencode-probe");
    const conn = await findOpenCodeConnection(s.opencode.port, s.opencode.hostname);
    if (!conn) {
      // 服务端未启动：先记录版本，避免每次刷新都重复尝试
      s.lastAutoProbeOpenCodeVersion = version;
      await ctx.plugin.saveSettings();
      return;
    }
    const results = await probeOpenCodeCapabilities(conn, vaultDir);
    const failed = results.filter((r) => !r.ok);
    // 更新记录，防止重复自检
    s.lastAutoProbeOpenCodeVersion = version;
    await ctx.plugin.saveSettings();
    if (bail()) return;

    const card = ctx.currentStatusCard();
    const warn = card?.querySelector<HTMLElement>(".xyag-settings-status-warning");
    if (!warn) return;

    if (failed.length === 0) {
      // 全部正常：静默，不报任何提示
      warn.textContent = "";
      warn.style.display = "none";
      return;
    }

    // 有异常：才在状态卡显示警告并弹出 Notice
    warn.textContent = t("setting.cli.capability.failed", String(failed.length));
    warn.style.display = "";
    new Notice(t("setting.cli.capability.failed", String(failed.length)));
  } catch {
    // 自检异常本身不当成「接口自检失败」去刷屏，静默跳过
    s.lastAutoProbeOpenCodeVersion = version;
    await ctx.plugin.saveSettings();
  }
}

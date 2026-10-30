import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type XiaoyuanAgentPlugin from "../main";
import { XiaoyuanAgentChatView } from "../chat-view";
import { VIEW_TYPE_XIAOYUAN_AGENT_CHAT } from "../constants";
import type { XiaoyuanAgentSettings, AgentConfig } from "../types";
import { closePopup } from "../popup";
import { t } from "../i18n";
import { buildStatusCard, applySettingsDerivedRows } from "./status-card";
import { statusStore } from "./status-store";
import { buildCapabilityCheck } from "./capability";
import { buildCLITab } from "./tab-cli";
import { buildAPITab } from "./tab-api";
import { buildAgentsTab, buildAgentCard } from "./tab-agents";
import { buildSkillsTab } from "./tab-skills";
import { buildPromptsTab } from "./tab-prompts";
import { buildGeneralTab } from "./tab-general";
import { buildAboutTab } from "./tab-about";
import { decorateSetting, addStatusRow, updateRow, makeCollapsibleCard, addFieldText } from "./widgets";
import type { SettingsCtx } from "./context";

type TabId = "general" | "cli" | "api" | "agents" | "skills" | "prompts" | "about";

/**
 * 设置面板的薄编排层。
 *
 * 这里只负责：状态（当前标签 / 重绘代次）、标签栏、以及把各标签页的构造
 * 分派到 `settings/tab-*.ts`。具体控件在 `widgets.ts`，状态卡在 `status-card.ts`。
 * 拆分前这里是一个 1600+ 行的文件，加一个设置项要在六个标签的构建代码里翻。
 *
 * 下面的成员都是 `SettingsCtx` 的一部分（各标签页模块通过它回调宿主），
 * 因此不加 `private`：跨模块使用时 TS 才认得出这些成员。
 */
export class XiaoyuanAgentSettingTab extends PluginSettingTab implements SettingsCtx {
  plugin: XiaoyuanAgentPlugin;
  activeTab: TabId = "general";
  /**
   * 每次 `display()` 递增。状态卡的刷新是异步的（要跑子进程 / HTTP 探测），
   * 期间用户可能已经切了标签或改了设置导致重绘 —— 在飞的回调必须据此判断
   * 自己拿的 DOM 是否已经作废，否则会往旧节点上写、新卡永远停在「检查中」。
   */
  statusGeneration = 0;
  /** 上次手动刷新的时间，由状态卡渲染（不能靠局部变量，display 会重建 DOM） */
  lastSyncedAt = "";
  /**
   * 持久外壳：状态卡 + 标签栏只在首次 display() 构建一次，切标签只重建内容区，
   * 从而避免每次切标签都销毁并重新探测状态卡。Obsidian 关闭/重开设置面板后
   * containerEl 会被清空，所以每次 display() 都先确认外壳还在容器里。
   */
  private shellEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;

  constructor(app: App, plugin: XiaoyuanAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // 任意设置落盘后，把模型/代理等纯设置派生值直绑到状态卡
    this.plugin.afterSaveSettings = () => this.notifySettingsChanged();
  }

  display(): void {
    const { containerEl } = this;
    // 浮层挂在 modal 上、不在 containerEl 里，不主动收掉就会变成孤儿
    closePopup();
    // 外壳仍在容器内：切标签只重建内容区，状态卡 DOM 不销毁、不重新探测
    if (this.shellEl && containerEl.contains(this.shellEl) && this.contentEl) {
      this.contentEl.empty();
      this.buildTabContents(this.contentEl);
      // 标签栏不重建，选中态要手动跟上
      this.syncTabBarActive();
      return;
    }
    // 首次构建或面板被 Obsidian 重建：建持久外壳
    this.statusGeneration++;
    containerEl.empty();
    this.shellEl = containerEl.createDiv({ cls: "xyag-settings-shell" });
    this.buildStatusCard(this.shellEl);
    this.buildTabBar(this.shellEl);
    this.contentEl = this.shellEl.createDiv({ cls: "xyag-settings-content" });
    this.buildTabContents(this.contentEl);
    this.syncTabBarActive();
  }

  // ─── helpers ─────────────────────────────────────────────────────

  s(): XiaoyuanAgentSettings {
    return this.plugin.settings;
  }

  /** 重绘整个设置面板（SettingsCtx 里的名字是 refresh，避免与 Obsidian 的 display 混淆） */
  refresh(): void {
    this.display();
  }

  // ─── Tab Bar ─────────────────────────────────────────────────────

  /** 标签定义集中一处：`buildTabBar` 与 `syncTabBarActive` 必须共用同一顺序。 */
  private tabDefs(): { id: TabId; icon: string; label: string }[] {
    return [
      { id: "general", icon: "settings", label: t("tab.general") },
      { id: "cli", icon: "terminal-square", label: t("tab.cli") },
      { id: "api", icon: "key-round", label: t("tab.api") },
      { id: "agents", icon: "users", label: t("tab.agents") },
      { id: "skills", icon: "wand-sparkles", label: t("tab.skills") },
      { id: "prompts", icon: "file-pen", label: t("tab.prompts") },
      { id: "about", icon: "info", label: t("tab.about") },
    ];
  }

  buildTabBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "xyag-settings-tabs" });
    for (const tab of this.tabDefs()) {
      const btn = bar.createEl("button", { cls: "xyag-settings-tab", attr: { type: "button" } });
      const icon = btn.createSpan({ cls: "xyag-settings-tab-icon" });
      setIcon(icon, tab.icon);
      btn.createSpan({ text: tab.label });
      btn.onclick = () => {
        this.activeTab = tab.id;
        this.display();
      };
    }
  }

  /**
   * 同步标签栏选中态。
   *
   * 标签栏属于持久外壳，切标签时不再重建 —— 所以 `is-active` 必须单独同步，
   * 否则焦点颜色会一直停在首次构建时选中的那个标签上。
   */
  private syncTabBarActive(): void {
    const idx = this.tabDefs().findIndex((x) => x.id === this.activeTab);
    this.containerEl.querySelectorAll<HTMLElement>(".xyag-settings-tab").forEach((btn, i) => {
      btn.classList.toggle("is-active", i === idx);
    });
  }

  // ─── Tab Contents ────────────────────────────────────────────────

  buildTabContents(container: HTMLElement): void {
    switch (this.activeTab) {
      case "cli":
        this.buildCLITab(container);
        break;
      case "api":
        this.buildAPITab(container);
        break;
      case "agents":
        this.buildAgentsTab(container);
        break;
      case "general":
        this.buildGeneralTab(container);
        break;
      case "skills":
        this.buildSkillsTab(container);
        break;
      case "prompts":
        this.buildPromptsTab(container);
        break;
      case "about":
        this.buildAboutTab(container);
        break;
    }
  }

  refreshChatView(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT).first();
    if (leaf?.view instanceof XiaoyuanAgentChatView) {
      leaf.view.rebuildToolbar({ skipSync: true });
      leaf.view.refreshSessionMenu();
    }
  }

  /** OpenCode 配置变更或连接成功后，通知所有聊天视图刷新状态灯/工具栏。 */
  notifyChatViewsOpenCode(opts?: { sync?: boolean }): void {
    try {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT);
      for (const leaf of leaves) {
        const view = leaf.view as
          | {
              syncOpenCodeState?: (o: { force: boolean; silent: boolean }) => Promise<void>;
              markOpenCodeConnected?: () => void;
            }
          | undefined;
        if (!view) continue;
        if (opts?.sync && typeof view.syncOpenCodeState === "function") {
          void view.syncOpenCodeState({ force: true, silent: true });
        } else if (typeof view.markOpenCodeConnected === "function") {
          view.markOpenCodeConnected();
        }
      }
    } catch {}
  }

  // ─── SettingsCtx：通用控件（实现见 widgets.ts） ─────────────────────

  decorateSetting(setting: Setting, iconName: string): Setting {
    return decorateSetting(setting, iconName);
  }

  addStatusRow(container: HTMLElement, iconName: string, label: string, value: string): void {
    addStatusRow(container, iconName, label, value);
  }

  updateRow(card: HTMLElement, index: number, value: string): void {
    updateRow(card, index, value);
  }

  makeCollapsibleCard(head: HTMLElement, card: HTMLElement): HTMLElement {
    return makeCollapsibleCard(head, card);
  }

  addFieldText(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (val: string) => Promise<void>,
    password = false,
  ): void {
    addFieldText(container, label, value, placeholder, onChange, password);
  }

  // ─── SettingsCtx：状态卡与能力自检 ─────────────────────────────────

  buildStatusCard(container: HTMLElement): void {
    buildStatusCard(this, container);
  }

  currentStatusCard(): HTMLElement | null {
    return this.containerEl.querySelector<HTMLElement>(".xyag-settings-status");
  }

  refreshStatusCard(): Promise<void> {
    return statusStore.detect();
  }

  /** 设置落盘后把模型/代理等纯设置派生值直绑到状态卡（不重探连接） */
  notifySettingsChanged(): void {
    applySettingsDerivedRows(this);
  }

  detectCliConnection(): void {
    void statusStore.detectCli();
  }

  detectApiConnection(): void {
    void statusStore.detectApi();
  }

  buildCapabilityCheck(container: HTMLElement): void {
    buildCapabilityCheck(this, container);
  }

  // ─── SettingsCtx：各标签页 ────────────────────────────────────────

  buildCLITab(container: HTMLElement): void {
    buildCLITab(this, container);
  }

  buildAPITab(container: HTMLElement): void {
    buildAPITab(this, container);
  }

  buildAgentsTab(container: HTMLElement): void {
    buildAgentsTab(this, container);
  }

  buildAgentCard(container: HTMLElement, agent: AgentConfig): void {
    buildAgentCard(this, container, agent);
  }

  buildSkillsTab(container: HTMLElement): void {
    buildSkillsTab(this, container);
  }

  buildPromptsTab(container: HTMLElement): void {
    buildPromptsTab(this, container);
  }

  buildGeneralTab(container: HTMLElement): void {
    buildGeneralTab(this, container);
  }

  buildAboutTab(container: HTMLElement): void {
    buildAboutTab(this, container);
  }

  async syncOpenCodeModels(): Promise<void> {
    const s = this.s();
    try {
      const { ensureOpenCodeModels, ensureOpenCodeAgents } = await import("../opencode-sync");
      await ensureOpenCodeModels({ plugin: this.plugin, silent: false, force: true, reason: "manual" });
      await ensureOpenCodeAgents({ plugin: this.plugin, silent: false, force: true, reason: "manual" });
      await this.plugin.saveSettings();
      const count = s.opencodeModels?.length || 0;
      new Notice(count === 0 ? t("notice.noModels") : t("notice.syncModels", String(count)));
      // 只在同步成功时让聊天视图强制重同步：失败后再强同步会再起一次临时
      // server，端口撞车会让后续每次启动都直接以退出码 1 失败。
      this.notifyChatViewsOpenCode({ sync: true });
    } catch (err: unknown) {
      new Notice(t("notice.syncFailed", err instanceof Error ? err.message : String(err)));
    } finally {
      // 不管同步成功与否都要重绘：失败时也要反映当前真实状态，
      // 否则界面会一直停在旧列表上，看起来像「点了 ↻ 没反应」。
      this.display();
    }
  }
}

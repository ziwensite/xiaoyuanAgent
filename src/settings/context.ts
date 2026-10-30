import type { App, Setting } from "obsidian";
import type XiaoyuanAgentPlugin from "../main";
import type { XiaoyuanAgentSettings, AgentConfig } from "../types";

export type SettingsTabId = "general" | "cli" | "api" | "agents" | "skills" | "prompts" | "about";

/**
 * 各标签页模块需要的宿主能力。
 *
 * `settings/index.ts` 里的 `XiaoyuanAgentSettingTab` 实现这个接口，
 * 构造好之后把自己传给 `tab-*.ts`。这样标签页只依赖这一小份契约，
 * 不用反向 import 整个类（会形成循环依赖）。
 */
export interface SettingsCtx {
  app: App;
  plugin: XiaoyuanAgentPlugin;
  containerEl: HTMLElement;
  activeTab: SettingsTabId;
  /** 每次 display() 递增，异步刷新据此判断自己的 DOM 是否已作废 */
  statusGeneration: number;
  /** 上次手动刷新的时间，display() 重绘后仍能显示出来 */
  lastSyncedAt: string;

  s(): XiaoyuanAgentSettings;
  /** 重绘整个设置面板（= display()） */
  refresh(): void;
  refreshChatView(): void;
  notifyChatViewsOpenCode(opts?: { sync?: boolean }): void;
  syncOpenCodeModels(): Promise<void>;
  /** 配置变更后定向重探 CLI 连接状态（写入状态仓储，状态卡订阅自动更新） */
  detectCliConnection(): void;
  /** 配置变更后定向重探 API 连接状态 */
  detectApiConnection(): void;

  decorateSetting(setting: Setting, iconName: string): Setting;
  addStatusRow(container: HTMLElement, iconName: string, label: string, value: string): void;
  updateRow(card: HTMLElement, index: number, value: string): void;
  makeCollapsibleCard(head: HTMLElement, card: HTMLElement): HTMLElement;
  addFieldText(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (val: string) => Promise<void>,
    password?: boolean,
  ): void;

  currentStatusCard(): HTMLElement | null;
  refreshStatusCard(): Promise<void>;
  buildCapabilityCheck(container: HTMLElement): void;
  buildStatusCard(container: HTMLElement): void;

  buildCLITab(container: HTMLElement): void;
  buildAPITab(container: HTMLElement): void;
  buildAgentsTab(container: HTMLElement): void;
  buildAgentCard(container: HTMLElement, agent: AgentConfig): void;
  buildSkillsTab(container: HTMLElement): void;
  buildPromptsTab(container: HTMLElement): void;
  buildGeneralTab(container: HTMLElement): void;
  buildAboutTab(container: HTMLElement): void;
}

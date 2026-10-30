import * as fs from "fs/promises";
import * as path from "path";
import { Plugin, WorkspaceLeaf, Notice, MarkdownView, Menu, setIcon } from "obsidian";
import type { XiaoyuanAgentSettings, SkillEntry, ApiProviderConfig, PromptTemplate, AgentConfig } from "./types";
import { XiaoyuanAgentChatView } from "./chat-view";
import { XiaoyuanAgentSettingTab } from "./settings";
import { TextOperationModal } from "./modals";
import {
  DEFAULT_SETTINGS,
  VIEW_TYPE_XIAOYUAN_AGENT_CHAT,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_AGENTS,
  BUILTIN_AGENT_A_ID,
  BUILTIN_AGENT_C_ID,
  BUILTIN_TEMPLATE_IDS,
  CHAT_SESSIONS_KEY,
  CURRENT_SESSION_KEY,
  DELEGATION_CONCURRENCY,
} from "./constants";
import { ensureOpenCodeServer, stopOpenCodeServer } from "./ai";
import {
  setOpenCodeServerState,
  onOpenCodeServerStateChange,
  onOpenCodePortFallback,
  setProxyConfig,
  cleanupOrphanedOpenCodeServers,
} from "./opencode-server";
import { readServiceRegistration } from "./opencode-client";
import { getVaultBasePath, setVaultBasePath } from "./server";
import { statusStore } from "./settings/status-store";
import { showSelectionPopup } from "./selection-popup";
import { SpeakController } from "./speak-controller";
import { ensureDefaultAgent, getAgentDisplayName } from "./agent-registry";
import { closePopup } from "./popup";
import { formatTime } from "./utils";
import { writeBuildStamp, initDebugLog } from "./debug-log";
import { t, initLocale } from "./i18n";
import manifest from "../manifest.json";

/**
 * API Key 落盘编码。
 *
 * 旧实现直接 `btoa()`，有两个致命问题：
 * 1. `btoa()` 遇到非 Latin-1 字符直接抛错 → `saveSettings()` 整个失败 →
 *    **本次所有设置改动静默丢失**（`await this.saveData(...)` 根本没执行）；
 * 2. 没有任何标记，读取时只能「试 `atob`，失败就当明文」——
 *    而 `atob()` 对**形态合法的明文 Key** 不会抛错，只会返回一串乱码，
 *    于是明文 Key 被静默解坏。
 *
 * 现在写入时统一带 `b64:` 前缀（UTF-8 安全），读取时：
 * - 有前缀 → 按新格式解码；
 * - 无前缀 → 旧版数据，只有**确实是 `btoa` 输出形态**
 *   （纯 base64 字母表 + 长度是 4 的倍数）才解码，否则原样当作明文。
 */
const API_KEY_ENC_PREFIX = "b64:";

function encodeApiKey(raw: string): string {
  if (!raw) return raw;
  try {
    const bytes = new TextEncoder().encode(raw);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return API_KEY_ENC_PREFIX + btoa(bin);
  } catch {
    return raw;
  }
}

function decodeApiKey(stored: string): string {
  if (!stored) return stored;
  if (stored.startsWith(API_KEY_ENC_PREFIX)) {
    const body = stored.slice(API_KEY_ENC_PREFIX.length);
    try {
      const bin = atob(body);
      return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return body;
    }
  }
  // 旧版无前缀数据：btoa 的输出必然落在 base64 字母表里且长度是 4 的倍数，
  // 真正的明文 Key（如 sk-xxx、sk-or-v1-…）几乎必然含 `-` 或长度不整除，会被原样保留。
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(stored) && stored.length % 4 === 0) {
    try {
      const bin = atob(stored);
      const decoded = new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      if (decoded) return decoded;
    } catch {
      /* 判定错误，按明文处理 */
    }
  }
  return stored;
}

/** 深拷贝一层的数组：既隔离 `DEFAULT_SETTINGS` 里的共享对象，也挡住脏数据 */
function copySettingsArray<T>(value: unknown, fallback: readonly T[]): T[] {
  const src = Array.isArray(value) ? (value as T[]) : (fallback as T[]);
  return src.map((item) => (item && typeof item === "object" ? { ...item } : item));
}

/**
 * 后台委托队列：并发上限 `DELEGATION_CONCURRENCY`。
 *
 * 多 Agent 场景下，一条回复里可能出现多个 `@对方 任务`，
 * 全部并发发出会瞬间打满额度、也拖垮本地 OpenCode 服务。
 * 这里按到达顺序 FIFO 排队，最多同时跑 N 个。
 */
class DelegationQueue {
  private running = 0;
  private queue: (() => Promise<void>)[] = [];

  run(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await fn();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < DELEGATION_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.running++;
      void job()
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

export default class XiaoyuanAgentPlugin extends Plugin {
  settings!: XiaoyuanAgentSettings;
  speakController = new SpeakController();
  /** 后台委托并发队列（见 DESIGN.md Q5） */
  delegationQueue = new DelegationQueue();
  private lastSkillRun = new Map<string, number>();
  /** 旧版本设置需要一次性迁移，落盘时机由 onload 决定 */
  private needsSettingsMigration = false;
  private unloaded = false;
  /**
   * 设置落盘后回调（由设置面板注入）。用于把模型/代理等纯设置派生值直绑到
   * 状态卡，避免整页重建。任意 `saveSettings()` 都会触发（含聊天工具栏改模型）。
   */
  afterSaveSettings?: () => void;

  async onload() {
    initLocale();
    // 记一下现在跑的是哪一版：插件热重载之后设置面板不会重建，
    // 光看界面分不清新旧，落个版本号到磁盘上一眼就能确认。
    initDebugLog(this.app);
    writeBuildStamp(manifest.version);
    await this.loadSettings();

    // 复用上一次启动时拉起的 OpenCode 实例（如果它还活着）
    setOpenCodeServerState(this.settings.opencodeServerState);
    onOpenCodeServerStateChange((state) => {
      this.settings.opencodeServerState = state ?? undefined;
      if (this.unloaded) return;
      this.saveSettings().catch((e) => console.warn("保存 OpenCode 实例信息失败:", e));
    });
    // 配置端口被占用时插件会自动顺延，提示一下用户
    onOpenCodePortFallback(({ requested, actual }) => {
      new Notice(t("notice.opencodePortFallback", String(requested), String(actual)));
    });
    // 代理设置必须在第一次拉起 opencode 子进程之前生效
    this.applyProxyConfig();

    // 迁移完成后再落盘，确保不会把 opencodeServerState 覆盖掉
    if (this.needsSettingsMigration) {
      this.needsSettingsMigration = false;
      this.saveSettings().catch((e) => console.warn("迁移旧设置失败:", e));
    }

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (adapter.getBasePath) setVaultBasePath(adapter.getBasePath());

    // 启动即探测一次连接/版本状态并存入状态仓储；设置面板打开时直接读快照，
    // 不再在 display() 里重复探测。CLI 连接还会随 OpenCode 服务启停事件自动更新。
    statusStore.init(this);
    void statusStore.detect();

    // OpenCode CLI 通道实现层已抽空，待重新编写：启动前不再做路径探测 / 校验。

    this.registerView(VIEW_TYPE_XIAOYUAN_AGENT_CHAT, (leaf) => new XiaoyuanAgentChatView(leaf, this));
    const statusBarIndicator = this.addStatusBarItem();
    statusBarIndicator.addClass("xyag-speak-indicator");
    statusBarIndicator.style.display = "none";
    setIcon(statusBarIndicator, "volume-2");
    statusBarIndicator.addEventListener("click", () => this.speakController.stop());
    this.speakController.onChange = (speaking) => {
      statusBarIndicator.style.display = speaking ? "" : "none";
    };
    this.addRibbonIcon("message-circle", t("app.name"), () => this.activateChatView());

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        menu.addItem((item) => {
          item.setTitle(t("app.menu.title"));
          item.setIcon("sparkles");
          const submenu = item.setSubmenu();
          for (const tpl of this.settings.promptTemplates) {
            submenu.addItem((subItem) => {
              subItem.setTitle(`${tpl.name} — ${tpl.description}`);
              subItem.setIcon(tpl.icon);
              subItem.onClick(() => new TextOperationModal(this.app, this, tpl.id, sel).open());
            });
          }
        });
      }),
    );

    this.addCommand({
      id: "xiaoyuanAgent-toggle-chat",
      name: t("cmd.toggle"),
      callback: () => this.activateChatView(),
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "C" }],
    });

    this.addCommand({
      id: "xiaoyuanAgent-new-chat",
      name: t("cmd.newChat"),
      callback: () => {
        const leaf = this.activateChatView();
        if (leaf?.view instanceof XiaoyuanAgentChatView) void leaf.view.newChat();
      },
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "N" }],
    });

    this.addCommand({
      id: "xiaoyuanAgent-chat-with-note",
      name: t("cmd.chatWithNote"),
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice(t("notice.noEditor"));
          return;
        }
        const content = await this.app.vault.read(file);
        const leaf = this.activateChatView();
        if (leaf?.view instanceof XiaoyuanAgentChatView) {
          void leaf.view.addMessage("user", t("cmd.chatWithNote.msg", content.slice(0, 3000)));
        }
      },
    });

    this.addSettingTab(new XiaoyuanAgentSettingTab(this.app, this));

    // 动态注册 skill 命令
    for (const skill of this.settings.skills) this.registerSkillCommand(skill);

    // 定时 skill 任务
    this.registerInterval(
      window.setInterval(() => {
        const now = Date.now();
        for (const skill of this.settings.skills) {
          if (!skill.autoRunInterval) continue;
          const lastRun = this.lastSkillRun.get(skill.name) || 0;
          if (now - lastRun >= skill.autoRunInterval * 60 * 1000) {
            this.lastSkillRun.set(skill.name, now);
            this.executeScheduledSkill(skill).catch(() => {});
          }
        }
      }, 60000),
    );

    // 连接前清场：回收上一会话残留 / 历史遗留的 opencode serve 孤儿进程，
    // 释放配置端口，避免后续自建实例一路顺延漂移。绝不误杀托管服务（白名单在内部处理）。
    cleanupOrphanedOpenCodeServers(this.settings.opencode.port, readServiceRegistration());

    if (this.settings.opencode.autoStart) this.autoStartServer();

    if (this.settings.autoOpen) {
      this.app.workspace.onLayoutReady(() => this.activateChatView());
    }

    this.app.workspace.onLayoutReady(() => {
      this.cleanTempFiles();
    });

    this.registerDomEvent(document, "mouseup", (e: MouseEvent) => {
      setTimeout(() => {
        const modalEl = document.querySelector(".xyag-modal-container");
        if (modalEl?.contains(e.target as Node)) return;

        const chatEl = document.querySelector(".xyag-chat");
        if (chatEl?.contains(e.target as Node)) return;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const text = editor.getSelection();
        if (!text.trim()) return;

        const domSel = window.getSelection();
        if (!domSel || !domSel.rangeCount) return;
        const editorEl = view.contentEl;
        if (!editorEl.contains(domSel.anchorNode)) return;
        const rect = domSel.getRangeAt(0).getBoundingClientRect();
        const x = rect.left + rect.width / 2 - 60;
        const y = rect.top - 36;

        showSelectionPopup(text, x, y, {
          onSpeak: (value) => this.speakController.start(value),
          onQuote: (value) => {
            void this.activateChatView();
            const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT).first();
            if (chatLeaf?.view instanceof XiaoyuanAgentChatView) {
              chatLeaf.view.quote(value);
            }
          },
          onCapture: (value) => {
            navigator.clipboard.writeText(value);
            const cmdId = this.settings.captureCommandId;
            if (cmdId) this.app.commands.executeCommandById(cmdId);
          },
          onAITools: (value, ev) => {
            const menu = new Menu();
            for (const tpl of this.settings.promptTemplates) {
              menu.addItem((item) => {
                item.setTitle(`${tpl.name} — ${tpl.description}`);
                item.setIcon(tpl.icon);
                item.onClick(() => new TextOperationModal(this.app, this, tpl.id, value).open());
              });
            }
            menu.showAtMouseEvent(ev);
          },
        });
      }, 10);
    });
  }

  private async cleanTempFiles() {
    try {
      const tempDir = path.join(getVaultBasePath(), this.settings.chatHistoryPath, "temp");
      try {
        await fs.access(tempDir);
      } catch {
        return;
      }
      const names = await fs.readdir(tempDir);
      const mdFiles = names.filter((n) => n.endsWith(".md")).sort();
      const maxFiles = 50;
      while (mdFiles.length > maxFiles) {
        const f = mdFiles.shift();
        if (f) await fs.unlink(path.join(tempDir, f));
      }
    } catch (err: unknown) {
      console.warn("清理临时文件失败:", err);
    }
  }

  private async autoStartServer(): Promise<void> {
    try {
      const vaultDir = getVaultBasePath();
      await ensureOpenCodeServer(
        this.settings.opencode.cliPath,
        this.settings.opencode.hostname,
        this.settings.opencode.port,
        vaultDir,
        true,
      );
    } catch (err: unknown) {
      console.warn("自动启动 opencode serve 失败:", err);
    }
  }

  activateChatView(): WorkspaceLeaf | undefined {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT).first();
    if (!leaf) {
      const useRight = this.settings.chatViewType === "right";
      leaf = useRight ? (workspace.getRightLeaf(false) ?? undefined) : (workspace.getLeftLeaf(false) ?? undefined);
      if (leaf) leaf.setViewState({ type: VIEW_TYPE_XIAOYUAN_AGENT_CHAT, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
    return leaf;
  }

  getActiveEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor || null;
  }

  /** 注册单个 skill 命令（skills 列表变更时由设置面板调用）。 */
  registerSkillCommand(skill: SkillEntry): void {
    this.addCommand({
      id: `xiaoyuanAgent-skill-${skill.name}`,
      name: `📖 ${skill.name} — ${skill.description}`,
      callback: () => {
        const leaf = this.activateChatView();
        if (leaf?.view instanceof XiaoyuanAgentChatView) {
          leaf.view.setInputValue(`/${skill.name} `);
        }
      },
    });
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      opencode: { ...DEFAULT_SETTINGS.opencode, ...data?.opencode },
      // 这几项必须复制：`{...DEFAULT_SETTINGS}` 是浅拷贝，直接复用默认数组会让
      // 后面的就地修改（补内置模板、解码 Key、迁移 Agent）污染模块级常量。
      apiProviders: copySettingsArray<ApiProviderConfig>(data?.apiProviders, DEFAULT_SETTINGS.apiProviders),
      promptTemplates: copySettingsArray<PromptTemplate>(data?.promptTemplates, DEFAULT_SETTINGS.promptTemplates),
      skills: copySettingsArray<SkillEntry>(data?.skills, DEFAULT_SETTINGS.skills),
      agents: copySettingsArray<AgentConfig>(data?.agents, DEFAULT_SETTINGS.agents),
    };
    if (!this.settings.opencode.agent) this.settings.opencode.agent = "build";
    for (const p of this.settings.apiProviders) {
      if (p.apiKey) p.apiKey = decodeApiKey(p.apiKey);
    }

    // 一次性迁移 v1 时代保存的设置：
    // v1 的 CLI 通道走 `opencode run` 一次性命令，不需要常驻服务，
    // 所以「自动启动 Server」默认是关闭的；v2 改成常驻 HTTP 服务后必须打开。
    // 注意：只有真的发生了迁移才置位，否则每次启动都会多写一次 data.json，
    // 还可能把别的写入方刚保存的会话元数据盖回去。
    if (!this.settings.settingsVersion) {
      this.settings.opencode.autoStart = true;
      this.settings.settingsVersion = 1;
      this.needsSettingsMigration = true;
    }

    // 自建 OpenCode 实例的连接信息里带随机密码，落盘是混淆过的，读回来要还原
    const serverState = this.settings.opencodeServerState;
    if (serverState?.password) {
      this.settings.opencodeServerState = { ...serverState, password: decodeApiKey(serverState.password) };
    }

    this.migrateAgents(data);
    this.backfillTemplates();
  }

  /**
   * 旧数据迁移：源项目的 `assistantA` / `assistantC` → `agents[]`。
   * 已经有多 Agent 数据的原样保留；缺失的内置 Agent 按 id 补齐。
   */
  private migrateAgents(data: Record<string, unknown>): void {
    const legacyA = data?.assistantA as Partial<AgentConfig> | undefined;
    const legacyC = data?.assistantC as Partial<AgentConfig> | undefined;
    const hasAgents = Array.isArray(data?.agents) && (data.agents as unknown[]).length > 0;

    if (!hasAgents && (legacyA || legacyC)) {
      const a = { ...DEFAULT_AGENTS[0], ...legacyA };
      const c = { ...DEFAULT_AGENTS[1], ...legacyC };
      // 旧数据没有通道字段，按内置约定补
      a.id = BUILTIN_AGENT_A_ID;
      a.channel = "api";
      a.builtin = true;
      c.id = BUILTIN_AGENT_C_ID;
      c.channel = "cli";
      c.builtin = true;
      if (this.settings.execMode === "cli") {
        a.isDefault = false;
        c.isDefault = true;
      } else {
        a.isDefault = true;
        c.isDefault = false;
      }
      this.settings.agents = [a, c];
    }

    // 保证内置 Agent 一定在（用户可能只改过一半）
    for (const def of DEFAULT_AGENTS) {
      if (!this.settings.agents.some((x) => x.id === def.id)) {
        this.settings.agents.push({ ...def });
      }
    }
    // 内置 Agent 的系统提示词跟随 i18n 语言补全
    for (const agent of this.settings.agents) {
      if (agent.id === BUILTIN_AGENT_A_ID && !agent.systemPrompt) agent.systemPrompt = t("agent.defaultPromptA");
      if (agent.id === BUILTIN_AGENT_C_ID && !agent.systemPrompt) agent.systemPrompt = t("agent.defaultPromptC");
      if (!agent.avatar) agent.avatar = "bot";
      if (agent.enabled === undefined) agent.enabled = true;
    }
    ensureDefaultAgent(this.settings);
    // 修复被误写成 ID 的内置 Agent 名称
    for (const agent of this.settings.agents) {
      if (!agent.builtin) continue;
      const display = getAgentDisplayName(agent);
      if ((agent.id === BUILTIN_AGENT_A_ID || agent.id === BUILTIN_AGENT_C_ID) && (agent.name === agent.id || agent.name.startsWith("agent-") || !agent.name.trim())) {
        agent.name = display;
      }
    }
  }

  /** 补全 / 更新内置 Prompt 模板（跟随 i18n 语言）。 */
  private backfillTemplates(): void {
    for (const id of BUILTIN_TEMPLATE_IDS) {
      const def = DEFAULT_PROMPT_TEMPLATES.find((d) => d.id === id);
      const existing = this.settings.promptTemplates.find((x) => x.id === id);
      if (existing) {
        if (def && existing.prompt === def.prompt) {
          existing.name = t(`template.${id}.name`);
          existing.description = t(`template.${id}.desc`);
          existing.prompt = t(`template.${id}.prompt`);
        }
        if (def && !existing.icon) existing.icon = def.icon;
      } else if (def) {
        this.settings.promptTemplates.push({
          id,
          name: t(`template.${id}.name`),
          description: t(`template.${id}.desc`),
          prompt: t(`template.${id}.prompt`),
          icon: def.icon,
        });
      }
    }
    // 补全旧条目缺失的 icon 字段
    for (const tpl of this.settings.promptTemplates) {
      const def = DEFAULT_PROMPT_TEMPLATES.find((d) => d.id === tpl.id);
      if (def && !tpl.icon) tpl.icon = def.icon;
    }
    // 按默认顺序排序
    const orderMap = new Map(DEFAULT_PROMPT_TEMPLATES.map((x, i) => [x.id, i]));
    this.settings.promptTemplates.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  }

  /**
   * 让「启用本地代理 / 代理地址」真正生效。
   * 这两项设置以前只被写进 data.json，没有任何地方读它 —— 死配置。
   */
  private applyProxyConfig() {
    setProxyConfig({ enabled: this.settings.proxyEnabled, url: this.settings.proxyUrl });
  }

  async saveSettings() {
    // 代理是进程级配置，设置改完要立刻同步到子进程环境变量
    this.applyProxyConfig();
    const encoded = this.settings.apiProviders.map((p) => ({
      ...p,
      apiKey: p.apiKey ? encodeApiKey(p.apiKey) : p.apiKey,
    }));
    // 会话元数据（会话列表 / 当前会话 id）由 `saveSessionsMeta` 单独维护，
    // 它只写磁盘、不改 `this.settings`。这里若直接 `saveData({ ...this.settings })`，
    // 就会把**启动时**读到的旧值盖回去 —— 用户改一次设置，重启后就跳回旧会话。
    const onDisk = (await this.loadData()) || {};
    await this.saveData({
      ...this.settings,
      apiProviders: encoded,
      // 实例密码是随机串，落盘前用与 API Key 相同的编码做一层混淆
      // （data.json 会被引擎同步到云端，明文不合适）。
      opencodeServerState: this.settings.opencodeServerState
        ? { ...this.settings.opencodeServerState, password: encodeApiKey(this.settings.opencodeServerState.password || "") }
        : undefined,
      [CHAT_SESSIONS_KEY]: onDisk[CHAT_SESSIONS_KEY],
      [CURRENT_SESSION_KEY]: onDisk[CURRENT_SESSION_KEY],
    });
    // 状态卡刷新是纯 UI 回调，绝不能影响落盘：
    // 它一抛错，所有 `await saveSettings()` 的调用点都会中断（例如同步模型后
    // 的 display() 就再也执行不到，界面看着像「同步没反应」）。
    try {
      this.afterSaveSettings?.();
    } catch (err) {
      console.warn("[xiaoyuanAgent] 设置落盘后的状态卡刷新失败:", err);
    }
  }

  private async executeScheduledSkill(skill: SkillEntry) {
    const logLine = `- ${formatTime(Date.now())} | ${t("chat.systemMsg.autoExec")}: ${skill.name} — ${skill.description}\n`;

    try {
      const logPath = path.join(getVaultBasePath(), "_xiaoyuanAgent", "autoTaskLog.md");
      await fs.appendFile(logPath, logLine);
    } catch {}

    const leaf = this.activateChatView();
    if (leaf?.view instanceof XiaoyuanAgentChatView) {
      leaf.view.addSystemMessage(`${t("chat.systemMsg.autoExec")}: ${skill.name}`);
      leaf.view.setInputValue(`/${skill.name} ${t("chat.systemMsg.autoExec")}`);
      void leaf.view.sendMessage();
    }
  }

  async onunload() {
    this.unloaded = true;
    // 还开着的弹层先收掉：它往 document 上挂了监听，留着就是个泄漏
    closePopup();
    this.speakController.stop();
    for (const p of this.settings.apiProviders) {
      p.apiKey = "";
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT);
    stopOpenCodeServer();
  }
}

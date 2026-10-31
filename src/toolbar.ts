import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "./i18n";
import { showPopup, addPopupItem, addPopupSection } from "./popup";
import { attachModelPicker, shortModelName } from "./model-picker";
import { getActiveProvider } from "./constants";
import { ConfirmModal } from "./settings/widgets";
import {
  scopeOf,
  readContextStatus,
  compactContext,
  resetContext,
  type ContextStatus,
} from "./context-control";
import {
  API_REASONING_OPTIONS,
  CLI_REASONING_OPTIONS,
  reasoningPresetLabel,
  reasoningValueLabel,
  toReasoningPreset,
} from "./reasoning";
import type XiaoyuanAgentPlugin from "./main";
import { getVaultBasePath, setWorkspacePath } from "./server";
import { invalidateOpenCodeConnection, stopOpenCodeServer } from "./opencode-server";

/** Electron remote.dialog 的最小声明（和 opencode-client 里 net 的做法一样，不为类型依赖 electron 包） */
interface ElectronRemoteLike {
  dialog?: {
    showOpenDialog(options: {
      properties: string[];
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
}

/**
 * 取 Electron remote：优先 `@electron/remote`（Obsidian 当前的挂载方式），
 * 退回旧的 `electron.remote`，两者都没有就返回 undefined。
 */
function loadElectronRemote(): ElectronRemoteLike | undefined {
  try {
    return require("@electron/remote") as ElectronRemoteLike;
  } catch {}
  try {
    return (require("electron") as { remote?: ElectronRemoteLike } | undefined)?.remote;
  } catch {}
  return undefined;
}

/**
 * 弹系统目录选择框（Electron 原生目录对话框）。
 */
function pickDirectory(onPick: (dir: string) => void): void {
  void (async () => {
    try {
      const dialog = loadElectronRemote()?.dialog;
      if (!dialog) throw new Error("remote dialog unavailable");
      const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      const dir = result.filePaths[0];
      if (!result.canceled && dir) onPick(dir);
    } catch {
      new Notice(t("notice.workspacePickFailed"));
    }
  })();
}

interface ToolbarHost {
  plugin: XiaoyuanAgentPlugin;
  abortController: AbortController | null;
  pickFiles(): void;
  sendMessage(): void;
  syncOpenCodeState(opts?: { force?: boolean; silent?: boolean }): Promise<void>;
  /** 聊天视图的会话列表与当前会话，用来定位上下文作用域（群聊 / 某个 Agent） */
  sessions?: import("./types").ChatSession[];
  currentSessionId?: string;
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

function describeContext(st: ContextStatus | null): string {
  if (!st) return t("chat.context.tip.new");
  const parts: string[] = [];
  if (st.tokens !== null) {
    parts.push(
      st.limit !== null
        ? t("chat.context.tip", fmtTokens(st.tokens), fmtTokens(st.limit), String(st.messageCount))
        : t("chat.context.tip.nolimit", fmtTokens(st.tokens), String(st.messageCount)),
    );
  } else {
    parts.push(t("chat.context.count", String(st.messageCount)));
  }
  if (st.compacted) parts.push(t("chat.context.compacted"));
  return parts.join(" · ");
}

/**
 * 上下文状态 chip（用量百分比 / 消息数），点击弹层里有压缩和重置。
 *
 * 挂在输入框上方的工具条（`.xyag-wiki-bar` 右侧），不占用下方发送栏。
 * 只有 CLI 通道才有长会话上下文，API 通道直接不渲染。
 */
export function buildContextControls(view: ToolbarHost, host: HTMLElement): void {
  if (view.plugin.settings.execMode !== "cli") return;
  const scope = scopeOf(view);
  const chip = host.createSpan({ cls: "xyag-context-chip" });
  chip.setText("…");

  const render = (st: ContextStatus | null) => {
    chip.removeClass("is-high", "is-over");
    if (!st) {
      chip.setText(t("chat.context.new"));
      setTooltip(chip, t("chat.context.tip.new"));
      return;
    }
    // 用量来自最近一次请求的 prompt token 数，上限来自该模型的上下文窗口
    const pct = st.limit && st.tokens !== null ? Math.min(100, Math.round((st.tokens / st.limit) * 100)) : null;
    if (pct !== null) chip.setText(`${pct}%`);
    else if (st.compacted) chip.setText(t("chat.context.compacted"));
    else chip.setText(t("chat.context.count", String(st.messageCount)));
    setTooltip(chip, describeContext(st));
    if (pct !== null && pct >= 90) chip.addClass("is-over");
    else if (pct !== null && pct >= 70) chip.addClass("is-high");
  };

  const refresh = async (): Promise<void> => {
    try {
      render(await readContextStatus(view.plugin, scope));
    } catch {
      render(null);
    }
  };

  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const popup = showPopup(
      chip,
      async (body) => {
        const st = await readContextStatus(view.plugin, scope).catch(() => null);
        render(st);
        const info = body.createDiv({ cls: "xyag-context-info" });
        info.setText(describeContext(st));
        addPopupItem(body, t("chat.context.compress"), false, () => {
          void (async () => {
            const ok = await compactContext(view.plugin, scope).catch(() => false);
            if (!ok) {
              new Notice(t("notice.contextUnavailable"));
              return;
            }
            new Notice(t("notice.contextCompressed"));
            // 压缩是异步任务：空闲会话几秒内完成，分两次刷新就够
            window.setTimeout(() => void refresh(), 3000);
            window.setTimeout(() => void refresh(), 9000);
          })();
        });
        // 重置：从进度弹层里进，不再单独占一个工具栏按钮
        addPopupItem(body, t("chat.context.reset"), false, () => {
          new ConfirmModal(view.plugin.app, t("chat.context.resetConfirm"), async () => {
            await resetContext(view.plugin, scope);
            render(null);
            new Notice(t("notice.contextReset"));
          });
        });
      },
      {
        // 输入框上方的 chip：菜单向上弹，别盖住输入框
        direction: "up",
        minWidth: 220,
        onClose: () => chip.classList.remove("is-open"),
      },
    );
    if (popup) chip.addClass("is-open");
  });

  void refresh();
}

/**
 * 工作区切换 chip：挂在聊天头部最左侧。
 *
 * 工作区 = AI（CLI 通道）实际操作的目录，默认库根目录。
 * 切换时清会话绑定（旧会话属于旧目录）并停掉 OpenCode 服务，
 * 让它下条消息用新目录重启。
 */
export function buildWorkspaceChip(view: ToolbarHost, host: HTMLElement): void {
  const wsChip = host.createSpan({ cls: "xyag-level-select xyag-workspace-chip" });
  const wsLabel = () => {
    const p = view.plugin.settings.workspacePath?.trim();
    if (!p) return t("chat.workspace.default");
    return p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || p;
  };
  const refresh = () => {
    const custom = !!view.plugin.settings.workspacePath?.trim();
    wsChip.textContent = wsLabel();
    wsChip.classList.toggle("is-active", custom);
    setTooltip(wsChip, view.plugin.settings.workspacePath || getVaultBasePath());
  };
  refresh();

  const switchWorkspace = async (dir: string) => {
    const settings = view.plugin.settings;
    settings.workspacePath = dir;
    if (dir) {
      const rest = (settings.recentWorkspaces || []).filter((p) => p !== dir);
      settings.recentWorkspaces = [dir, ...rest].slice(0, 5);
    }
    setWorkspacePath(dir);
    settings.opencodeSessionBindings = {};
    await view.plugin.saveSettings();
    try {
      stopOpenCodeServer();
      invalidateOpenCodeConnection();
    } catch {}
    refresh();
    new Notice(t("chat.workspace.switched", dir || t("chat.workspace.default")));
  };

  wsChip.addEventListener("click", (e) => {
    e.stopPropagation();
    showPopup(
      wsChip,
      (popup) => {
        const cur = view.plugin.settings.workspacePath?.trim() || "";
        addPopupItem(popup, t("chat.workspace.default"), !cur, () => void switchWorkspace(""));
        for (const p of view.plugin.settings.recentWorkspaces || []) {
          addPopupItem(popup, p, p === cur, () => void switchWorkspace(p));
        }
        popup.createDiv({ cls: "xyag-popup-separator" });
        addPopupItem(popup, t("chat.workspace.browse"), false, () => {
          pickDirectory((dir) => void switchWorkspace(dir));
        });
      },
      { direction: "auto", minWidth: 220 },
    );
  });
}

export function buildToolbarContent(container: HTMLElement, view: ToolbarHost): HTMLSpanElement {
  const s = view.plugin.settings;

  const attachBtn = container.createSpan({ cls: "xyag-attach-btn" });
  setIcon(attachBtn, "paperclip");
  setTooltip(attachBtn, t("chat.tooltip.attach"));
  attachBtn.addEventListener("click", () => view.pickFiles());

  const getAgentOptions = () => {
    const cur = view.plugin.settings;
    const list = cur.opencodeAgents || [];
    if (list.length) {
      return list.map((a) => ({ value: a.id, label: a.name || a.id }));
    }
    return [
      { value: "build", label: "build" },
      { value: "plan", label: "plan" },
    ];
  };
  const getAgentLabel = (id: string) => {
    const opts = getAgentOptions();
    return opts.find((o) => o.value === id)?.label || id;
  };
  let agentOptions = getAgentOptions();
  const agentText = container.createSpan({ cls: "xyag-level-select" });
  const updateAgentDisplay = () => {
    const label = getAgentLabel(view.plugin.settings.opencode.agent);
    agentText.textContent = label;
    setTooltip(agentText, label);
  };
  updateAgentDisplay();
  setTooltip(agentText, t("chat.agent.tooltip"));
  agentText.addEventListener("click", async (e) => {
    e.stopPropagation();
    const cur = view.plugin.settings;
    if (cur.execMode === "cli") {
      const list = cur.opencodeAgents || [];
      if (list.length === 0 || !list.some((a) => a.id === cur.opencode.agent)) {
        agentText.addClass("is-loading");
        try {
          const { ensureOpenCodeAgents } = await import("./opencode-sync");
          await ensureOpenCodeAgents({ plugin: view.plugin, silent: true, reason: "toolbar-click" });
        } catch {}
        agentText.removeClass("is-loading");
        updateAgentDisplay();
      }
    }
    agentOptions = getAgentOptions();
    const agentPopup = showPopup(
      agentText,
      (popup) => {
        for (const m of agentOptions) {
          addPopupItem(popup, m.label, m.value === view.plugin.settings.opencode.agent, async () => {
            view.plugin.settings.opencode.agent = m.value;
            await view.plugin.saveSettings();
            agentText.textContent = m.label;
            setTooltip(agentText, m.label);
            const chatEl = agentText.closest<HTMLElement>(".xyag-chat");
            chatEl?.removeClass("xyag-agent-plan", "xyag-agent-build");
            if (m.value === "plan") chatEl?.addClass("xyag-agent-plan");
            else if (m.value === "build") chatEl?.addClass("xyag-agent-build");
            new Notice(t("setting.cli.agent") + ": " + m.label);
          });
        }
      },
      {
        direction: "auto",
        onClose: () => agentText.classList.remove("is-open"),
      },
    );
    if (agentPopup) agentText.classList.add("is-open");
  });

  // Model trigger
  const isCli = s.execMode === "cli";
  const trigger = container.createSpan({ cls: "xyag-model-select" });
  const cliModelLabel = () => (s.opencode.model ? shortModelName(s.opencode.model) : t("chat.model.tooltip"));
  trigger.textContent = isCli ? cliModelLabel() : getActiveProvider(s)?.model || t("chat.model.tooltip");
  setTooltip(trigger, isCli ? s.opencode.model || t("status.notConfigured") : getActiveProvider(s)?.model || t("status.notConfigured"));
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    attachModelPicker(trigger, s, {
      direction: "auto",
      withApiSection: true,
      fullWidth: true,
      persist: () => view.plugin.saveSettings(),
      autoSync: () => view.syncOpenCodeState({ force: false, silent: true }),
      onToggle: (open) => trigger.classList.toggle("is-open", open),
      onRefresh: () => {
        void view.syncOpenCodeState({ force: true, silent: false }).then(() => {
          if (s.execMode !== "cli") return;
          trigger.textContent = cliModelLabel();
          setTooltip(trigger, s.opencode.model || t("status.notConfigured"));
        });
      },
      onSelect: (modelId) => {
        if (s.execMode === "cli") {
          trigger.textContent = shortModelName(modelId);
          setTooltip(trigger, modelId);
        }
        new Notice(t("setting.cli.model") + ": " + shortModelName(modelId));
      },
      onSelectApi: (label) => {
        if (s.execMode === "api") {
          trigger.textContent = getActiveProvider(s)?.model || label;
          setTooltip(trigger, label);
        }
        new Notice(t("notice.switchedTo", label));
      },
    });
  });

  // Reasoning level：两条通道各有一套取值，弹层里两组都给。
  const levelText = container.createSpan({ cls: "xyag-level-select" });
  levelText.textContent = isCli ? reasoningValueLabel(s.defaultReasoning) : reasoningValueLabel(s.apiReasoningEffort);
  setTooltip(levelText, t("chat.reasoning.tooltip"));
  levelText.addEventListener("click", (e) => {
    e.stopPropagation();
    const levelPopup = showPopup(
      levelText,
      (popup) => {
        const cliBody = addPopupSection(popup, t("mode.cli"));
        for (const option of CLI_REASONING_OPTIONS) {
          const active = toReasoningPreset(s.defaultReasoning) === option.preset;
          addPopupItem(cliBody, reasoningPresetLabel(option.preset), active, async () => {
            s.defaultReasoning = option.value;
            await view.plugin.saveSettings();
            if (s.execMode === "cli") levelText.textContent = reasoningPresetLabel(option.preset);
            new Notice(t("setting.cli.reasoning") + ": " + reasoningPresetLabel(option.preset));
          });
        }
        popup.createDiv({ cls: "xyag-popup-separator" });
        const apiBody = addPopupSection(popup, t("mode.api"));
        for (const option of API_REASONING_OPTIONS) {
          const active = toReasoningPreset(s.apiReasoningEffort) === option.preset;
          addPopupItem(apiBody, reasoningPresetLabel(option.preset), active, async () => {
            s.apiReasoningEffort = option.value;
            await view.plugin.saveSettings();
            if (s.execMode === "api") levelText.textContent = reasoningPresetLabel(option.preset);
            new Notice(t("setting.api.reasoning") + ": " + reasoningPresetLabel(option.preset));
          });
        }
      },
      {
        direction: "auto",
        maxHeight: "50vh",
        minWidth: 160,
        onClose: () => levelText.classList.remove("is-open"),
      },
    );
    if (levelPopup) levelText.classList.add("is-open");
  });

  // 发送按钮靠右；上下文状态 / 重置挂在输入框上方的工具条里
  const rightGroup = container.createSpan({ cls: "xyag-toolbar-right" });

  // Send/Stop button
  const sendBtn = rightGroup.createSpan({ cls: "xyag-send-btn" });
  sendBtn.addEventListener("click", () => {
    if (view.abortController) view.abortController.abort();
    else view.sendMessage();
  });
  return sendBtn;
}

import { Notice, setTooltip } from "obsidian";
import { t } from "./i18n";
import { showPopup, addPopupItem, addPopupSection } from "./popup";
import { attachModelPicker, shortModelName } from "./model-picker";
import { getActiveProvider } from "./constants";
import {
  API_REASONING_OPTIONS,
  CLI_REASONING_OPTIONS,
  reasoningPresetLabel,
  reasoningValueLabel,
  toReasoningPreset,
} from "./reasoning";
import type XiaoyuanAgentPlugin from "./main";

interface ToolbarHost {
  plugin: XiaoyuanAgentPlugin;
  abortController: AbortController | null;
  pickFiles(): void;
  sendMessage(): void;
  syncOpenCodeState(opts?: { force?: boolean; silent?: boolean }): Promise<void>;
}

export function buildToolbarContent(container: HTMLElement, view: ToolbarHost): HTMLSpanElement {
  const s = view.plugin.settings;

  const attachBtn = container.createSpan({ cls: "xyag-attach-btn" });
  attachBtn.textContent = "+";
  setTooltip(attachBtn, t("chat.tooltip.attach"));
  attachBtn.addEventListener("click", () => view.pickFiles());

  // Context indicator
  if (s.showContext) {
    const ctxBtn = container.createSpan({ cls: "xyag-attach-btn" });
    ctxBtn.textContent = "📋";
    setTooltip(ctxBtn, t("chat.tooltip.context"));
  }

  // OpenCode 内置 agent（非本插件的 Agent）。
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
      minWidth: 200,
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

  // Send/Stop button
  const sendBtn = container.createSpan({ cls: "xyag-send-btn" });
  sendBtn.style.marginLeft = "auto";
  sendBtn.addEventListener("click", () => {
    if (view.abortController) view.abortController.abort();
    else view.sendMessage();
  });
  return sendBtn;
}

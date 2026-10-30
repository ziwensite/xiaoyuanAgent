import type { SettingsCtx } from "./context";
import { ConfirmModal } from "./widgets";
import { canRemoveAgent, createAgent, defaultCapabilityFor, defaultPromptFor, ensureDefaultAgent, getAgentDisplayName, getDefaultAgent, isAgentNameTaken, listAgents, setDefaultAgent } from "../agent-registry";
import { AGENT_AVATARS } from "../constants";
import { t } from "../i18n";
import { createSelectField } from "../select-list";
import { AgentChannel, AgentConfig } from "../types";
import { Notice, setIcon } from "obsidian";

// ─── Agents 设置（新增） ──────────────────────────────────────────

export function buildAgentsTab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();

  container.createEl("p", { cls: "xyag-settings-desc", text: t("setting.agents.desc") });

  const extraAgents = listAgents(s, true).filter((a) => !a.builtin);
  if (extraAgents.length === 0) {
    container.createDiv({ cls: "xyag-settings-empty", text: t("setting.agents.empty") });
  }

  for (const agent of listAgents(s, true)) buildAgentCard(ctx, container, agent);

  const addBtn = container.createDiv({ cls: "xyag-settings-status-actions" });
  const newBtn = addBtn.createEl("button", { cls: "xyag-status-btn", text: t("setting.agents.add") });
  newBtn.addEventListener("click", async () => {
    const agent = createAgent(s);
    s.agents.push(agent);
ensureDefaultAgent(s);
    await ctx.plugin.saveSettings();
    ctx.refresh();
  });
}

/** 单个 Agent 卡片（样式复用 API provider 卡片）。 */
export function buildAgentCard(ctx: SettingsCtx, container: HTMLElement, agent: AgentConfig) {
  const s = ctx.s();
  const isDefault = getDefaultAgent(s)?.id === agent.id;
  const card = container.createDiv({ cls: `xyag-api-provider-row${isDefault ? " is-active" : ""}` });

  const head = card.createDiv({ cls: "xyag-api-provider-head" });
  const title = head.createDiv({ cls: "xyag-api-provider-title" });
  const iconSpan = title.createSpan({ cls: "xyag-agent-card-icon" });
setIcon(iconSpan, agent.avatar || "bot");
  const nameSpan = title.createSpan({ text: getAgentDisplayName(agent) });
  const badge = title.createEl("small", {
    cls: `xyag-agent-badge xyag-agent-badge-${agent.channel}`,
    text: agent.channel === "cli" ? t("setting.agents.channelBadge.cli") : t("setting.agents.channelBadge.api"),
  });
  const updateHeader = () => {
    nameSpan.textContent = getAgentDisplayName(agent);
    badge.textContent =
      agent.channel === "cli" ? t("setting.agents.channelBadge.cli") : t("setting.agents.channelBadge.api");
    badge.className = `xyag-agent-badge xyag-agent-badge-${agent.channel}`;
  };

  const headActions = head.createDiv({ cls: "xyag-api-provider-actions" });

  // 启用 / 停用（至少保留一个启用）
  const enableBtn = headActions.createEl("button", {
    cls: "xyag-status-btn",
    text: agent.enabled ? t("setting.agents.enabled") : t("setting.agents.disabled"),
  });
  enableBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (agent.enabled && listAgents(s).length <= 1) {
      new Notice(t("setting.agents.keepOne"));
      return;
    }
    agent.enabled = !agent.enabled;
ensureDefaultAgent(s);
    await ctx.plugin.saveSettings();
    ctx.refresh();
  });

  // 设为默认
  if (!isDefault) {
    const defBtn = headActions.createEl("button", { cls: "xyag-status-btn", text: t("setting.agents.setDefault") });
    defBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
setDefaultAgent(s, agent.id);
      await ctx.plugin.saveSettings();
      ctx.refreshChatView();
      ctx.refresh();
    });
  } else {
    title.createEl("small", { text: t("setting.prompts.default"), cls: "xyag-mcp-disabled" });
  }

  // 删除
  const delBtn = headActions.createEl("button", { cls: "xyag-status-btn", text: t("setting.agents.delete") });
  if (!canRemoveAgent(agent)) {
    delBtn.disabled = true;
    delBtn.setAttribute("aria-label", t("setting.agents.builtinTip"));
    delBtn.title = t("setting.agents.builtinTip");
  } else {
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      // `window.confirm` 在 Electron 里多半直接不可用，
      // 点了没反应的话用户就永远删不掉新建的 Agent。用自己的 Modal。
      new ConfirmModal(ctx.app, t("setting.agents.deleteConfirm", agent.name), async () => {
        s.agents = s.agents.filter((a) => a.id !== agent.id);
ensureDefaultAgent(s);
        await ctx.plugin.saveSettings();
        ctx.refreshChatView();
        ctx.refresh();
      }).open();
    });
  }

  const content = ctx.makeCollapsibleCard(head, card);

  // 名称（唯一性校验）
  const nameField = content.createDiv({ cls: "xyag-api-provider-field" });
  nameField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.name") });
  const nameInput = nameField.createEl("input", { cls: "xyag-api-provider-input" });
  nameInput.value = agent.name;
  nameInput.addEventListener("change", async () => {
    const next = nameInput.value.trim();
    if (!next) {
      nameInput.value = agent.name;
      return;
    }
    if (isAgentNameTaken(s, next, agent.id)) {
      new Notice(t("setting.agents.nameTaken", next));
      nameInput.value = agent.name;
      return;
    }
    agent.name = next;
    await ctx.plugin.saveSettings();
updateHeader();
    ctx.refreshChatView();
  });
  nameField.createDiv({ cls: "xyag-field-hint", text: t("setting.agents.name.desc") });

  // 头像
  const avatarField = content.createDiv({ cls: "xyag-api-provider-field" });
  avatarField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.avatar") });
  const avatarOptions: string[] = [...AGENT_AVATARS];
  if (!AGENT_AVATARS.includes(agent.avatar as (typeof AGENT_AVATARS)[number])) {
    avatarOptions.push(agent.avatar);
  }
  avatarField.appendChild(
createSelectField({
      options: avatarOptions.map((v) => ({ value: v, label: v })),
      value: agent.avatar || "bot",
      ariaLabel: t("setting.agents.avatar"),
      onSelect: async (val) => {
        agent.avatar = val;
        await ctx.plugin.saveSettings();
setIcon(iconSpan, agent.avatar);
        ctx.refreshChatView();
      },
    }).el,
  );

  // 通道
  const channelField = content.createDiv({ cls: "xyag-api-provider-field" });
  channelField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.channel") });
  channelField.appendChild(
createSelectField({
      options: [
        { value: "api", label: t("setting.agents.channel.api") },
        { value: "cli", label: t("setting.agents.channel.cli") },
      ],
      value: agent.channel,
      ariaLabel: t("setting.agents.channel"),
      onSelect: async (val) => {
        agent.channel = val as AgentChannel;
        // 前台 Agent 换通道时同步 execMode（见 DESIGN.md Q1）
ensureDefaultAgent(s);
        await ctx.plugin.saveSettings();
updateHeader();
        ctx.refreshChatView();
      },
    }).el,
  );

  // 模型（文本框，留空=通道默认）
  const modelField = content.createDiv({ cls: "xyag-api-provider-field" });
  modelField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.model") });
  const modelInput = modelField.createEl("input", {
    cls: "xyag-api-provider-input",
    attr: { placeholder: agent.channel === "cli" ? t("setting.agents.model.cliHint") : t("setting.agents.model.apiHint") },
  });
  modelInput.value = agent.model || "";
  modelInput.addEventListener("change", async () => {
    agent.model = modelInput.value.trim() || undefined;
    await ctx.plugin.saveSettings();
  });
  modelField.createDiv({ cls: "xyag-field-hint", text: t("setting.agents.model.desc") });

  // 能力简介（一句话，注入群聊名单供其它 Agent 判断委托对象）
  const capField = content.createDiv({ cls: "xyag-api-provider-field" });
  capField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.capability") });
  const capInput = capField.createEl("input", {
    cls: "xyag-api-provider-input",
    attr: { placeholder: t("setting.agents.capability.hint") },
  });
  capInput.value = agent.capability || "";
  capInput.addEventListener("change", async () => {
    agent.capability = capInput.value.trim() || undefined;
    await ctx.plugin.saveSettings();
  });
  capField.createDiv({ cls: "xyag-field-hint", text: t("setting.agents.capability.desc") });

  // 系统提示词
  const promptField = content.createDiv({ cls: "xyag-api-provider-field" });
  const promptLabel = promptField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.agents.prompt") });
  // 恢复默认：提示词和能力简介一起重置为当前语言的出厂文案
  const resetBtn = promptLabel.createEl("button", { cls: "xyag-agent-reset-btn", text: t("setting.agents.resetDefault") });
  const promptArea = promptField.createEl("textarea", { cls: "xyag-api-provider-input", attr: { rows: "4" } });
  promptArea.value = agent.systemPrompt;
  promptArea.addEventListener("change", async () => {
    agent.systemPrompt = promptArea.value;
    await ctx.plugin.saveSettings();
  });
  resetBtn.addEventListener("click", async () => {
    agent.systemPrompt = defaultPromptFor(agent);
    agent.capability = defaultCapabilityFor(agent);
    promptArea.value = agent.systemPrompt;
    capInput.value = agent.capability || "";
    await ctx.plugin.saveSettings();
    new Notice(t("setting.agents.resetDone"));
  });
}

/** 设置改动后刷新聊天面板的工具栏与会话菜单。 */

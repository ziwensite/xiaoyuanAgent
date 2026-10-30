import type { SettingsCtx } from "./context";
import { BUILTIN_TEMPLATE_IDS, DEFAULT_PROMPT_TEMPLATES } from "../constants";
import { t } from "../i18n";


// ─── Prompt 模板 ──────────────────────────────────────────────────

export function buildPromptsTab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();
  const templates = s.promptTemplates || [];

  container.createEl("p", { cls: "xyag-settings-desc", text: t("setting.prompts.title") });

  if (templates.length === 0) {
    container.createDiv({ cls: "xyag-settings-empty", text: t("setting.prompts.empty") });
  }

  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    const builtin = BUILTIN_TEMPLATE_IDS.includes(tpl.id);
    const card = container.createDiv({ cls: "xyag-api-provider-row" });

    const head = card.createDiv({ cls: "xyag-api-provider-head" });
    const title = head.createDiv({ cls: "xyag-api-provider-title" });
    const nameSpan = title.createSpan({ text: tpl.name });
    title.createEl("small", { text: ` · ${tpl.description}` });
    if (builtin) title.createEl("small", { text: t("setting.prompts.default"), cls: "xyag-mcp-disabled" });

    const updateHeader = () => {
      nameSpan.textContent = tpl.name || t("api.provider.unnamed");
    };

    const content = ctx.makeCollapsibleCard(head, card);

    ctx.addFieldText(content, t("setting.prompts.name"), tpl.name, t("setting.prompts.namePlaceholder"), async (val) => {
      tpl.name = val;
      await ctx.plugin.saveSettings();
updateHeader();
    });

    ctx.addFieldText(
      content,
t("setting.prompts.desc.label"),
      tpl.description,
t("setting.prompts.descPlaceholder"),
      async (val) => {
        tpl.description = val;
        await ctx.plugin.saveSettings();
      },
    );

    const promptField = content.createDiv({ cls: "xyag-api-provider-field" });
    promptField.createSpan({ cls: "xyag-api-provider-label", text: t("setting.prompts.prompt") });
    const promptArea = promptField.createEl("textarea", {
      cls: "xyag-api-provider-input",
      attr: { rows: "4", placeholder: t("setting.prompts.placeholder") },
    });
    promptArea.value = tpl.prompt;
    promptArea.addEventListener("change", async () => {
      tpl.prompt = promptArea.value.trim();
      await ctx.plugin.saveSettings();
    });

    const btnField = content.createDiv({ cls: "xyag-api-provider-field" });
    if (builtin) {
      const restoreBtn = btnField.createEl("button", { cls: "xyag-status-btn", text: t("setting.prompts.restore") });
      restoreBtn.addEventListener("click", async () => {
        const def = DEFAULT_PROMPT_TEMPLATES.find((d) => d.id === tpl.id);
        if (def) {
          tpl.name = def.name;
          tpl.description = def.description;
          tpl.prompt = def.prompt;
          tpl.icon = def.icon;
          await ctx.plugin.saveSettings();
          ctx.refresh();
        }
      });
    } else {
      const deleteBtn = btnField.createEl("button", { cls: "xyag-status-btn", text: t("setting.prompts.delete") });
      deleteBtn.addEventListener("click", async () => {
        s.promptTemplates.splice(i, 1);
        await ctx.plugin.saveSettings();
        ctx.refresh();
      });
    }
  }

  const addBtn = container.createDiv({ cls: "xyag-settings-status-actions" });
  const newBtn = addBtn.createEl("button", { cls: "xyag-status-btn", text: t("setting.prompts.add") });
  newBtn.addEventListener("click", async () => {
    s.promptTemplates.push({
      id: "tpl-" + Date.now(),
      name: t("setting.prompts.newName"),
      description: t("setting.prompts.newDesc"),
      prompt: t("setting.prompts.defaultPrompt"),
      icon: "file-pen",
    });
    await ctx.plugin.saveSettings();
    ctx.refresh();
  });
}


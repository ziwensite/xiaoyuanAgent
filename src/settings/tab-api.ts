import type { SettingsCtx } from "./context";
import { probeProvider } from "../connection-checker";
import { t } from "../i18n";
import { API_REASONING_OPTIONS, reasoningPresetLabel, toReasoningPreset } from "../reasoning";
import { createSelectField } from "../select-list";
import { Notice, Setting } from "obsidian";

// ─── API 设置 ─────────────────────────────────────────────────────

export function buildAPITab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();

  const providers = s.apiProviders;
  const activeId = s.activeApiProviderId || providers[0]?.id || "";

  for (const provider of providers) {
    const isActive = provider.id === activeId;
    const card = container.createDiv({ cls: `xyag-api-provider-row${isActive ? " is-active" : ""}` });

    const head = card.createDiv({ cls: "xyag-api-provider-head" });
    const title = head.createDiv({ cls: "xyag-api-provider-title" });
    const nameSpan = title.createSpan({ text: provider.name || t("api.provider.unnamed") });
    const modelSmall = title.createEl("small", { text: " · " + (provider.model || t("api.provider.noModel")) });
    const updateHeader = () => {
      nameSpan.textContent = provider.name || t("api.provider.unnamed");
      modelSmall.textContent = " · " + (provider.model || t("api.provider.noModel"));
    };

    const headActions = head.createDiv({ cls: "xyag-api-provider-actions" });

    if (!isActive) {
      const activateBtn = headActions.createEl("button", {
        cls: "xyag-status-btn",
        text: t("setting.api.provider.activate"),
      });
      activateBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        s.activeApiProviderId = provider.id;
        await ctx.plugin.saveSettings();
        ctx.refresh();
        const ok = await probeProvider(provider);
        new Notice(ok ? t("notice.switchedTo", provider.name) : t("notice.connFailed", provider.name));
        // 切换活跃 provider 影响 API 连接状态，定向重探状态卡 API 行
        ctx.detectApiConnection();
      });
    }

    const testBtn = headActions.createEl("button", { cls: "xyag-status-btn", text: t("setting.api.provider.test") });
    testBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await probeProvider(provider);
      new Notice(ok ? t("notice.connSuccess", provider.name) : t("notice.connFailGeneric", provider.name));
      ctx.detectApiConnection();
    });

    const deleteBtn = headActions.createEl("button", {
      cls: "xyag-status-btn",
      text: t("setting.api.provider.delete"),
    });
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (providers.length <= 1) {
        new Notice(t("setting.api.provider.leastOne"));
        return;
      }
      s.apiProviders = providers.filter((p) => p.id !== provider.id);
      if (s.activeApiProviderId === provider.id) s.activeApiProviderId = s.apiProviders[0]?.id || "";
      await ctx.plugin.saveSettings();
      ctx.refresh();
    });

    const content = ctx.makeCollapsibleCard(head, card);

    ctx.addFieldText(content, t("setting.api.provider.name"), provider.name, t("api.provider.namePlaceholder"), async (val) => {
      provider.name = val;
      await ctx.plugin.saveSettings();
updateHeader();
    });
    ctx.addFieldText(content, "Base URL", provider.baseUrl, "https://api.openai.com/v1", async (val) => {
      provider.baseUrl = val;
      await ctx.plugin.saveSettings();
      ctx.detectApiConnection();
    });
    ctx.addFieldText(content, t("setting.api.provider.model"), provider.model, "gpt-4o", async (val) => {
      provider.model = val;
      await ctx.plugin.saveSettings();
updateHeader();
    });
    ctx.addFieldText(
      content,
      "API Key",
      provider.apiKey,
      "sk-...",
      async (val) => {
        provider.apiKey = val;
        await ctx.plugin.saveSettings();
        ctx.detectApiConnection();
      },
      true,
    );
  }

  const addBtn = container.createDiv({ cls: "xyag-settings-status-actions" });
  const newBtn = addBtn.createEl("button", { cls: "xyag-status-btn", text: t("setting.api.provider.new") });
  newBtn.addEventListener("click", async () => {
    s.apiProviders.push({
      id: `provider_${Date.now()}`,
      name: t("api.provider.newName"),
      baseUrl: "",
      model: "",
      apiKey: "",
    });
    await ctx.plugin.saveSettings();
    ctx.refresh();
  });

  container.createEl("hr");
  container.createEl("h3", { text: t("setting.api.params") });

  const apiReasoningSetting = new Setting(container)
    .setName(t("setting.api.reasoning"))
    .setDesc(t("setting.api.reasoning.desc"));
  const apiReasoningOptions = API_REASONING_OPTIONS.map((o) => ({
    value: o.preset,
    label: reasoningPresetLabel(o.preset),
  }));
  apiReasoningSetting.controlEl.appendChild(
createSelectField({
      options: apiReasoningOptions,
      value: toReasoningPreset(s.apiReasoningEffort),
      ariaLabel: t("setting.api.reasoning"),
      onSelect: async (val) => {
        const option = API_REASONING_OPTIONS.find((o) => o.preset === val);
        if (!option || option.value === s.apiReasoningEffort) return;
        s.apiReasoningEffort = option.value;
        await ctx.plugin.saveSettings();
        ctx.refreshChatView();
      },
    }).el,
  );
  ctx.decorateSetting(apiReasoningSetting, "brain");

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.api.temperature"))
      .setDesc(t("setting.api.temperature.desc"))
      .addSlider((slider) =>
        slider.setLimits(0, 2, 0.1).setValue(s.temperature).onChange(async (val) => {
          s.temperature = val;
          await ctx.plugin.saveSettings();
        }),
      ),
    "thermometer",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.api.maxTokens"))
      .addText((text) =>
        text
          .setPlaceholder("4096")
          .setValue(s.maxTokens === 4096 ? "" : String(s.maxTokens))
          .onChange(async (val) => {
            const n = parseInt(val);
            s.maxTokens = n > 0 ? n : 4096;
            await ctx.plugin.saveSettings();
          }),
      ),
    "subtitles",
  );
}

/**
 * 可折叠卡片：点卡片头展开 / 收起内容区，点头上的按钮不触发折叠。
 * 默认收起 —— 这类卡片动辄十几个输入框，全展开列表会长得离谱。
 */

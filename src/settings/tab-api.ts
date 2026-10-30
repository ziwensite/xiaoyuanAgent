import type { SettingsCtx } from "./context";
import { fetchProviderModels, probeProvider } from "../connection-checker";
import { t } from "../i18n";
import { API_REASONING_OPTIONS, reasoningPresetLabel, toReasoningPreset } from "../reasoning";
import { createSelectField } from "../select-list";
import { addPopupItem, showPopup } from "../popup";
import { Notice, Setting, setIcon } from "obsidian";
import type { ApiProviderConfig } from "../types";

// ─── API 设置 ─────────────────────────────────────────────────────

/**
 * 提供商的模型列表编辑器。
 *
 * 一个提供商（baseUrl + apiKey）下挂多个模型，每行一个：
 * 点行首圆圈设为当前模型，行尾 × 删除。底部「+ 添加模型」。
 * 当前模型写在 provider.model，必须始终指向列表中的一项。
 */
function buildModelListEditor(
  ctx: SettingsCtx,
  content: HTMLElement,
  provider: ApiProviderConfig,
  updateHeader: () => void,
): void {
  const models = () => provider.models ?? (provider.models = []);
  // 排序渲染，不改动存储顺序（用户手动排的意义不大，稳定字典序更好找）
  const sortedModels = () => [...models()].sort((a, b) => a.localeCompare(b));

  const field = content.createDiv({ cls: "xyag-api-provider-field xyag-api-models-field" });
  field.createSpan({ cls: "xyag-api-provider-label", text: t("setting.api.provider.model") });
  const listEl = field.createDiv({ cls: "xyag-api-models-list" });

  const save = () => ctx.plugin.saveSettings();

  const renderRows = () => {
    listEl.empty();
    for (const model of sortedModels()) {
      const row = listEl.createDiv({ cls: `xyag-api-model-row${model === provider.model ? " is-current" : ""}` });
      row.setAttribute("title", t("setting.api.provider.setCurrent"));
      row.createSpan({ cls: "xyag-api-model-name", text: model });
      // 点击整行设为当前模型
      row.addEventListener("click", async () => {
        if (provider.model === model) return;
        provider.model = model;
        await save();
        renderRows();
        updateHeader();
        ctx.refreshChatView();
      });
      // 删除（至少保留一行）
      const delBtn = row.createEl("button", { cls: "xyag-api-model-del", attr: { "aria-label": t("setting.api.provider.deleteModel") } });
      setIcon(delBtn, "x");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation(); // 别触发整行的「设为当前」
        const arr = models();
        if (arr.length <= 1) {
          new Notice(t("setting.api.provider.leastOneModel"));
          return;
        }
        provider.models = arr.filter((m) => m !== model);
        // 删掉的正好是当前模型 → 当前模型回退到列表第一项
        if (provider.model === model) provider.model = provider.models[0] || "";
        await save();
        renderRows();
        updateHeader();
        ctx.refreshChatView();
      });
    }
    // 添加模型：名称重复或留空不加
    const addRow = listEl.createDiv({ cls: "xyag-api-model-add" });
    const addInput = addRow.createEl("input", {
      cls: "xyag-api-provider-input",
      attr: { placeholder: t("setting.api.provider.modelPlaceholder") },
    });
    const addBtn = addRow.createEl("button", { cls: "xyag-status-btn", text: t("setting.api.provider.addModel") });
    const doAdd = async () => {
      const name = addInput.value.trim();
      if (!name) return;
      const arr = models();
      if (arr.includes(name)) {
        new Notice(t("setting.api.provider.modelExists", name));
        return;
      }
      arr.push(name);
      // 列表里第一个模型自动成为当前模型
      if (!provider.model) provider.model = name;
      addInput.value = "";
      await save();
      renderRows();
      updateHeader();
      ctx.refreshChatView();
    };
    addBtn.addEventListener("click", () => void doAdd());
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doAdd();
      }
    });
    // 在线获取：拉 provider 的 /models 清单，弹出列表点选添加（可连选多个）
    const fetchBtn = addRow.createEl("button", { cls: "xyag-status-btn", text: t("setting.api.provider.fetchModels") });
    fetchBtn.addEventListener("click", async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = t("status.checking");
      const remote = await fetchProviderModels(provider);
      fetchBtn.disabled = false;
      fetchBtn.textContent = t("setting.api.provider.fetchModels");
      if (!remote) {
        new Notice(t("setting.api.provider.fetchFailed"));
        return;
      }
      // 过滤掉已添加的，剩下的才值得展示
      const candidates = remote.filter((m) => !models().includes(m));
      if (candidates.length === 0) {
        new Notice(t("setting.api.provider.fetchEmpty"));
        return;
      }
      showPopup(
        fetchBtn,
        (popup) => {
          for (const m of candidates) {
            addPopupItem(popup, m, false, () => {
              models().push(m);
              if (!provider.model) provider.model = m;
              void save().then(() => {
                renderRows();
                updateHeader();
                ctx.refreshChatView();
              });
            });
          }
        },
        { direction: "auto", maxHeight: "50vh", matchWidth: false, minWidth: 220 },
      );
    });
  };
  renderRows();
}

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
    buildModelListEditor(ctx, content, provider, updateHeader);
  }

  const addBtn = container.createDiv({ cls: "xyag-settings-status-actions" });
  const newBtn = addBtn.createEl("button", { cls: "xyag-status-btn", text: t("setting.api.provider.new") });
  newBtn.addEventListener("click", async () => {
    s.apiProviders.push({
      id: `provider_${Date.now()}`,
      name: t("api.provider.newName"),
      baseUrl: "",
      model: "",
      models: [],
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

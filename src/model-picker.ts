import { t } from "./i18n";
import { addPopupItem, addPopupSection, closePopup, showPopup } from "./popup";
import { getActiveProvider } from "./constants";
import type { XiaoyuanAgentSettings } from "./types";

export interface ModelPickerOptions {
  /** 写入设置后落盘。 */
  persist: () => void | Promise<void>;
  /** 弹层展开方向偏好；空间不够会自动翻面。 */
  direction?: "down" | "up" | "auto";
  /** 额外渲染 API 通道分组（聊天界面用；设置面板只有 OpenCode）。 */
  withApiSection?: boolean;
  /** 模型列表为空时自动同步。 */
  autoSync?: () => void | Promise<void>;
  /** 弹层里的「同步模型列表」项；不传则不显示。 */
  onRefresh?: () => void;
  /** 选中 OpenCode 模型后回调（此时 settings.opencode.model 已写入）。 */
  onSelect?: (modelId: string) => void;
  /** 选中 API provider 后回调（此时 settings.activeApiProviderId 已写入）。 */
  onSelectApi?: (label: string) => void;
  /** 弹层宽度跟随触发器。 */
  matchWidth?: boolean;
  /** 弹层最小宽度（px）。 */
  minWidth?: number;
  /** 展开 / 关闭回调（供下拉框同步箭头与 aria 状态）。 */
  onToggle?: (open: boolean) => void;
}

interface ModelItem {
  label: string;
  value: string;
}

/** 模型 id 的短名（`provider/model` → `model`）。 */
export function shortModelName(modelId: string): string {
  return modelId.split("/").pop() || modelId;
}

/** 按 provider 分组，`opencode` 排最前。 */
function groupByProvider(models: ModelItem[]): [string, ModelItem[]][] {
  const groups = new Map<string, ModelItem[]>();
  for (const m of models) {
    const provider = m.value.includes("/") ? m.value.split("/")[0] : t("model.otherProvider");
    const list = groups.get(provider);
    if (list) list.push(m);
    else groups.set(provider, [m]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === "opencode") return -1;
    if (b === "opencode") return 1;
    return a.localeCompare(b);
  });
}

/**
 * 模型列表内容：按 provider 分组折叠，末尾是「同步模型列表」。
 * 设置面板的下拉框与聊天工具栏共用这一份内容。
 */
export function buildModelList(
  popup: HTMLElement,
  settings: XiaoyuanAgentSettings,
  options: ModelPickerOptions,
): void {
  const body = options.withApiSection ? addPopupSection(popup, t("mode.cli")) : popup;

  const renderGroups = (): void => {
    const models = settings.opencodeModels || [];
    if (models.length === 0) {
      body.createDiv({ cls: "xyag-popup-item" }).createSpan({ cls: "xyag-popup-label" }).textContent = t("notice.noModels");
      return;
    }
    for (const [provider, items] of groupByProvider(models)) {
      body.createDiv({ cls: "xyag-popup-separator" });
      // 分组默认收起（只看 provider 名，点开才展开模型），展开时会自动重排
      const children = addPopupSection(body, provider, { collapsed: true });
      for (const m of items) {
        addPopupItem(
          children,
          m.label,
          m.value === settings.opencode.model,
          () => {
            settings.opencode.model = m.value;
            options.persist();
            options.onSelect?.(m.value);
          },
          "option",
        );
      }
    }
  };

  const renderRefresh = (): void => {
    if (!options.onRefresh) return;
    body.createDiv({ cls: "xyag-popup-separator" });
    const item = body.createDiv({ cls: "xyag-popup-item" });
    item.createSpan({ cls: "xyag-popup-label" }).textContent = t("modelPicker.syncModels");
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closePopup(popup);
      options.onRefresh?.();
    });
  };

  const renderAll = (): void => {
    renderGroups();
    renderRefresh();
    // 内容变了高度也得跟着变，重新贴一次触发器
    popup.dispatchEvent(new CustomEvent("xyag-popup-relayout"));
  };

  void (async () => {
    if ((settings.opencodeModels || []).length === 0 && options.autoSync) {
      body.createDiv({ cls: "xyag-popup-item" }).createSpan({ cls: "xyag-popup-label" }).textContent = t("status.checking");
      try {
        await options.autoSync();
      } catch {
        // 同步失败就按当前列表展示，错误提示由 autoSync 自己负责。
      }
      body.empty();
    }
    renderAll();
  })();

  if (options.withApiSection) {
    const apiBody = addPopupSection(popup, t("mode.api"));
    const active = getActiveProvider(settings);
    let hasItem = false;
    for (const p of settings.apiProviders) {
      if (!p.model) continue;
      hasItem = true;
      const label = p.name ? `${p.name}: ${p.model}` : p.model;
      addPopupItem(apiBody, label, p.id === active?.id, () => {
        settings.activeApiProviderId = p.id;
        options.persist();
        options.onSelectApi?.(label);
      });
    }
    if (!hasItem) {
      apiBody.createDiv({ cls: "xyag-popup-item" }).createSpan({ cls: "xyag-popup-label" }).textContent = t(
        "status.notConfigured",
      );
    }
  }
}

/**
 * 「选择模型」弹层：聊天工具栏与设置面板共用同一实现。
 * 两个入口读写同一份 `settings.opencode.model` / `settings.opencodeModels`，天然同步。
 */
export function attachModelPicker(
  trigger: HTMLElement,
  settings: XiaoyuanAgentSettings,
  options: ModelPickerOptions,
): void {
  const popup = showPopup(
    trigger,
    (popup) => {
      buildModelList(popup, settings, options);
    },
    {
      direction: options.direction ?? "auto",
      maxHeight: "50vh",
      matchWidth: options.matchWidth,
      minWidth: options.minWidth,
      onClose: () => options.onToggle?.(false),
    },
  );
  if (popup) options.onToggle?.(true);
}

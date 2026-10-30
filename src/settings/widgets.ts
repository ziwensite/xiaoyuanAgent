import { App, Modal, Setting, setIcon } from "obsidian";
import { DEFAULT_OPENCODE_PORT } from "../constants";
import { t } from "../i18n";

/**
 * 设置项的通用控件。
 *
 * 从 `settings/index.ts` 抽出来给各标签页复用：之前「卡片头」和
 * 「label + input/textarea + change 保存」这两段在多个标签页里各写了一遍，
 * 改一处漏两处。
 */

/**
 * 通用确认弹窗。
 * `window.confirm` / `window.prompt` 在 Obsidian 的 Electron 环境里不可靠
 * （TopicTitleModal 就是为了绕开 `window.prompt` 才写的），这里同样绕开 `confirm`。
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private message: string,
    private onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("xyag-modal");
    contentEl.createEl("h3", { text: this.message });
    const row = contentEl.createDiv({ cls: "xyag-modal-buttons" });
    const cancel = row.createEl("button", { text: t("common.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = row.createEl("button", { cls: "mod-cta", text: t("common.confirm") });
    ok.addEventListener("click", () => {
      void Promise.resolve(this.onConfirm()).catch(() => undefined);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 把用户输入的端口收敛到合法范围，非法值回退到 OpenCode 默认端口 */
export function clampPort(raw: string, fallback = DEFAULT_OPENCODE_PORT): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(65535, Math.max(1, Math.trunc(n)));
}

/** 给设置项名字前面加一个图标 */
export function decorateSetting(setting: Setting, iconName: string): Setting {
  const nameEl = setting.nameEl;
  if (!nameEl) return setting;
  const settingEl = setting.settingEl;
  settingEl?.addClass("xyag-setting-with-icon");
  nameEl.addClass("xyag-setting-name-with-icon");
  const icon = document.createElement("span");
  icon.addClass("xyag-setting-icon");
  setIcon(icon, iconName);
  nameEl.prepend(icon);
  return setting;
}

/** 状态卡里的一行（图标 + 标签 + 值） */
export function addStatusRow(container: HTMLElement, iconName: string, label: string, value: string): void {
  const row = container.createDiv({ cls: "xyag-settings-status-row" });
  const icon = row.createSpan({ cls: "xyag-settings-status-icon" });
  setIcon(icon, iconName);
  row.createSpan({ cls: "xyag-settings-status-label", text: label });
  row.createSpan({ cls: "xyag-settings-status-value", text: value });
}

/**
 * 按行号改状态卡某行的值。
 *
 * 靠下标定位比较脆（加一行就错位），所以调用点必须与 `buildStatusCard`
 * 的行顺序保持一致 —— 顺序定义见 `status-card.ts`。
 */
export function updateRow(card: HTMLElement, index: number, value: string): void {
  const rows = card.querySelectorAll(".xyag-settings-status-row");
  if (rows[index]) {
    const valEl = rows[index].querySelector(".xyag-settings-status-value") as HTMLSpanElement;
    if (valEl) valEl.textContent = value;
  }
}

/**
 * 可折叠卡片：点卡片头展开 / 收起内容区，点头上的按钮不触发折叠。
 * 默认收起 —— 这类卡片动辄十几个输入框，全展开列表会长得离谱。
 */
export function makeCollapsibleCard(head: HTMLElement, card: HTMLElement): HTMLElement {
  const content = card.createDiv({ cls: "xyag-api-provider-content" });
  content.style.display = "none";
  head.style.cursor = "pointer";
  head.addEventListener("click", (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest("button")) return;
    content.style.display = content.style.display === "none" ? "" : "none";
  });
  return content;
}

/** 「标签 + 输入框」的一行，change 时保存 */
export function addFieldText(
  container: HTMLElement,
  label: string,
  value: string,
  placeholder: string,
  onChange: (val: string) => Promise<void>,
  password = false,
): void {
  const field = container.createDiv({ cls: "xyag-api-provider-field" });
  field.createSpan({ cls: "xyag-api-provider-label", text: label });
  const input = field.createEl("input", { cls: "xyag-api-provider-input", attr: { placeholder } });
  input.value = value;
  if (password) input.type = "password";
  input.addEventListener("change", () => {
    void onChange(input.value);
  });
}

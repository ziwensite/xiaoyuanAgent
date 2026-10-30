import type { SettingsCtx } from "./context";
import manifest from "../../manifest.json";
import { t } from "../i18n";
import { setIcon } from "obsidian";

export function buildAboutTab(ctx: SettingsCtx, container: HTMLElement) {
  const card = container.createDiv({ cls: "xyag-settings-status" });

  const titleRow = card.createDiv({ cls: "xyag-settings-status-row" });
  const iconSpan = titleRow.createSpan({ cls: "xyag-settings-status-icon" });
setIcon(iconSpan, "sparkles");
  titleRow.createSpan({ cls: "xyag-settings-status-label", text: manifest.name || t("about.title") });
  titleRow.createSpan({ cls: "xyag-settings-status-value", text: `v${manifest.version}` });

  const descRow = card.createDiv({ cls: "xyag-settings-status-row" });
  const descIcon = descRow.createSpan({ cls: "xyag-settings-status-icon" });
setIcon(descIcon, "file-text");
  descRow.createSpan({ cls: "xyag-settings-status-label", text: t("about.desc") });
  descRow.createSpan({ cls: "xyag-settings-status-value", text: t("about.desc.text") });

  const authorRow = card.createDiv({ cls: "xyag-settings-status-row" });
  const authorIcon = authorRow.createSpan({ cls: "xyag-settings-status-icon" });
setIcon(authorIcon, "user");
  authorRow.createSpan({ cls: "xyag-settings-status-label", text: t("about.author") });
  authorRow.createSpan({ cls: "xyag-settings-status-value", text: manifest.author || "XiaoYuan" });

  const licenseRow = card.createDiv({ cls: "xyag-settings-status-row" });
  const licIcon = licenseRow.createSpan({ cls: "xyag-settings-status-icon" });
setIcon(licIcon, "scale");
  licenseRow.createSpan({ cls: "xyag-settings-status-label", text: t("about.license") });
  licenseRow.createSpan({ cls: "xyag-settings-status-value", text: "MIT" });

  const depRow = card.createDiv({ cls: "xyag-settings-status-row" });
  const depIcon = depRow.createSpan({ cls: "xyag-settings-status-icon" });
setIcon(depIcon, "package");
  depRow.createSpan({ cls: "xyag-settings-status-label", text: t("about.dep") });
  depRow.createSpan({ cls: "xyag-settings-status-value", text: "opencode CLI" });

  container.createEl("hr");
  container.createEl("p", { cls: "xyag-settings-desc", text: t("about.tech") });
}

/** 拉取 OpenCode 模型与 agent 列表：设置面板的 ↻ 与弹层里的「同步模型列表」共用。 */

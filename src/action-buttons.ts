import { setIcon, setTooltip } from "obsidian";
import { t } from "./i18n";

// `as const` 很关键：否则 `keyof typeof LABEL_KEYS` 退化成 `string`，
// 写错一个按钮名（如 `aiTool`）不会报错，只会静默变成 undefined 图标。
const LABEL_KEYS = {
  copy: "btn.copy",
  speak: "btn.speak",
  quote: "btn.quote",
  edit: "btn.edit",
  undo: "btn.undo",
  replace: "btn.replace",
  rename: "btn.rename",
  open: "btn.open",
  delete: "btn.delete",
  aiTools: "btn.aiTools",
  capture: "btn.capture",
} as const;

export type ActionType = keyof typeof LABEL_KEYS;

const ICON_MAP: Record<ActionType, string> = {
  copy: "copy",
  speak: "volume-2",
  quote: "quote",
  edit: "notebook-pen",
  undo: "undo",
  replace: "replace",
  rename: "folder-pen",
  open: "notebook-pen",
  delete: "trash-2",
  aiTools: "sparkles",
  capture: "camera",
};

export function createActionBtn(type: ActionType): HTMLSpanElement {
  const btn = document.createElement("span");
  btn.className = "xyag-msg-action";
  setIcon(btn, ICON_MAP[type]);
  setTooltip(btn, t(LABEL_KEYS[type]));
  return btn;
}

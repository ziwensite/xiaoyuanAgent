import { t } from "./i18n";
import type { ReasoningEffort, ReasoningEffortAPI } from "./types";

/** 思考模式的 UI 预设键（与 locale 中的 `setting.reasoning.*` 对应）。 */
export type ReasoningPreset = "quick" | "try" | "expert" | "xhigh";

export interface ReasoningOption<V extends string> {
  /** UI 预设键 */
  preset: ReasoningPreset;
  /** 实际写入设置、传给模型的值 */
  value: V;
}

/**
 * CLI（OpenCode）的 4 档预设。
 * `xhigh` 只有 CLI 通道支持，API 兼容接口传了可能 400。
 */
export const CLI_REASONING_OPTIONS: ReasoningOption<ReasoningEffort>[] = [
  { preset: "quick", value: "none" },
  { preset: "try", value: "low" },
  { preset: "expert", value: "high" },
  { preset: "xhigh", value: "xhigh" },
];

/** API（OpenAI 兼容）的 3 档预设。 */
export const API_REASONING_OPTIONS: ReasoningOption<ReasoningEffortAPI>[] = [
  { preset: "quick", value: "none" },
  { preset: "try", value: "low" },
  { preset: "expert", value: "high" },
];

/** 预设的显示名（快速回答 / 尝试思考 / 专家模式 / 极限模式）。 */
export function reasoningPresetLabel(preset: ReasoningPreset): string {
  return t(`setting.reasoning.${preset}`);
}

/**
 * 已存储的旧值 → UI 预设。
 * 老版本有 minimal/medium 这类细分档位，统一折叠到最接近的预设，
 * 这样下拉里不会出现「尝试思考」重复两次。
 */
export function toReasoningPreset(v: ReasoningEffort | ReasoningEffortAPI): ReasoningPreset {
  if (v === "none") return "quick";
  if (v === "minimal" || v === "low") return "try";
  if (v === "medium" || v === "high") return "expert";
  if (v === "xhigh") return "xhigh";
  return "try";
}

/** 已存储值 → 显示名。 */
export function reasoningValueLabel(v: ReasoningEffort | ReasoningEffortAPI): string {
  return reasoningPresetLabel(toReasoningPreset(v));
}

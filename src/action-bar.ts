import { Notice } from "obsidian";
import { t } from "./i18n";
import { createActionBtn } from "./action-buttons";
import { formatClock } from "./utils";

export interface ActionBarOptions {
  /** 时间戳前缀里显示的 Agent 名（当前前台回答者），而不是通道代号 CLI/API */
  modeLabel: string;
  undoMessage: (id: string) => void;
  openInEditor: (content: string, timestamp?: number) => void;
  quote: (text: string) => void;
  onSpeak: (text: string) => void;
  onAITools: (content: string, e: MouseEvent) => void;
  onCapture: (text: string) => void;
}

export function buildActionBar(
  msgEl: HTMLElement,
  role: string,
  content: string,
  timestamp: number | undefined,
  options: ActionBarOptions,
): void {
  const actionsEl = msgEl.createDiv({ cls: "xyag-msg-actions" });
  const isUser = role === "user";

  const add = (type: Parameters<typeof createActionBtn>[0], handler: (e: MouseEvent) => void) => {
    const btn = createActionBtn(type);
    btn.addEventListener("click", handler);
    actionsEl.appendChild(btn);
  };

  add("copy", () => {
    // 助手消息优先复制用户选中的片段
    const selected = isUser ? "" : window.getSelection()?.toString().trim();
    navigator.clipboard.writeText(selected || content);
    new Notice(t("chat.copied"));
  });
  add("speak", () => options.onSpeak(content));
  add("quote", () => options.quote(content));

  if (isUser) {
    add("undo", () => options.undoMessage(msgEl.id));
  } else {
    add("edit", () => options.openInEditor(content, timestamp));
  }

  add("capture", () => options.onCapture(content));
  add("aiTools", (e) => options.onAITools(content, e));

  if (timestamp) {
    actionsEl.createSpan({ cls: "xyag-msg-time", text: `${options.modeLabel} · ${formatClock(timestamp)}` });
  }
}

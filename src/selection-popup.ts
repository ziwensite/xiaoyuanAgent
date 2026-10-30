import { Notice } from "obsidian";
import { t } from "./i18n";
import { createActionBtn } from "./action-buttons";

export interface SelectionPopupConfig {
  onQuote: (text: string) => void;
  onSpeak: (text: string) => void;
  onAITools: (text: string, e: MouseEvent) => void;
  onCapture: (text: string) => void;
}

/**
 * 在容器内监听划选并弹出操作条。
 *
 * 返回注销函数：**必须**在容器销毁时调用。以前这里往 document 上挂了监听却
 * 从不移除，每开一次会话视图 / 每开一次润色弹窗就泄漏一个闭包（还长期持有
 * 已经销毁的 DOM 子树）。
 */
export function registerSelectionListener(container: HTMLElement, config: SelectionPopupConfig): () => void {
  const doc = container.ownerDocument;
  const onMouseUp = () => {
    setTimeout(() => {
      const sel = doc.getSelection();
      if (!sel || sel.rangeCount === 0 || !container.contains(sel.anchorNode)) {
        removeSelectionPopup(doc);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        removeSelectionPopup(doc);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      showSelectionPopup(text, rect.left + rect.width / 2 - 60, rect.top - 36, config, doc);
    }, 10);
  };
  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || !target.closest(".xyag-selection-popup")) removeSelectionPopup(doc);
  };
  container.addEventListener("mouseup", onMouseUp);
  doc.addEventListener("mousedown", onMouseDown);
  return () => {
    container.removeEventListener("mouseup", onMouseUp);
    doc.removeEventListener("mousedown", onMouseDown);
    removeSelectionPopup(doc);
  };
}

function removeSelectionPopup(doc: Document): void {
  doc.querySelectorAll(".xyag-selection-popup").forEach((el) => el.remove());
}

export function showSelectionPopup(
  text: string,
  x: number,
  y: number,
  config: SelectionPopupConfig,
  ownerDoc: Document = document,
): void {
  removeSelectionPopup(ownerDoc);
  // 用宿主 document 而不是全局 document：设置面板/聊天面板可能在弹出窗口里，
  // 挂到主窗口 body 上就表现为「划选没反应」。
  const popup = ownerDoc.body.createDiv({ cls: "xyag-selection-popup" });

  const buttons: [Parameters<typeof createActionBtn>[0], () => void][] = [
    ["copy", () => {
      // 复制可能失败（无剪贴板权限 / 非安全上下文），失败要有提示而不是静默
      navigator.clipboard.writeText(text).then(
        () => new Notice(t("chat.copied")),
        () => new Notice(t("chat.copyFailed")),
      );
    }],
    ["speak", () => config.onSpeak(text)],
    ["quote", () => config.onQuote(text)],
    ["capture", () => config.onCapture(text)],
  ];

  for (const [type, handler] of buttons) {
    const btn = createActionBtn(type);
    btn.addEventListener("click", () => {
      handler();
      removeSelectionPopup(ownerDoc);
    });
    popup.appendChild(btn);
  }

  const aiBtn = createActionBtn("aiTools");
  aiBtn.addEventListener("click", (e) => {
    config.onAITools(text, e);
    removeSelectionPopup(ownerDoc);
  });
  popup.appendChild(aiBtn);

  // 收敛到视口内：靠边划选时弹层会溢出屏幕
  const win = ownerDoc.defaultView ?? window;
  const margin = 8;
  const width = 220;
  const height = 40;
  const left = Math.min(Math.max(x, margin), Math.max(margin, win.innerWidth - width - margin));
  const top = Math.min(Math.max(y, margin), Math.max(margin, win.innerHeight - height - margin));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

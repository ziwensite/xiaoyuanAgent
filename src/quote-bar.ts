import { t } from "./i18n";

export interface QuoteBarState {
  quoteText: string;
  attachments: { name: string; type: string; data?: string; size: number }[];
}

export function renderQuoteBar(
  attachPreviewEl: HTMLElement,
  state: QuoteBarState,
  onRemoveQuote: () => void,
  onRemoveAttachment: (index: number) => void,
): void {
  attachPreviewEl.empty();
  const hasQuote = !!state.quoteText;
  const hasAttach = state.attachments.length > 0;
  // 一次性定好显隐，别在循环里反复赋值
  attachPreviewEl.style.display = hasQuote || hasAttach ? "flex" : "none";

  /** 图片 / 非图片两条分支原来逐行重复构造 chip，只有内容不同 */
  const addChip = (fill: (chip: HTMLElement) => void, onRemove: () => void) => {
    const chip = attachPreviewEl.createDiv({ cls: "xyag-attach-chip" });
    fill(chip);
    const removeBtn = chip.createSpan({ text: " ×" });
    removeBtn.style.cursor = "pointer";
    removeBtn.addEventListener("click", onRemove);
  };

  if (hasQuote) {
    addChip((chip) => {
      chip.addClass("xyag-quote-chip");
      chip.textContent =
        t("quote.label") + (state.quoteText.length > 50 ? state.quoteText.slice(0, 50) + "..." : state.quoteText);
    }, onRemoveQuote);
  }

  for (let i = 0; i < state.attachments.length; i++) {
    const att = state.attachments[i];
    if (att.type.startsWith("image/") && att.data) {
      addChip((chip) => {
        const img = chip.createEl("img", { attr: { src: att.data || "" } });
        img.style.cssText = "max-height:48px;max-width:48px;border-radius:4px;object-fit:cover;";
        const label = chip.createSpan({ text: " " + att.name });
        label.style.cssText =
          "font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;";
      }, () => onRemoveAttachment(i));
    } else {
      addChip((chip) => {
        chip.textContent = att.name.length > 20 ? att.name.slice(0, 17) + "..." : att.name;
      }, () => onRemoveAttachment(i));
    }
  }
}

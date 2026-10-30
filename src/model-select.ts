import { setIcon, setTooltip } from "obsidian";

export interface SelectTriggerOptions {
  /** 控件上显示的文本。 */
  text: string;
  /** 悬浮提示（一般是完整模型 id）。 */
  tooltip?: string;
  /** 无障碍标签。 */
  ariaLabel?: string;
  /** 点击展开。 */
  onOpen: (trigger: HTMLElement) => void;
}

export interface SelectTrigger {
  el: HTMLElement;
  /** 更新显示文本。 */
  setText(text: string): void;
  /** 更新悬浮提示。 */
  setTooltip(text: string): void;
  /** 同步展开态（箭头方向 + aria-expanded）。 */
  setOpen(open: boolean): void;
}

/**
 * 自绘的「下拉框」触发器。
 *
 * 不用原生 <select>：原生下拉的选项列表由操作系统渲染，既没法跟随主题，
 * 也没法保证贴着控件展开。这里只负责外观与键盘，列表内容由调用方提供。
 */
export function createSelectTrigger(options: SelectTriggerOptions): SelectTrigger {
  const el = document.createElement("div");
  el.className = "xyag-select";
  el.setAttribute("role", "combobox");
  el.setAttribute("aria-haspopup", "listbox");
  el.setAttribute("aria-expanded", "false");
  el.setAttribute("tabindex", "0");
  if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel);

  const value = el.createSpan({ cls: "xyag-select-value" });
  value.textContent = options.text;

  const chevron = el.createSpan({ cls: "xyag-select-chevron" });
  setIcon(chevron, "chevron-down");

  if (options.tooltip) setTooltip(el, options.tooltip);

  let open = false;

  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // 展开状态下再点一次 = 收起。开关逻辑统一交给弹层（同一个触发器再点就关），
    // 这里不要提前拦掉，否则列表永远关不掉。
    options.onOpen(el);
  });

  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    // 已展开时把方向键/回车交给列表导航
    if (open) return;
    options.onOpen(el);
  });

  return {
    el,
    setText(text: string): void {
      value.textContent = text;
    },
    setTooltip(text: string): void {
      setTooltip(el, text);
    },
    setOpen(next: boolean): void {
      open = next;
      el.classList.toggle("is-open", next);
      el.setAttribute("aria-expanded", next ? "true" : "false");
    },
  };
}

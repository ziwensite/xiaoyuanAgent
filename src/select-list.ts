import { addPopupItem, showPopup } from "./popup";
import { createSelectTrigger } from "./model-select";

/** 下拉框的一项。 */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldOptions {
  /** 选项列表。 */
  options: SelectOption[];
  /** 当前值。 */
  value?: string;
  /** 触发器上显示的文本；不给就取当前值的 label。 */
  text?: string;
  /** 悬浮提示。 */
  tooltip?: string;
  /** 无障碍标签。 */
  ariaLabel?: string;
  /** 选中后回调。 */
  onSelect: (value: string) => void;
  /** 弹层最小宽度（px）。 */
  minWidth?: number;
  /** 弹层宽度跟随触发器。 */
  matchWidth?: boolean;
}

export interface SelectField {
  el: HTMLElement;
  /** 同步当前值（触发器文字跟着变）。 */
  setValue(value: string): void;
  /** 换掉整份选项。 */
  setOptions(options: SelectOption[], value?: string): void;
}

/**
 * 通用的自绘下拉框（触发器 + 选项弹层）。
 *
 * 不用 Obsidian 的 `DropdownComponent`：它底层是原生 `<select>`，
 * 选项列表由操作系统单独开一个窗口渲染，既不受主题控制，
 * 也完全不受设置弹窗的边界约束 —— 列表会直接飘到设置窗口外面去。
 *
 * 这里列表由插件自己画，挂在 body 上并按「所在弹窗」的范围收边，
 * 因此无论在设置面板还是聊天界面，都只会贴在控件旁边。
 */
export function createSelectField(options: SelectFieldOptions): SelectField {
  let items = options.options;
  let value = options.value ?? "";

  const labelOf = (v: string): string => items.find((o) => o.value === v)?.label ?? v;

  const trigger = createSelectTrigger({
    text: options.text ?? labelOf(value),
    tooltip: options.tooltip,
    ariaLabel: options.ariaLabel,
    onOpen: (el) => {
      const popup = showPopup(
        el,
        (popup) => {
          for (const opt of items) {
            addPopupItem(
              popup,
              opt.label,
              opt.value === value,
              () => {
                value = opt.value;
                trigger.setText(labelOf(value));
                options.onSelect(value);
              },
              "option",
            );
          }
        },
        {
          direction: "auto",
          maxHeight: "50vh",
          matchWidth: options.matchWidth ?? true,
          minWidth: options.minWidth,
          onClose: () => trigger.setOpen(false),
        },
      );
      if (popup) trigger.setOpen(true);
    },
  });

  return {
    el: trigger.el,
    setValue(next: string): void {
      value = next;
      trigger.setText(labelOf(next));
    },
    setOptions(next: SelectOption[], nextValue?: string): void {
      items = next;
      if (nextValue !== undefined) value = nextValue;
      trigger.setText(labelOf(value));
    },
  };
}

import { dumpPopupGeometry } from "./debug-log";

export interface PopupOptions {
  /** 弹层最大高度（CSS 值，如 "50vh"）；实际还会被可用空间二次收紧。 */
  maxHeight?: string;
  /**
   * 展开方向偏好。
   * - "auto"：下方放得下就向下（和系统下拉框一致），放不下看上方，
   *   两边都放不下就取宽敞的一侧、列表内部滚动；
   * - "down" / "up"：优先该侧，首选侧放不下且另一侧更宽裕时自动翻面。
   */
  direction?: "down" | "up" | "auto";
  /** 弹层宽度跟随触发器（最小不窄于触发器）。 */
  matchWidth?: boolean;
  /** 最小宽度（px）。 */
  minWidth?: number;
  /** 贴住触发器所在的聊天容器宽度（会话菜单用）。 */
  fullWidth?: boolean;
  /** 弹层关闭时回调。 */
  onClose?: () => void;
}

/** 弹层不贴屏幕边。 */
const VIEWPORT_MARGIN = 8;
/** 弹层与触发器之间的缝隙。 */
const TRIGGER_GAP = 2;
/** 再挤也要给列表留的高度。 */
const MIN_POPUP_HEIGHT = 120;
/** 弹层与所在弹窗（modal）边缘的间距。 */
const MODAL_INSET = 4;

/**
 * 元素所在的 document / window。
 *
 * Obsidian 的弹出窗口（popout）是**另一份 document**，而插件代码里的全局
 * `document` / `window` 永远指向主窗口。设置面板开在弹出窗口里时，
 * 往主 document 上挂 pointerdown / scroll / keydown 根本收不到那边的点击 ——
 * 于是「点外面关不掉」「滚动后弹层不跟」。所以一律按元素自己的 document 取。
 */
function docOf(el: Element): Document {
  return el.ownerDocument;
}
function winOf(el: Element): Window {
  return el.ownerDocument.defaultView ?? window;
}
function styleOf(el: Element): CSSStyleDeclaration {
  return winOf(el).getComputedStyle(el);
}

let activePopup: HTMLElement | null = null;
/**
 * 每个弹层自己挂过的全局监听，关闭时只注销自己那份。
 *
 * 之前这些监听放在一个全局数组里，谁关闭都顺手把全家的清了 ——
 * 设置窗口关掉时弹层会被 DOM 带走（节点没了但监听还在），
 * 下一个弹层打开再一关，就把**新弹层**的监听也一起注销了，
 * 于是新弹层「点外面关不掉」。所以监听必须跟着弹层走。
 */
const popupCleanups = new WeakMap<HTMLElement, Array<() => void>>();
/** 已经关过的弹层，防止 onClose 重复触发。 */
const closedPopups = new WeakSet<HTMLElement>();
/** 弹层 ↔ 触发器，用来判断「再点一次同一个触发器」是不是切换。 */
const popupTriggers = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 关闭弹层（统一入口）。
 * 触发器再次点击、点外面、选中条目都走这里，保证 onClose 只回调一次。
 */
export function closePopup(popup?: HTMLElement | null): void {
  const target = popup ?? activePopup;
  if (!target) return;
  if (closedPopups.has(target)) return;
  closedPopups.add(target);

  // 注销**这个**弹层挂过的所有全局监听
  const offs = popupCleanups.get(target);
  if (offs) {
    for (const off of offs) off();
    popupCleanups.delete(target);
  }

  if (activePopup === target) activePopup = null;
  target.remove();
  target.dispatchEvent(new CustomEvent("xyag-popup-closed"));
}

/** 把 "50vh" / "320px" 之类的上限换算成像素。 */
function parseMaxHeight(value: string | undefined, vh: number): number {
  if (!value) return Infinity;
  const v = value.trim();
  const vhMatch = /^([\d.]+)vh$/.exec(v);
  if (vhMatch) return (parseFloat(vhMatch[1]) / 100) * vh;
  const pxMatch = /^([\d.]+)px$/.exec(v);
  if (pxMatch) return parseFloat(pxMatch[1]);
  return Infinity;
}

/** 可见的条目（折叠分组里的要排除）。 */
function visibleItems(popup: HTMLElement): HTMLElement[] {
  return Array.from(popup.querySelectorAll<HTMLElement>(".xyag-popup-item")).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * 弹层允许占据的范围。
 */
interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 最近的、**面板级**的裁剪祖先（滚动容器 / overflow:hidden）。
 *
 * 设置项那一行也常带 overflow:hidden，拿它当边界会把弹层挤成一条缝，
 * 所以只认够大的容器（宽 ≥ 240、高 ≥ 160）—— 设置面板的标签页内容区够大，
 * 单个设置项不够。
 */
function nearestClippingAncestor(trigger: HTMLElement, stopAt: HTMLElement): HTMLElement | null {
  const body = docOf(trigger).body;
  let el = trigger.parentElement;
  while (el && el !== stopAt && el !== body) {
    const cs = styleOf(el);
    const clips =
      cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
    if (clips) {
      const r = el.getBoundingClientRect();
      if (r.width >= 240 && r.height >= 160) return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * 弹层挂在哪儿。
 *
 * - 设置面板（Obsidian 的 modal）：挂进 modal 本身。
 *   modal 是 `position: relative` 且 `overflow: hidden`，
 *   于是**溢出部分会被直接裁掉** —— 「列表飞出设置窗口」在结构上就不可能发生。
 * - 其余场景（聊天界面等）：挂 body，`position: fixed` + 视口坐标。
 *
 * 两种宿主共用同一套坐标算法：算法内部一律用**视口坐标**算，
 * 最后按宿主的原点换算过去，所以外观和手感完全一致。
 */
interface PopupHost {
  el: HTMLElement;
  position: "fixed" | "absolute";
  /** 宿主坐标系原点的视口坐标。 */
  originX: number;
  originY: number;
}

function resolveHost(trigger: HTMLElement): PopupHost {
  const modal = trigger.closest<HTMLElement>(".modal");
  if (modal) {
    // Obsidian 只在 `.modal-container` 里才把 modal 设成 `position: relative`。
    // 弹出窗口（popout modal）里，modal 是 body 的直接子元素，规则不命中 →
    // modal 是 `position: static`，绝对定位的弹层就退回**以视口为参照**：
    // 位置全错（直接盖住选择框），还会飘到设置窗口外面。
    // 补一个 relative —— 普通窗口里本来就是 relative，
    // 对布局也没有影响（relative 不带偏移量时位置不变），只是让它成为包含块。
    if (styleOf(modal).position === "static") modal.style.position = "relative";
    const r = modal.getBoundingClientRect();
    // absolute 的原点是 modal 的 padding box（边框盒 + 边框宽）。
    // Obsidian 的 .modal 是 `overflow: auto` —— 自己能滚，
    // 而绝对定位的子元素是**跟着内容一起滚**的，
    // 所以原点还得减去滚动量，否则弹层会整体偏移一截。
    return {
      el: modal,
      position: "absolute",
      originX: r.left + modal.clientLeft - modal.scrollLeft,
      originY: r.top + modal.clientTop - modal.scrollTop,
    };
  }
  const body = docOf(trigger).body;
  const b = body.getBoundingClientRect();
  return { el: body, position: "fixed", originX: b.left, originY: b.top };
}

/**
 * 弹层的活动范围 = 视口 ∩ 所在弹窗 ∩ 弹窗里的可见滚动区。
 *
 * 设置面板是个 modal：菜单飘到 modal 外面，看着就像「飞出设置界面」，
 * 所以在 modal 里时把范围收到 modal 的盒子里；不在 modal 里就用整个视口。
 *
 * 注意这里只用来**限制高度和左右位置**，纵向永远贴着触发器 ——
 * 一旦把弹层推离触发器，用户就会觉得「没对齐」。
 */
function resolveBounds(trigger: HTMLElement): Bounds {
  const win = winOf(trigger);
  const bounds: Bounds = {
    left: VIEWPORT_MARGIN,
    right: win.innerWidth - VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    bottom: win.innerHeight - VIEWPORT_MARGIN,
  };
  const modal = trigger.closest<HTMLElement>(".modal");
  if (!modal) return bounds;
  const r = modal.getBoundingClientRect();
  // modal 还没布局好（尺寸为 0）就先用视口，别拿一个空盒子当边界
  if (r.width < 80 || r.height < 80) return bounds;
  bounds.left = Math.max(bounds.left, r.left + MODAL_INSET);
  bounds.right = Math.min(bounds.right, r.right - MODAL_INSET);
  bounds.top = Math.max(bounds.top, r.top + MODAL_INSET);
  bounds.bottom = Math.min(bounds.bottom, r.bottom - MODAL_INSET);

  // 弹窗里通常还套一层可滚动区域（设置面板的标签页就是），
  // 再收一层，列表就不会压到弹窗标题栏或跑到面板外。
  // 只认「面板级」的容器 —— 设置项那一行也常带 overflow:hidden，
  // 拿它当边界会把弹层挤成一条缝（筛选在 nearestClippingAncestor 里做）。
  const clip = nearestClippingAncestor(trigger, modal);
  if (clip) {
    const cr = clip.getBoundingClientRect();
    bounds.left = Math.max(bounds.left, cr.left + MODAL_INSET);
    bounds.right = Math.min(bounds.right, cr.right - MODAL_INSET);
    bounds.top = Math.max(bounds.top, cr.top + MODAL_INSET);
    bounds.bottom = Math.min(bounds.bottom, cr.bottom - MODAL_INSET);
  }
  return bounds;
}

/**
 * 把弹层贴到触发器上：紧贴下沿（空间不足则上沿），左边缘对齐，宽度不窄于触发器。
 *
 * 三步：
 * 1. 先量内容的自然高度；
 * 2. 按「可用空间」定方向与高度上限 —— 高度必须**装得下**，
 *    装不下就让它内部滚动，绝不把弹层撑出活动范围；
 * 3. 用触发器的位置直接算出 top —— 弹层永远紧贴触发器，不会被推走。
 */
function positionPopup(popup: HTMLElement, trigger: HTMLElement, options?: PopupOptions): void {
  const rect = trigger.getBoundingClientRect();
  const vh = winOf(trigger).innerHeight;
  const bounds = resolveBounds(trigger);

  // 弹层挂到宿主里：设置面板里挂 modal（溢出被裁掉，出不去），
  // 其余挂 body。算法内部一律用视口坐标，最后按宿主原点换算。
  const host = resolveHost(trigger);
  if (popup.parentElement !== host.el) host.el.appendChild(popup);
  popup.style.position = host.position;
  popup.style.top = "auto";
  popup.style.bottom = "auto";

  // ── 宽度 ──────────────────────────────────────────────────────────
  // 上限取活动范围的宽度（设置面板里就是 modal 的内宽，超出的部分省略号）
  const boundsWidth = Math.max(120, bounds.right - bounds.left);
  popup.style.maxWidth = `${Math.floor(boundsWidth)}px`;

  let minWidth = 0;
  if (options?.matchWidth) minWidth = Math.round(rect.width);
  if (options?.minWidth) minWidth = Math.max(minWidth, options.minWidth);
  if (minWidth > 0) popup.style.minWidth = `${minWidth}px`;

  let left = rect.left;
  let fullWidthApplied = false;
  if (options?.fullWidth) {
    const container = trigger.closest<HTMLElement>(".xyag-chat");
    const cr = container?.getBoundingClientRect();
    if (cr) {
      popup.style.width = `${cr.width}px`;
      popup.style.maxWidth = "none";
      left = cr.left;
      fullWidthApplied = true;
    }
  }

  // ── 高度：先量自然高度，再定方向与上限 ───────────────────────────
  popup.style.maxHeight = "none";
  popup.style.overflowY = "auto";
  const naturalHeight = popup.offsetHeight;

  const capPx = parseMaxHeight(options?.maxHeight, vh);
  const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - TRIGGER_GAP);
  const spaceAbove = Math.max(0, rect.top - TRIGGER_GAP - bounds.top);
  const below = Math.min(spaceBelow, capPx);
  const above = Math.min(spaceAbove, capPx);

  const pref = options?.direction ?? "auto";
  let dir: "down" | "up";
  if (pref === "auto") {
    // 下方放得下就向下（和系统下拉框一致）；放不下看上方；两边都放不下就选宽敞的一边，列表内部滚动
    if (below >= naturalHeight) dir = "down";
    else if (above >= naturalHeight) dir = "up";
    else dir = below >= above ? "down" : "up";
  } else {
    const preferred = pref === "down" ? below : above;
    const other = pref === "down" ? above : below;
    // 首选侧放得下就首选；放不下而另一边更宽裕就翻面
    dir = preferred >= naturalHeight || preferred >= other ? pref : pref === "down" ? "up" : "down";
  }

  // 高度上限 = 可用空间与内容高度里小的那个。
  // 关键：弹层是 border-box（见 styles.css），max-height 就是总高度，
  // 因此这里算出的高度一定装得进可用空间，不会溢出、也就不会被推离触发器。
  const avail = dir === "down" ? spaceBelow : spaceAbove;
  const wanted = Math.min(naturalHeight, Math.max(capPx, MIN_POPUP_HEIGHT));
  const maxHeightPx = Math.max(0, Math.min(avail, wanted));
  popup.style.maxHeight = `${Math.round(maxHeightPx)}px`;

  // ── 水平位置：左边缘对齐触发器，越界整体回收 ─────────────────────
  if (!fullWidthApplied) {
    let popupWidth = popup.offsetWidth;
    // 右边放不下：让右边缘跟触发器对齐（向左展开），
    // 这样既不会顶出活动范围，又仍然盖在控件下方
    if (left + popupWidth > bounds.right) {
      const rightAligned = rect.right - popupWidth;
      left = rightAligned >= bounds.left ? rightAligned : bounds.right - popupWidth;
    }
    // 还是放不下（内容比可用空间还宽，比如展开后的模型名）→ 收窄。
    // 这一步必须有：maxWidth 只是「活动范围的宽度」，
    // 弹层贴在触发器左边时，右边未必还有那么多地方可用。
    if (left + popupWidth > bounds.right) {
      popup.style.maxWidth = `${Math.floor(Math.max(120, bounds.right - left))}px`;
      // min-width 是「至少跟触发器一样宽」的意思，
      // 但宁可窄一点也不能溢出窗口，所以这里放开它。
      popup.style.minWidth = "";
      popupWidth = popup.offsetWidth;
      if (left + popupWidth > bounds.right) left = bounds.right - popupWidth;
    }
    if (left < bounds.left) left = bounds.left;
  }

  // ── 垂直位置：永远紧贴触发器 ────────────────────────────────────
  const height = popup.offsetHeight;
  const top = dir === "down" ? rect.bottom + TRIGGER_GAP : rect.top - TRIGGER_GAP - height;
  // 视口坐标 → 宿主坐标
  popup.style.left = `${Math.round(left - host.originX)}px`;
  popup.style.top = `${Math.round(top - host.originY)}px`;
}

/** 取一个元素的盒子（视口坐标）。 */
function boxOf(el: Element): Record<string, number> {
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left * 100) / 100,
    top: Math.round(r.top * 100) / 100,
    right: Math.round(r.right * 100) / 100,
    bottom: Math.round(r.bottom * 100) / 100,
    width: Math.round(r.width * 100) / 100,
    height: Math.round(r.height * 100) / 100,
  };
}

/** 元素的名字（含 id / class），方便在快照里认出来。 */
function nameOf(el: Element): string {
  const cls = el.className && typeof el.className === "string" ? el.className.trim().replace(/\s+/g, ".") : "";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
}

/** 从触发器一路到 body 的祖先链，带上定位/裁剪相关的关键样式。 */
function ancestorChain(el: HTMLElement): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let cur: HTMLElement | null = el;
  while (cur) {
    const cs = styleOf(cur);
    out.push({
      node: nameOf(cur),
      position: cs.position,
      overflow: `${cs.overflowX}/${cs.overflowY}`,
      contain: cs.contain,
      transform: cs.transform === "none" ? "none" : cs.transform,
      zIndex: cs.zIndex,
      rect: boxOf(cur),
    });
    cur = cur.parentElement;
  }
  return out;
}

/**
 * 弹层几何自检：**只有看着不对时才落盘**。
 *
 * 设置面板里的弹层受弹窗、滚动区、层叠顺序三重约束，光看代码猜不出来；
 * 但正常打开下拉框就写一次文件也不合适 —— 插件目录在同步盘里，
 * 写一次同步一次，天天看到 `xyag-popup-debug.json` 变动很烦。
 * 所以这里先做几项硬性检查（盖住触发器 / 没贴住 / 越界 / 宿主不是定位元素 / 被挡住），
 * 全部通过就什么都不写；真出问题时现场自动留在磁盘上。
 */
function dumpGeometry(popup: HTMLElement, trigger: HTMLElement): void {
  if (!trigger.closest(".modal")) return;
  // 还没定位/异步内容还没画完时不检查：这时候尺寸是 0，必然「没贴着」，
  // 检查一次就会误报一次。
  if (popup.style.visibility === "hidden") return;
  try {
    const pr = popup.getBoundingClientRect();
    const tr = trigger.getBoundingClientRect();
    const bounds = resolveBounds(trigger);
    const host = resolveHost(trigger);
    const doc = docOf(popup);
    const win = winOf(popup);
    const cx = Math.round(pr.left + pr.width / 2);
    const cy = Math.round(pr.top + pr.height / 2);
    // 命中测试：弹层中心点最上面是谁？是弹层（或它的子元素）才说明它露在最前面。
    const hit = doc.elementFromPoint(cx, cy);

    const problems: string[] = [];
    const overlapsTrigger =
      pr.left < tr.right && pr.right > tr.left && pr.top < tr.bottom && pr.bottom > tr.top;
    if (overlapsTrigger) problems.push("盖住了触发器");
    const adjacent =
      Math.abs(pr.top - (tr.bottom + TRIGGER_GAP)) <= 2 ||
      Math.abs(pr.bottom - (tr.top - TRIGGER_GAP)) <= 2;
    if (!adjacent) problems.push("没贴着触发器");
    if (pr.left < bounds.left - 1 || pr.right > bounds.right + 1) problems.push("横向越界");
    if (pr.top < bounds.top - 1 || pr.bottom > bounds.bottom + 1) problems.push("纵向越界");
    const hostEl = popup.parentElement;
    if (hostEl && styleOf(hostEl).position === "static") problems.push("宿主是 static");
    if (hit && !popup.contains(hit)) problems.push(`被 ${nameOf(hit)} 挡住`);
    if (problems.length === 0) return;

    dumpPopupGeometry({
      time: new Date().toISOString(),
      problems,
      inModal: true,
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
      },
      trigger: { node: nameOf(trigger), rect: boxOf(trigger) },
      bounds,
      host: {
        node: hostEl ? nameOf(hostEl) : null,
        position: styleOf(popup).position,
        // 宿主的定位方式 —— 必须是 relative/static 之外的定位，
        // 否则绝对定位的弹层会退回以视口为参照，位置全错。
        hostPosition: hostEl ? styleOf(hostEl).position : null,
        originX: host.originX,
        originY: host.originY,
      },
      popup: {
        rect: boxOf(popup),
        styleLeft: popup.style.left,
        styleTop: popup.style.top,
        maxHeight: popup.style.maxHeight,
        boxSizing: styleOf(popup).boxSizing,
        computedPosition: styleOf(popup).position,
        zIndex: styleOf(popup).zIndex,
        parent: hostEl ? nameOf(hostEl) : null,
      },
      hitTest: hit ? nameOf(hit) : null,
      chain: ancestorChain(trigger),
    });
  } catch (e) {
    console.warn("[xiaoyuanAgent] 弹层几何快照采集失败:", e);
  }
}

/**
 * 通用弹层：贴着触发器展开。
 *
 * 设置面板与聊天界面共用这一套实现：同样的外观、同样的定位规则、同样的关闭逻辑。
 * 内容构建完再定位，避免弹层先落在容器底部再跳过来。
 * `buildContent` 也可以返回 Promise（比如连接列表要先探测）：那样会等画完再显示。
 */
export function showPopup(
  trigger: HTMLElement,
  buildContent: (popup: HTMLDivElement) => void | Promise<void>,
  options?: PopupOptions,
): HTMLDivElement | null {
  // 上一个弹层：还在就切换（同一个触发器 = 再点一次收起来），没了就只清监听
  const stale = activePopup;
  if (stale) {
    const sameTrigger = popupTriggers.get(stale) === trigger;
    const visible = stale.isConnected;
    closePopup(stale);
    if (visible && sameTrigger) return null;
  }
  // DOM 里可能还挂着别的弹层，一并收掉，避免同时出现两个列表
  const found = docOf(trigger).querySelector(".xyag-popup") as HTMLElement | null;
  if (found) closePopup(found);

  // 弹层一创建就放进宿主里（设置面板里是 modal，其余是 body），
  // 这样测量自然高度时用的就是正确的布局上下文。
  const host = resolveHost(trigger);
  const popup = host.el.createDiv({ cls: "xyag-popup" });
  popupTriggers.set(popup, trigger);
  // 这个弹层自己挂的全局监听（关闭时逐条注销）
  const cleanups: Array<() => void> = [];
  popupCleanups.set(popup, cleanups);
  // 定位前先藏起来：此时 top 还没定，否则会按静态位置闪在 body 底部
  popup.style.visibility = "hidden";
  activePopup = popup;

  try {
    const built = buildContent(popup) as unknown;
    if (built && typeof (built as PromiseLike<void>).then === "function") {
      // 异步内容（连接列表要先探测）：先别露出来，画完再定位 + 显示，
      // 免得先闪一个空壳。失败就把空壳收掉，别留个点不掉的东西。
      void (built as PromiseLike<void>).then(
        () => {
          if (!popup.isConnected) return;
          // 内容画完时触发器可能已经被重渲染掉了，那就没有贴的对象了
          if (!trigger.isConnected) {
            closePopup(popup);
            return;
          }
          positionPopup(popup, trigger, options);
          popup.style.visibility = "";
          dumpGeometry(popup, trigger);
        },
        (e) => {
          console.warn("[xiaoyuanAgent] 弹层内容构建失败:", e);
          closePopup(popup);
        },
      );
    } else {
      positionPopup(popup, trigger, options);
      popup.style.visibility = "";
      // 自检留档：几何正常时什么都不写（见 dumpGeometry）
      dumpGeometry(popup, trigger);
    }
  } catch (e) {
    // 同步抛错：别在页面上留一个空壳（还会挡住后面的点击）
    closePopup(popup);
    throw e;
  }

  popup.addEventListener("xyag-popup-closed", () => options?.onClose?.());

  // 点击别冒泡出去：弹层在 modal 里时，冒泡可能被 Obsidian 当成
  // 「点到 modal 外面」而把设置面板一起关掉。
  popup.addEventListener("click", (ev) => ev.stopPropagation());
  popup.addEventListener("mousedown", (ev) => ev.stopPropagation());

  // 重新贴一次。触发器被重建（设置面板重渲染）时弹层没主人了，直接收掉。
  const reposition = (): void => {
    if (!popup.isConnected) return;
    if (!trigger.isConnected) {
      closePopup(popup);
      return;
    }
    positionPopup(popup, trigger, options);
  };
  // 内容尺寸变了才需要顺势自检（正常几何不会写文件）。
  const relayout = (): void => {
    reposition();
    if (popup.isConnected) dumpGeometry(popup, trigger);
  };

  // scroll / resize 会连发几十次，每次都跑一遍完整的 positionPopup（内含
  // 多次「写样式 → 读 offsetWidth/Height」的强制同步布局）会明显掉帧。
  // 合并到下一帧执行。
  let rafId = 0;
  const scheduleReposition = (): void => {
    if (rafId) return;
    rafId = winOf(trigger).requestAnimationFrame(() => {
      rafId = 0;
      reposition();
    });
  };

  // 内容异步刷新后（同步模型列表）、二级菜单展开后，尺寸变了要重新贴一次。
  // 顺手再自检一次 —— 这类「变宽后溢出」正是自检要抓的。
  popup.addEventListener("xyag-popup-relayout", relayout);

  // 监听一律挂在**触发器所在的那个 document/window** 上。
  // 设置面板开在弹出窗口里时，它是另一份 document ——
  // 挂到全局 document 上收不到那边的点击，弹层就「点外面关不掉」。
  const doc = docOf(trigger);
  const win = winOf(trigger);
  const listenerOptions = { capture: true } as const;

  // 点外面就关闭。
  // 用 **捕获阶段** 的 pointerdown：设置面板里不少控件会吞掉冒泡，
  // 挂在冒泡阶段的话点击根本传不上来，弹层就怎么点都关不掉。
  // 点触发器本身不算「点外面」—— 那由 showPopup 的切换逻辑负责。
  const handler = (ev: PointerEvent): void => {
    const target = ev.target as Node | null;
    if (!target) return;
    // 弹层已经被移除（设置窗口关掉了）→ 顺手把监听收干净
    if (!popup.isConnected) {
      closePopup(popup);
      return;
    }
    if (popup.contains(target)) return;
    if (trigger.contains(target)) return;
    closePopup(popup);
  };
  doc.addEventListener("pointerdown", handler, listenerOptions);
  cleanups.push(() => doc.removeEventListener("pointerdown", handler, listenerOptions));

  // 触发器滚动 / 窗口变化时重新贴一次，弹层不能跟着漂走。
  // 用捕获阶段监听 scroll，内层滚动容器（设置面板的标签页）也能收到。
  doc.addEventListener("scroll", scheduleReposition, listenerOptions);
  win.addEventListener("resize", scheduleReposition);
  cleanups.push(() => {
    if (rafId) winOf(trigger).cancelAnimationFrame(rafId);
    doc.removeEventListener("scroll", scheduleReposition, listenerOptions);
    win.removeEventListener("resize", scheduleReposition);
  });

  // 弹层自己变宽变高时（展开模型分组、异步刷新列表）也要重新贴一次。
  // 只在打开时算一次位置是不够的：展开「二级菜单」后内容变宽，
  // 旧的左边缘还留在触发器左边，右边就顶出窗口了。
  // 条目文字是 nowrap（见 .xyag-popup-label），宽度不会被滚动条来回挤，
  // 所以这里的观察不会自己震荡。
  const observerWin = winOf(popup) as Window & { ResizeObserver?: typeof ResizeObserver };
  const Observer = observerWin.ResizeObserver ?? ResizeObserver;
  // relayout 内部会改弹层的 width / maxWidth，而这里又监听尺寸变化 ——
  // 必须加「尺寸真的变了才动」的闸门，否则会形成「改样式 → 回调 → 改样式」的自激循环。
  let lastBox = "";
  const onSelfResize = (): void => {
    const box = `${popup.offsetWidth}x${popup.offsetHeight}`;
    if (box === lastBox) return;
    lastBox = box;
    relayout();
  };
  const observer = new Observer(onSelfResize);
  observer.observe(popup);
  cleanups.push(() => observer.disconnect());

  const keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePopup(popup);
      return;
    }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter") return;
    // 只有焦点在触发器或弹层里时才接管方向键，别抢聊天输入框的打字与滚动
    const focused = doc.activeElement;
    const inScope =
      focused === trigger || popup.contains(focused) || focused === doc.body || focused === null;
    if (!inScope) return;

    const items = visibleItems(popup);
    if (items.length === 0) return;
    const current = items.findIndex((el) => el.classList.contains("is-active"));
    ev.preventDefault();
    // 弹层开着的时候，方向键/回车归列表管，别让触发器再把弹层弹一次
    ev.stopPropagation();

    if (ev.key === "Enter") {
      if (current >= 0) items[current].click();
      return;
    }
    const next =
      ev.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    for (const el of items) el.classList.remove("is-active");
    items[next].classList.add("is-active");
    items[next].scrollIntoView({ block: "nearest" });
  };
  doc.addEventListener("keydown", keyHandler, listenerOptions);
  cleanups.push(() => doc.removeEventListener("keydown", keyHandler, listenerOptions));

  return popup;
}

export function addPopupItem(
  parent: HTMLElement,
  label: string,
  checked: boolean,
  onClick: () => void,
  role?: "option",
): HTMLDivElement {
  const item = parent.createDiv({ cls: "xyag-popup-item" });
  if (role === "option") {
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", checked ? "true" : "false");
  }
  const check = item.createSpan({ cls: "xyag-popup-check" });
  check.textContent = checked ? "✓" : "";
  item.createSpan({ cls: "xyag-popup-label" }).textContent = label;
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    closePopup(item.closest<HTMLElement>(".xyag-popup"));
  });
  return item;
}

/**
 * 弹层里的可折叠分组，返回内容容器。
 * 模型和思考强度都要按通道分两组 —— 两条通道同时在线，
 * 前台 Agent 是谁都不该看不到另一组的配置入口。
 *
 * 传入 `collapsed: true` 就是默认收起（模型列表按 provider 分组时用）：
 * 只有组名、点开才出模型名，列表不会一上来就长得离谱。
 */
export function addPopupSection(
  popup: HTMLElement,
  label: string,
  options?: { collapsed?: boolean },
): HTMLElement {
  const title = popup.createDiv({ cls: "xyag-popup-group-title" });
  const arrow = title.createSpan({ cls: "xyag-popup-arrow" });
  const body = popup.createDiv({ cls: "xyag-popup-group-children" });
  const collapsed = options?.collapsed === true;
  arrow.textContent = collapsed ? "▶" : "▼";
  body.classList.toggle("is-collapsed", collapsed);
  title.createSpan({ cls: "xyag-popup-label" }).textContent = label;
  title.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = arrow.textContent === "▼";
    arrow.textContent = open ? "▶" : "▼";
    body.classList.toggle("is-collapsed", open);
    // 展开 / 收起会改变弹层尺寸（出现更长的模型名 → 变宽），
    // 位置得跟着重算，否则右边会顶出窗口。
    popup.dispatchEvent(new CustomEvent("xyag-popup-relayout"));
  });
  return body;
}

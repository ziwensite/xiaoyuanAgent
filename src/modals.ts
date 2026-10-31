import { App, FuzzySuggestModal, Menu, Modal, Notice, TFolder } from "obsidian";
import { t } from "./i18n";
import type XiaoyuanAgentPlugin from "./main";
import { callAISession, getWorkspaceDir } from "./ai";
import { VIEW_TYPE_XIAOYUAN_AGENT_CHAT } from "./constants";
import { getDefaultAgent } from "./agent-registry";
import type { PromptTemplate, OpenCodePermissionRequest, OpenCodePermissionDecision } from "./types";
import { openInEditor } from "./open-in-editor";
import { createActionBtn } from "./action-buttons";
import { registerSelectionListener } from "./selection-popup";

function makeDraggable(handle: HTMLElement, modalEl: HTMLElement): void {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = modalEl.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    modalEl.style.position = "fixed";
    modalEl.style.top = `${e.clientY - dy}px`;
    modalEl.style.left = `${e.clientX - dx}px`;
    modalEl.style.margin = "0";
    // 模态框可能在弹出窗口里 —— 那份 document/window 才是收得到鼠标事件的那个
    const doc = modalEl.ownerDocument;
    const move = (ev: MouseEvent) => {
      modalEl.style.top = `${ev.clientY - dy}px`;
      modalEl.style.left = `${ev.clientX - dx}px`;
    };
    const up = () => {
      doc.removeEventListener("mousemove", move);
      doc.removeEventListener("mouseup", up);
    };
    doc.addEventListener("mousemove", move);
    doc.addEventListener("mouseup", up);
  });
}

export class TextOperationModal extends Modal {
  plugin: XiaoyuanAgentPlugin;
  activeTplId: string;
  inputText: string;
  contentAreaEl!: HTMLDivElement;
  titleEl!: HTMLHeadingElement;
  thinkingBarEl!: HTMLDivElement;
  /** 划选监听的注销函数：onClose 必须调用，否则每开一次弹窗泄漏一个 document 监听 */
  private disposeSelectionListener: (() => void) | null = null;

  constructor(app: App, plugin: XiaoyuanAgentPlugin, tplId: string, inputText: string) {
    super(app);
    this.plugin = plugin;
    this.activeTplId = tplId;
    this.inputText = inputText;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.classList.add("xyag-modal-container");
    const win = modalEl.ownerDocument.defaultView ?? window;
    modalEl.style.height = Math.round(win.innerHeight * 0.75) + "px";

    const tpl = this.plugin.settings.promptTemplates.find((x) => x.id === this.activeTplId);
    const headerRow = contentEl.createDiv({ cls: "xyag-modal-header" });
    this.titleEl = headerRow.createEl("h3", { text: t("modal.title", tpl?.name || "") });
    const modeLabel = headerRow.createSpan({ cls: "xyag-modal-mode-label" });
    // 显示「这次请求会由谁回答」——用 Agent 名，而不是通道代号
    modeLabel.textContent = getDefaultAgent(this.plugin.settings)?.name || "";
    headerRow.style.cursor = "move";
    makeDraggable(headerRow, modalEl);

    this.thinkingBarEl = contentEl.createDiv({ cls: "xyag-thinking-bar" });
    this.contentAreaEl = contentEl.createDiv({ cls: "xyag-modal-content-area", text: t("modal.contentPlaceholder") });

    const btnRow = contentEl.createDiv({ cls: "xyag-modal-btn-row" });
    const leftGroup = btnRow.createDiv({ cls: "xyag-modal-btn-group" });
    const rightGroup = btnRow.createDiv({ cls: "xyag-modal-btn-group" });

    const replaceBtn = createActionBtn("replace");
    replaceBtn.addEventListener("click", () => {
      const editor = this.plugin.getActiveEditor();
      if (editor) {
        editor.replaceSelection(this.contentAreaEl.textContent || "");
        new Notice(t("action.replaced"));
      } else new Notice(t("notice.noEditor"));
      this.close();
    });
    leftGroup.appendChild(replaceBtn);

    const copyBtn = createActionBtn("copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(this.contentAreaEl.textContent || "").then(
        () => new Notice(t("action.copied")),
        () => new Notice(t("chat.copyFailed")),
      );
    });
    leftGroup.appendChild(copyBtn);

    const openBtn = createActionBtn("edit");
    openBtn.addEventListener("click", () => {
      const content = this.contentAreaEl.textContent || "";
      if (!content.trim()) return;
      openInEditor(content, this.app.vault, this.app.workspace, this.plugin.settings.chatHistoryPath, undefined, "modal");
      this.close();
    });
    leftGroup.appendChild(openBtn);

    const captureBtn = createActionBtn("capture");
    captureBtn.addEventListener("click", () => this.capture(this.contentAreaEl.textContent || ""));
    leftGroup.appendChild(captureBtn);

    const toolsBtn = createActionBtn("aiTools");
    toolsBtn.addEventListener("click", (e) => this.showAIToolsMenu(e));
    leftGroup.appendChild(toolsBtn);

    const closeBtn = rightGroup.createEl("button", { text: t("modal.close"), cls: "xyag-btn-secondary" });
    closeBtn.addEventListener("click", () => this.close());

    if (this.inputText) this.processOperation();
    else this.contentAreaEl.contentEditable = "true";

    this.disposeSelectionListener = registerSelectionListener(this.contentAreaEl, {
      onSpeak: (text) => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.replace(/[#*_`[\]]/g, ""));
        u.lang = "zh-CN";
        speechSynthesis.speak(u);
      },
      onQuote: (text) => this.quoteIntoChat(text),
      onAITools: (text, e) => {
        if (!text.trim()) return;
        this.showTemplateMenu(e, (tpl) => {
          this.titleEl.textContent = t("modal.title", tpl.name);
          this.contentAreaEl.textContent = text;
          this.activeTplId = tpl.id;
          this.inputText = text;
          this.processOperation();
        });
      },
      onCapture: (text) => this.capture(text),
    });
  }

  /** 复制到剪贴板并按设置触发捕获命令。 */
  private capture(text: string): void {
    navigator.clipboard.writeText(text).catch(() => new Notice(t("chat.copyFailed")));
    const cmdId = this.plugin.settings.captureCommandId;
    if (cmdId) this.app.commands.executeCommandById(cmdId);
    new Notice(t("action.captured"));
  }

  /** 把文本引用到聊天面板。 */
  private quoteIntoChat(text: string): void {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_XIAOYUAN_AGENT_CHAT).first();
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (right) {
        right.setViewState({ type: VIEW_TYPE_XIAOYUAN_AGENT_CHAT, active: true });
        leaf = right;
      }
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
    leaf?.view.quote?.(text);
  }

  private showAIToolsMenu(e: MouseEvent): void {
    this.showTemplateMenu(e, (tpl) => this.reprocessWithTpl(tpl));
  }

  private showTemplateMenu(e: MouseEvent, onPick: (tpl: PromptTemplate) => void): void {
    const menu = new Menu();
    for (const tpl of this.plugin.settings.promptTemplates || []) {
      menu.addItem((item) => {
        item.setTitle(`${tpl.name} — ${tpl.description}`);
        item.setIcon(tpl.icon);
        item.onClick(() => onPick(tpl));
      });
    }
    menu.showAtMouseEvent(e);
  }

  private async runWithTpl(tpl: PromptTemplate, text: string): Promise<void> {
    this.thinkingBarEl.classList.add("is-active");
    this.contentAreaEl.contentEditable = "false";
    this.contentAreaEl.textContent = t("chat.connected");
    try {
      const s = this.plugin.settings;
      const agent = getDefaultAgent(s);
      const result = await callAISession({
        prompt: (tpl.prompt || "") + text,
        settings: s,
        vaultDir: getWorkspaceDir(),
        agent,
        // prompt 是模板原文，系统提示词没嵌在里面，得单独注入
        systemPrompt: agent?.systemPrompt,
        onThinking: (text) => {
          this.contentAreaEl.textContent = t("modal.ai.thinking", text);
        },
        onTextUpdate: (text) => {
          this.contentAreaEl.textContent = text;
        },
      });
      this.contentAreaEl.textContent = result;
      this.contentAreaEl.contentEditable = "true";
    } catch (err: unknown) {
      this.contentAreaEl.textContent = t("modal.error", err instanceof Error ? err.message : String(err));
    } finally {
      this.thinkingBarEl.classList.remove("is-active");
    }
  }

  private reprocessWithTpl(tpl: PromptTemplate): void {
    const fullText = this.contentAreaEl.textContent || "";
    if (!fullText.trim()) {
      new Notice(t("modal.contentEmpty"));
      return;
    }
    const sel = window.getSelection();
    const selected =
      sel && sel.rangeCount > 0 && this.contentAreaEl.contains(sel.anchorNode) ? sel.toString().trim() : "";
    this.titleEl.textContent = t("modal.title", tpl.name);
    void this.runWithTpl(tpl, selected || fullText);
  }

  private processOperation(): void {
    const tpl = this.plugin.settings.promptTemplates.find((x) => x.id === this.activeTplId);
    void this.runWithTpl(tpl ?? { id: "", name: "", description: "", prompt: "", icon: "" }, this.inputText);
  }

  onClose(): void {
    this.disposeSelectionListener?.();
    this.disposeSelectionListener = null;
    this.contentEl.empty();
  }
}

/** 输入话题标题的轻量弹窗（`window.prompt` 在 Electron 里不可用）。 */
export class TopicTitleModal extends Modal {
  private onSubmit: (title: string) => void;
  private initialTitle: string;
  private heading: string;

  constructor(app: App, onSubmit: (title: string) => void, opts?: { initialTitle?: string; heading?: string }) {
    super(app);
    this.onSubmit = onSubmit;
    this.initialTitle = opts?.initialTitle ?? "";
    this.heading = opts?.heading ?? t("chat.topic.new");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.heading });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "xyag-topic-input",
      attr: { placeholder: t("chat.topic.placeholder") },
    });
    input.value = this.initialTitle;
    const submit = () => {
      const title = input.value.trim() || t("chat.topic.untitled");
      this.close();
      this.onSubmit(title);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const okBtn = actions.createEl("button", { text: t("btn.ok"), cls: "mod-cta" });
    okBtn.addEventListener("click", submit);
    const cancelBtn = actions.createEl("button", { text: t("btn.cancel") });
    cancelBtn.addEventListener("click", () => this.close());
    input.focus();
    input.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 仓库内文件夹选择器（聊天历史存储路径用）。 */
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private folders: TFolder[];
  private onChoose: (path: string) => void;

  constructor(app: App, onChoose: (path: string) => void) {
    super(app);
    this.onChoose = onChoose;
    this.folders = app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .filter((f) => f.path !== "/")
      .sort((a, b) => a.path.localeCompare(b.path));
    this.setPlaceholder(t("setting.chatPath.choose"));
    this.emptyStateText = t("setting.chatPath.noFolder");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(item: TFolder): string {
    return item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item.path);
  }
}

/**
 * 权限确认弹窗：OpenCode 在这一步暂停等人拍板，不 reply 整轮就一直不结束。
 * 关掉弹窗等同于「拒绝」，避免用户误关之后这一轮永远挂着。
 */
export class PermissionRequestModal extends Modal {
  private req: OpenCodePermissionRequest;
  private resolve: (d: OpenCodePermissionDecision) => void;
  private settled = false;

  constructor(
    app: App,
    req: OpenCodePermissionRequest,
    resolve: (d: OpenCodePermissionDecision) => void,
  ) {
    super(app);
    this.req = req;
    this.resolve = resolve;
  }

  private finish(decision: OpenCodePermissionDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(decision);
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("permission.title") });
    const body = contentEl.createDiv({ cls: "xyag-permission-body" });
    body.createDiv({ text: t("permission.action", this.req.action || "?") });
    const resources = (this.req.resources || []).filter(Boolean);
    if (resources.length) body.createDiv({ text: t("permission.resources", resources.join(", ")) });
    if (this.req.message) body.createDiv({ text: t("permission.message", this.req.message) });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const once = actions.createEl("button", { text: t("permission.once"), cls: "mod-cta" });
    const always = actions.createEl("button", { text: t("permission.always") });
    const reject = actions.createEl("button", { text: t("permission.reject") });
    once.addEventListener("click", () => this.finish("once"));
    always.addEventListener("click", () => this.finish("always"));
    reject.addEventListener("click", () => this.finish("reject"));
  }

  onClose(): void {
    // 未做选择就关闭 → 拒绝
    if (!this.settled) {
      this.settled = true;
      this.resolve("reject");
    }
    this.contentEl.empty();
  }
}

export function askPermission(
  app: App,
  req: OpenCodePermissionRequest,
): Promise<OpenCodePermissionDecision> {
  return new Promise((resolve) => {
    new PermissionRequestModal(app, req, resolve).open();
  });
}

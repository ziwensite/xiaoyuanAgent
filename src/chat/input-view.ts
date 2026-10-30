import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import type { ChatCtx } from "./context";
import { showPopup, addPopupItem } from "../popup";
import { pickFiles as pickFilesUtil, handleFiles } from "../attachment";
import { TopicTitleModal } from "../modals";
import { listAgents } from "../agent-registry";
import { t } from "../i18n";
import { buildToolbarContent, updateAgentBorderClass } from "./header-view";
import { renderQuoteBarFor } from "./renderer";

// ─── 输入区 ─────────────────────────────────────────────────────

export function buildInputArea(ctx: ChatCtx, root: HTMLDivElement): void {
  const container = root.createDiv({ cls: "xyag-input-container" });

  const wikiBar = container.createDiv({ cls: "xyag-wiki-bar" });
  buildWikiToolbar(ctx, wikiBar);

  ctx.inputEl = container.createEl("textarea", {
    cls: "xyag-chat-input",
    attr: { placeholder: t("chat.placeholder") },
  });

  ctx.attachPreviewEl = container.createDiv({ cls: "xyag-attach-preview" });
  ctx.toolbarEl = container.createDiv({ cls: "xyag-toolbar" });
  buildToolbarContent(ctx, ctx.toolbarEl);
  updateAgentBorderClass(ctx);

  ctx.inputEl.addEventListener("keydown", (e) => {
    const popup = document.querySelector(".xyag-skill-popup");
    if (popup) {
      const items = popup.querySelectorAll(".xyag-skill-popup-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ctx.skillIndex = (ctx.skillIndex + 1) % items.length;
        highlightSkillItem(ctx, items);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        ctx.skillIndex = (ctx.skillIndex - 1 + items.length) % items.length;
        highlightSkillItem(ctx, items);
        return;
      }
      if (e.key === "Enter" && ctx.skillIndex >= 0 && items[ctx.skillIndex]) {
        e.preventDefault();
        (items[ctx.skillIndex] as HTMLElement).click();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ctx.sendMessage();
    }
    if (e.key === "Escape") {
      document.querySelectorAll(".xyag-skill-popup").forEach((el) => el.remove());
    }
  });

  ctx.inputEl.addEventListener("input", () => handleSlashOrAtInput(ctx));

  container.addEventListener("dragenter", (e) => {
    e.preventDefault();
    container.addClass("xyag-drag-over");
  });
  container.addEventListener("dragover", (e) => e.preventDefault());
  container.addEventListener("dragleave", () => container.removeClass("xyag-drag-over"));
  container.addEventListener("drop", (e) => {
    e.preventDefault();
    container.removeClass("xyag-drag-over");
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files, ctx.plugin.settings.maxAttachmentSize, (name, type, data, size) => {
        ctx.attachments.push({ name, type, data, size });
        renderQuoteBarFor(ctx);
      });
    }
  });
}

export function buildWikiToolbar(ctx: ChatCtx, container: HTMLElement): void {
  const s = ctx.plugin.settings;
  const wikiBtn = container.createSpan({ cls: "xyag-wiki-btn" });
  setIcon(wikiBtn, "book-open");
  setTooltip(wikiBtn, t("chat.tooltip.wiki"));
  wikiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showPopup(
      wikiBtn,
      (popup) => {
        if (s.skills.length === 0) {
          popup.createDiv({ cls: "xyag-popup-item", text: t("inputAt.empty") });
          return;
        }
        for (const skill of s.skills) {
          addPopupItem(popup, `${skill.name} — ${skill.description}`, false, () => {
            ctx.inputEl.value = `/${skill.name} `;
            ctx.inputEl.focus();
          });
        }
      },
      { direction: "up" },
    );
  });

  const tplBtn = container.createSpan({ cls: "xyag-wiki-btn" });
  setIcon(tplBtn, "sparkles");
  setTooltip(tplBtn, t("btn.aiTools"));
  tplBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const templates = s.promptTemplates || [];
    if (templates.length === 0) {
      new Notice(t("inputAt.noTemplates"));
      return;
    }
    const menu = new Menu();
    for (const tpl of templates) {
      menu.addItem((item) => {
        item.setTitle(`${tpl.name} — ${tpl.description}`);
        item.setIcon(tpl.icon);
        item.onClick(() => {
          ctx.inputEl.value = `/template:${tpl.name} `;
          ctx.inputEl.focus();
        });
      });
    }
    menu.showAtMouseEvent(e);
  });

  // 话题分段：仅作视觉分段，不影响上下文（见 DESIGN.md 5.10.3）
  const topicBtn = container.createSpan({ cls: "xyag-wiki-btn" });
  setIcon(topicBtn, "heading");
  setTooltip(topicBtn, t("chat.topic.new"));
  topicBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!ctx.currentTopicSection) {
      new TopicTitleModal(ctx.app, (title) => {
        void ctx.addTopic(title);
      }).open();
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("chat.topic.new"))
        .setIcon("heading")
        .onClick(() => {
          new TopicTitleModal(ctx.app, (title) => {
            void ctx.addTopic(title);
          }).open();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("chat.topic.end"))
        .setIcon("log-out")
        .onClick(() => {
          void ctx.endCurrentTopic();
        }),
    );
    menu.showAtMouseEvent(e);
  });
}

// ─── `/` 与 `@` 补全 ─────────────────────────────────────────────

export function handleSlashOrAtInput(ctx: ChatCtx): void {
  const existing = document.querySelector(".xyag-skill-popup");
  if (existing) {
    existing.remove();
    ctx.skillIndex = -1;
  }
  const text = ctx.inputEl.value;
  const parentEl = ctx.inputEl.parentElement;
  if (!parentEl) return;

  const atMatch = text.match(/@(\S*)$/);
  if (atMatch) {
    showAtMentionPopup(ctx, atMatch[1], parentEl);
    return;
  }

  if (!text.startsWith("/") || text.length < 1) return;

  const query = text.slice(1).toLowerCase();
  const s = ctx.plugin.settings;
  const hasQuery = query.length > 0;
  const matchedSkills = hasQuery ? s.skills.filter((sk) => sk.name.toLowerCase().includes(query)) : s.skills;
  const matchedTemplates = hasQuery
    ? s.promptTemplates.filter((tp) => tp.name.toLowerCase().includes(query))
    : s.promptTemplates;
  if (matchedSkills.length === 0 && matchedTemplates.length === 0) return;

  const popup = parentEl.createDiv({ cls: "xyag-skill-popup" });
  const addItem = (icon: string, name: string, desc: string, fill: string) => {
    const item = popup.createDiv({ cls: "xyag-skill-popup-item" });
    item.createSpan({ cls: "xyag-skill-popup-name", text: `${icon} ${name}` });
    item.createSpan({ cls: "xyag-skill-popup-desc", text: desc });
    item.addEventListener("click", () => {
      ctx.inputEl.value = fill;
      ctx.inputEl.focus();
      popup.remove();
      ctx.skillIndex = -1;
    });
  };
  for (const skill of matchedSkills) addItem("📋", skill.name, skill.description, `/${skill.name} `);
  for (const tpl of matchedTemplates) addItem("📖", tpl.name, tpl.description, `/template:${tpl.name} `);

  ctx.skillIndex = 0;
  const firstItem = popup.querySelector(".xyag-skill-popup-item");
  if (firstItem) firstItem.classList.add("is-selected");
}

/** `@` 弹出所有启用的 Agent（并标出前台）。 */
export function showAtMentionPopup(ctx: ChatCtx, query: string, parentEl: HTMLElement): void {
  const s = ctx.plugin.settings;
  const agentList = listAgents(s);
  const matched = query ? agentList.filter((a) => a.name.includes(query)) : agentList;
  if (matched.length === 0) return;

  const popup = parentEl.createDiv({ cls: "xyag-skill-popup" });
  for (const agent of matched) {
    const item = popup.createDiv({ cls: "xyag-skill-popup-item" });
    const iconEl = item.createSpan({ cls: "xyag-skill-popup-name" });
    setIcon(iconEl, agent.avatar || "bot");
    const desc = agent.isDefault ? `${agent.name} · ${t("setting.agents.isDefault")}` : agent.name;
    item.createSpan({ cls: "xyag-skill-popup-desc", text: desc });
    item.addEventListener("click", () => {
      ctx.inputEl.value = ctx.inputEl.value.replace(/@\S*$/, `@${agent.name} `);
      ctx.inputEl.focus();
      popup.remove();
      ctx.skillIndex = -1;
    });
  }

  ctx.skillIndex = 0;
  const firstItem = popup.querySelector(".xyag-skill-popup-item");
  if (firstItem) firstItem.classList.add("is-selected");
}

export function highlightSkillItem(ctx: ChatCtx, items: NodeListOf<Element>): void {
  items.forEach((el) => el.classList.remove("is-selected"));
  if (items[ctx.skillIndex]) items[ctx.skillIndex].classList.add("is-selected");
}

// ─── 附件 / 对外输入钩子 ──────────────────────────────────────────

export function pickFiles(ctx: ChatCtx): void {
  pickFilesUtil((name, type, data, size) => {
    ctx.attachments.push({ name, type, data, size });
    renderQuoteBarFor(ctx);
  }, ctx.plugin.settings.maxAttachmentSize);
}

/** 命令 / 设置面板写入输入框（不发送）。 */
export function setInputValue(ctx: ChatCtx, text: string): void {
  ctx.inputEl.value = text;
  ctx.inputEl.focus();
}

/** 由「用当前笔记开启对话」命令调用 */
export async function sendPrefilled(ctx: ChatCtx, text: string): Promise<void> {
  ctx.inputEl.value = text;
  await ctx.sendMessage();
}

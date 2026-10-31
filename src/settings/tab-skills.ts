import type { SettingsCtx } from "./context";
import { getDefaultAgent } from "../agent-registry";
import { t } from "../i18n";
import { createSelectField } from "../select-list";
import { getWorkspaceDir } from "../server";
import { Notice, Setting, TFile } from "obsidian";

// ─── Skills 设置 ──────────────────────────────────────────────────

/** 技能自动执行的间隔选项（常量提到模块层，别在每个 skill 行里重建一份） */
const SKILL_INTERVALS: { value: number; labelKey: string }[] = [
  { value: 0, labelKey: "interval.off" },
  { value: 60, labelKey: "interval.hourly" },
  { value: 360, labelKey: "interval.6hours" },
  { value: 1440, labelKey: "interval.daily" },
  { value: 10080, labelKey: "interval.weekly" },
];

export function buildSkillsTab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();

  const inputEl: HTMLTextAreaElement = container.createEl("textarea", {
    cls: "xyag-skills-generate-input",
    attr: { placeholder: t("setting.skills.create.desc") },
  });

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.skills.agents"))
      .setDesc(t("setting.skills.agents.desc"))
      .addButton((btn) => {
        btn.setButtonText(t("setting.skills.create"));
        btn.onClick(async () => {
          const file = ctx.app.vault.getAbstractFileByPath("AGENTS.md");
          if (file instanceof TFile) {
            new Notice(t("setting.skills.exists"));
            return;
          }
          const text = inputEl.value.trim();
          if (!text) {
            new Notice(t("setting.skills.inputFirst"));
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText(t("setting.skills.generating"));
          try {
            const { callAISession } = await import("../ai");
            const agent = getDefaultAgent(s);
            const result = await callAISession({
              prompt: `根据以下要求创建一份 AGENTS.md 文件内容，定义可复用的 AI skill/agent。

用户要求：
${text}

请直接输出 AGENTS.md 的完整内容，不要多余解释。`,
              settings: s,
              vaultDir: getWorkspaceDir(),
              // prompt 是裸任务指令，系统提示词要单独注入当前前台 Agent 的
              systemPrompt: agent?.systemPrompt,
            });
            await ctx.app.vault.create("AGENTS.md", result.trim());
            new Notice(t("setting.skills.generated"));
            inputEl.value = "";
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("configure") || msg.includes("connection") || msg.includes("API") || msg.includes("key")) {
              new Notice(t("skill.sync.notice"));
            } else {
              new Notice(t("skill.create.failed", msg));
            }
          } finally {
            btn.setDisabled(false);
            btn.setButtonText(t("setting.skills.create"));
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t("setting.skills.edit"));
        btn.onClick(() => {
          const file = ctx.app.vault.getAbstractFileByPath("AGENTS.md");
          if (!(file instanceof TFile)) {
            new Notice(t("setting.skills.notExist"));
            return;
          }
          ctx.app.workspace.openLinkText("AGENTS.md", "/");
        });
      }),
    "wand-sparkles",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.skills.list"))
      .setDesc(t("setting.skills.list.desc"))
      .addButton((btn) => {
        btn.setButtonText("↻");
        btn.setTooltip(t("setting.skills.syncTooltip"));
        btn.onClick(async () => {
          btn.setDisabled(true);
          try {
            const file = ctx.app.vault.getAbstractFileByPath("AGENTS.md");
            if (!(file instanceof TFile)) {
              new Notice(t("setting.skills.notExist"));
              return;
            }
            const content = await ctx.app.vault.read(file);
            const { callAISession } = await import("../ai");
            const agent = getDefaultAgent(s);
            const result = await callAISession({
              prompt: `从以下内容中提取所有 skill/agent，每个包含：
- name：英文名称，照搬原文不要修改
- description：简要描述

只返回纯 JSON 数组 [{name, description}]，不要其他文字。\n\n${content}`,
              settings: s,
              vaultDir: getWorkspaceDir(),
              systemPrompt: agent?.systemPrompt,
            });
            const jsonStart = result.indexOf("[");
            const jsonEnd = result.lastIndexOf("]");
            if (jsonStart === -1 || jsonEnd === -1) throw new Error(t("error.aiNoValidJson"));
            const skills = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
            if (!Array.isArray(skills)) throw new Error(t("error.aiFormatError"));
            s.skills = skills;
            await ctx.plugin.saveSettings();
            for (const skill of s.skills) ctx.plugin.registerSkillCommand(skill);
            new Notice(t("notice.syncSkills", String(skills.length)));
            ctx.refresh();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("configure") || msg.includes("connection") || msg.includes("API") || msg.includes("key")) {
              new Notice(t("skill.sync.notice"));
            } else {
              new Notice(t("skill.sync.failed", msg));
            }
          } finally {
            btn.setDisabled(false);
          }
        });
      }),
    "list",
  );

  if (s.skills.length === 0) {
    container.createDiv({ cls: "xyag-settings-empty", text: t("setting.skills.empty") });
    return;
  }

  const table = container.createEl("table", { cls: "xyag-skills-table" });
  const thead = table.createEl("thead");
  const headerRow = thead.createEl("tr");
  headerRow.createEl("th", { text: t("setting.skills.table.name") });
  headerRow.createEl("th", { text: t("setting.skills.table.desc") });
  headerRow.createEl("th", { text: t("setting.skills.table.autoRun") });

  const tbody = table.createEl("tbody");
  for (const skill of s.skills) {
    const row = tbody.createEl("tr");
    row.createEl("td", { text: skill.name });
    row.createEl("td", { text: skill.description });
    const actionCell = row.createEl("td");
    if (skill.autoRunInterval === undefined) skill.autoRunInterval = 0;
    actionCell.appendChild(
createSelectField({
        options: SKILL_INTERVALS.map((o) => ({ value: String(o.value), label: t(o.labelKey) })),
        value: String(skill.autoRunInterval),
        ariaLabel: t("setting.skills.table.autoRun"),
        onSelect: async (val) => {
          skill.autoRunInterval = Number.parseInt(val, 10) || 0;
          await ctx.plugin.saveSettings();
        },
      }).el,
    );
  }
}


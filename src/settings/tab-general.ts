import type { SettingsCtx } from "./context";
import { getAgentDisplayName, getDefaultAgent, listAgents, setDefaultAgent } from "../agent-registry";
import { t } from "../i18n";
import { FolderSuggestModal } from "../modals";
import { createSelectField } from "../select-list";
import type { XiaoyuanAgentSettings } from "../types";
import { Setting, TextComponent } from "obsidian";

// ─── 通用设置 ─────────────────────────────────────────────────────

/** 前台 Agent 名（用于「默认 Agent」描述文案）。 */
function getDefaultAgentName(s: XiaoyuanAgentSettings): string {
  const agent = getDefaultAgent(s);
  if (!agent) return "";
  // getAgentDisplayName 已经处理了「名字被误写成 id」的兜底，这里不用再判一遍
  return getAgentDisplayName(agent);
}

export function buildGeneralTab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();

  // 前台 Agent（不 @ 任何人时由谁回答）。选项名取 Agent 名，括号里标注其通道。
  const describeMode = (): string =>
    s.execMode === "cli" ? t("mode.cli.desc", getDefaultAgentName(s)) : t("mode.api.desc", getDefaultAgentName(s));

  const modeSetting = new Setting(container).setName(t("setting.general.mode"));
  const modeAgents = listAgents(s);
  const modeValue = getDefaultAgent(s)?.id || modeAgents[0]?.id || "";
  const modeSelect = createSelectField({
    options: modeAgents.map((agent) => ({
      value: agent.id,
      label: t("mode.option", getAgentDisplayName(agent), agent.channel === "cli" ? t("mode.cli") : t("mode.api")),
    })),
    value: modeValue,
    ariaLabel: t("setting.general.mode"),
    onSelect: async (val) => {
      setDefaultAgent(s, val);
      await ctx.plugin.saveSettings();
      modeSelect.setValue(val);
      modeSetting.setDesc(describeMode());
      // 前台 Agent 切换只重建聊天工具栏；CLI 重连接由 autoStart/execMode
      // 既有路径触发，连上后 OpenCode 服务事件会自动刷新状态卡 CLI 行。
      ctx.refreshChatView();
    },
  });
  modeSetting.controlEl.appendChild(modeSelect.el);
  modeSetting.setDesc(describeMode());
  ctx.decorateSetting(modeSetting, "bot");

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.proxy"))
      .setDesc(t("setting.proxy.desc"))
      .addToggle((toggle) => {
        toggle.setValue(s.proxyEnabled);
        toggle.onChange(async (val) => {
          s.proxyEnabled = val;
          await ctx.plugin.saveSettings();
          // 代理同时影响 CLI 与 API 连通性，且是状态卡代理行（直绑已在 saveSettings 钩子里完成）
          ctx.detectCliConnection();
          ctx.detectApiConnection();
        });
      }),
    "waypoints",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.proxyUrl"))
      .setDesc(t("setting.proxyUrl.desc"))
      .addText((text) =>
        text.setPlaceholder("http://127.0.0.1:7890").setValue(s.proxyUrl).onChange(async (val) => {
          s.proxyUrl = val.trim();
          await ctx.plugin.saveSettings();
          ctx.detectCliConnection();
          ctx.detectApiConnection();
        }),
      ),
    "route",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.autoOpen"))
      .addToggle((toggle) => {
        toggle.setValue(s.autoOpen);
        toggle.onChange(async (val) => {
          s.autoOpen = val;
          await ctx.plugin.saveSettings();
        });
      }),
    "panel-right-open",
  );

  const captureSetting = new Setting(container)
    .setName(t("setting.captureCmd"))
    .setDesc(t("setting.captureCmd.desc"));
  captureSetting.controlEl.appendChild(
createSelectField({
      options: [
        { value: "", label: t("setting.captureCmd.none") },
        ...ctx.app.commands.listCommands().map((cmd) => ({
          value: cmd.id,
          label: `${cmd.name} (${cmd.id})`,
        })),
      ],
      value: s.captureCommandId,
      ariaLabel: t("setting.captureCmd"),
      onSelect: async (val) => {
        s.captureCommandId = val;
        await ctx.plugin.saveSettings();
      },
    }).el,
  );
  ctx.decorateSetting(captureSetting, "camera");

  container.createEl("hr");
  container.createEl("h3", { text: t("setting.general.chatSettings") });

  let chatPathInput: TextComponent | null = null;
  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.chatPath"))
      .setDesc(t("setting.chatPath.desc"))
      .addText((text) => {
        chatPathInput = text;
        text
          .setPlaceholder("_xiaoyuanAgent/chatHistory")
          .setValue(s.chatHistoryPath === "_xiaoyuanAgent/chatHistory" ? "" : s.chatHistoryPath)
          .onChange(async (val) => {
            s.chatHistoryPath = val.trim() || "_xiaoyuanAgent/chatHistory";
            await ctx.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn.setIcon("folder-open").setTooltip(t("setting.chatPath.choose")).onClick(() => {
          new FolderSuggestModal(ctx.app, (path) => {
            chatPathInput?.setValue(path);
            s.chatHistoryPath = path;
            void ctx.plugin.saveSettings();
          }).open();
        });
      }),
    "folder",
  );

  const chatPositionSetting = new Setting(container).setName(t("setting.chatPosition"));
  chatPositionSetting.controlEl.appendChild(
createSelectField({
      options: [
        { value: "left", label: t("setting.chatPosition.left") },
        { value: "right", label: t("setting.chatPosition.right") },
      ],
      value: s.chatViewType,
      ariaLabel: t("setting.chatPosition"),
      onSelect: async (val) => {
        s.chatViewType = val as "left" | "right";
        await ctx.plugin.saveSettings();
      },
    }).el,
  );
  ctx.decorateSetting(chatPositionSetting, "layout-dashboard");

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.diff"))
      .setDesc(t("setting.diff.desc"))
      .addToggle((toggle) => {
        toggle.setValue(s.showDiffPreview);
        toggle.onChange(async (val) => {
          s.showDiffPreview = val;
          await ctx.plugin.saveSettings();
        });
      }),
    "file-diff",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.thinking"))
      .setDesc(t("setting.thinking.desc"))
      .addToggle((toggle) => {
        toggle.setValue(s.showThinking);
        toggle.onChange(async (val) => {
          s.showThinking = val;
          await ctx.plugin.saveSettings();
        });
      }),
    "brain",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.attachSize"))
      .setDesc(t("setting.attachSize.desc"))
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(s.maxAttachmentSize === 10 ? "" : String(s.maxAttachmentSize))
          .onChange(async (val) => {
            const n = parseInt(val);
            s.maxAttachmentSize = n > 0 ? n : 10;
            await ctx.plugin.saveSettings();
          }),
      ),
    "hard-drive",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.context"))
      .setDesc(t("setting.context.desc"))
      .addToggle((toggle) => {
        toggle.setValue(s.showContext);
        toggle.onChange(async (val) => {
          s.showContext = val;
          await ctx.plugin.saveSettings();
          ctx.refreshChatView();
        });
      }),
    "file-text",
  );
}


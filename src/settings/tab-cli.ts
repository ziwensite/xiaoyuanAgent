import type { SettingsCtx } from "./context";
import { clampPort } from "./widgets";
import { t } from "../i18n";
import { attachModelPicker, shortModelName } from "../model-picker";
import { createSelectTrigger } from "../model-select";
import { CLI_REASONING_OPTIONS, reasoningPresetLabel, toReasoningPreset } from "../reasoning";
import { createSelectField } from "../select-list";
import { getVaultBasePath } from "../server";
import { PermissionMode } from "../types";
import { Notice, Setting } from "obsidian";

// ─── CLI 设置 ─────────────────────────────────────────────────────

export function buildCLITab(ctx: SettingsCtx, container: HTMLElement) {
  const s = ctx.s();

  const pathSetting = ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.cli.path"))
      .setDesc(t("setting.cli.path.desc"))
      .addText((text) =>
        text
          .setPlaceholder("opencode")
          .setValue(s.opencode.cliPath === "opencode" ? "" : s.opencode.cliPath)
          .onChange(async (val) => {
            const newVal = val.trim() || "opencode";
            const changed = newVal !== s.opencode.cliPath;
            s.opencode.cliPath = newVal;
            if (changed) {
              s.opencodeAgents = [];
            }
            await ctx.plugin.saveSettings();
            if (changed && s.execMode === "cli") {
              const { ensureOpenCodeAgents } = await import("../opencode-sync");
              void ensureOpenCodeAgents({ plugin: ctx.plugin, silent: true, reason: "config-change" });
              ctx.notifyChatViewsOpenCode({ sync: true });
            }
            // CLI 连接状态始终展示在状态卡上，路径变更后定向重探（无论当前前台通道）
            ctx.detectCliConnection();
          }),
      ),
    "terminal-square",
  );
  (async () => {
    try {
      const { resolveOpenCodePath } = await import("../opencode-server");
      const detected = await resolveOpenCodePath(s.opencode.cliPath);
      if (detected && detected !== s.opencode.cliPath) pathSetting.setDesc(t("setting.cli.path.detected", detected));
    } catch {}
  })();

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.cli.autoStart"))
      .setDesc(t("setting.cli.autoStart.desc"))
      .addToggle((toggle) => {
        toggle.setValue(s.opencode.autoStart);
        toggle.onChange(async (val) => {
          s.opencode.autoStart = val;
          await ctx.plugin.saveSettings();
          // 两条通道同时在线：OpenCode 只要这个开关开着就该起，
          // 不能因为当前前台 Agent 是 API 那边就不起，否则 @小C 要等到
          // 第一次真正发消息时才懒启动（冷启动约 10s）。
          if (val) {
            const { ensureOpenCodeServer } = await import("../ai");
ensureOpenCodeServer(
              s.opencode.cliPath,
              s.opencode.hostname,
              s.opencode.port,
getVaultBasePath(),
              true,
            )
              .then(() => ctx.notifyChatViewsOpenCode())
              .catch(() => {});
          }
        });
      }),
    "play",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.cli.host"))
      .setDesc(t("setting.cli.host.desc"))
      .addText((text) =>
        text
          .setPlaceholder("127.0.0.1")
          .setValue(s.opencode.hostname === "127.0.0.1" ? "" : s.opencode.hostname)
          .onChange(async (val) => {
            const changed = val !== s.opencode.hostname;
            // 清空就落回默认值：对比 cliPath / port / chatHistoryPath 都有回退，
            // 只有 hostname 会把空串直接写进设置，之后连不上还查不出原因
            s.opencode.hostname = val.trim() || "127.0.0.1";
            await ctx.plugin.saveSettings();
            const { stopOpenCodeServer } = await import("../opencode-server");
            stopOpenCodeServer();
            if (changed && s.execMode === "cli") {
              ctx.notifyChatViewsOpenCode({ sync: true });
            }
            ctx.detectCliConnection();
          }),
      ),
    "globe",
  );

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.cli.port"))
      .setDesc(t("setting.cli.port.desc"))
      .addText((text) =>
        text
          .setPlaceholder("16226")
          .setValue(s.opencode.port === 16226 ? "" : String(s.opencode.port))
          .onChange(async (val) => {
            const oldPort = s.opencode.port;
            // 必须是 1–65535 的整数：旧实现只挡了 <= 0，
            // 填 99999 或 3.5 会一路写进设置，之后永远连不上
            s.opencode.port = clampPort(val);
            await ctx.plugin.saveSettings();
            if (oldPort !== s.opencode.port) {
              const { stopOpenCodeServer } = await import("../opencode-server");
stopOpenCodeServer();
            }
            if (oldPort !== s.opencode.port && s.execMode === "cli") {
              ctx.notifyChatViewsOpenCode({ sync: true });
            }
            ctx.detectCliConnection();
          }),
      ),
    "plug",
  );

  // 模型下拉框：自绘的 select 外观，展开的列表紧贴控件下沿（空间不够自动向上）。
  const modelSelect = createSelectTrigger({
    text: s.opencode.model ? shortModelName(s.opencode.model) : t("chat.model.tooltip"),
    tooltip: s.opencode.model || t("status.notConfigured"),
    ariaLabel: t("modelPicker.label"),
    onOpen: (trigger) => {
attachModelPicker(trigger, s, {
        persist: () => ctx.plugin.saveSettings(),
        direction: "auto",
        matchWidth: true,
        onToggle: (open) => modelSelect.setOpen(open),
        onSelect: (modelId) => {
          // 原地更新，别整页重绘 —— 重绘会把下拉框整个换掉，位置和焦点都会跳
          modelSelect.setText(shortModelName(modelId));
          modelSelect.setTooltip(modelId);
renderCaps();
          ctx.refreshChatView();
          new Notice(t("setting.cli.model") + ": " + shortModelName(modelId));
        },
        onRefresh: () => void ctx.syncOpenCodeModels(),
      });
    },
  });

  const modelSetting = new Setting(container)
    .setName(t("setting.cli.model"))
    .setDesc(t("setting.cli.model.desc"));
  // 下拉框要排在 ↻ 按钮左边
  modelSetting.controlEl.appendChild(modelSelect.el);
  modelSetting.addButton((btn) => {
    btn.setButtonText("↻");
    btn.setTooltip(t("setting.cli.model.syncTooltip"));
    btn.onClick(() => void ctx.syncOpenCodeModels());
  });
  ctx.decorateSetting(modelSetting, "box");

  const capsBox = modelSetting.descEl.createDiv({ cls: "xyag-model-caps" });
  const renderCaps = (): void => {
    capsBox.empty();
    const caps = s.opencodeModelCaps?.[s.opencode.model];
    if (!caps) return;
    const inputFlags: string[] = [];
    const inputLabels: [string, boolean][] = [
      [t("cap.text"), caps.text],
      [t("cap.image"), caps.image],
      ["PDF", caps.pdf],
      [t("cap.audio"), caps.audio],
      [t("cap.video"), caps.video],
    ];
    for (const [k, v] of inputLabels) inputFlags.push(v ? `${k}✓` : `${k}×`);
    capsBox.createDiv({ text: t("cap.input") + ": " + inputFlags.join(" ") });
    const featFlags: string[] = [];
    const featLabels: [string, boolean][] = [
      [t("cap.reasoning"), caps.reasoning],
      [t("cap.toolcall"), caps.toolcall],
      [t("cap.attachment"), caps.attachment],
      [t("cap.temperature"), caps.temperature],
    ];
    for (const [k, v] of featLabels) featFlags.push(v ? `${k}✓` : `${k}×`);
    capsBox.createDiv({ text: t("cap.features") + ": " + featFlags.join(" ") });
  };
renderCaps();

  {
    const agentItems = s.opencodeAgents || [];
    const fallbackItems: { id: string; name: string; description?: string }[] = !agentItems.length
      ? [
          { id: "build", name: "build" },
          { id: "plan", name: "plan" },
        ]
      : [];
    const allItems = agentItems.length ? agentItems : fallbackItems;
    const currentAgent = s.opencode.agent;
    const inList = allItems.some((a) => a.id === currentAgent);
    // OpenCode 内置 Agent 的 description 是英文，内置的几个按 id 翻译；
    // 用户自己写的（含中文）描述保持原样，未知 id 也回退原描述。
    const localizeAgentDesc = (id: string, raw?: string): string | undefined => {
      if (raw && /[\u3400-\u9fff]/.test(raw)) return raw;
      const key = `agent.builtin.${id}.desc`;
      const localized = t(key);
      return localized !== key ? localized : raw;
    };
    const currentDesc = localizeAgentDesc(currentAgent, allItems.find((a) => a.id === currentAgent)?.description);
    const agentSetting = new Setting(container)
      .setName(t("setting.cli.agent"))
      .setDesc(
        currentAgent
          ? t("setting.cli.agent.current") + ": " + currentAgent + (currentDesc ? ` (${currentDesc})` : "")
          : t("setting.cli.agent.desc"),
      );
    // 自绘下拉：原生 select 的选项列表由系统单独开窗渲染，会飘到设置窗口外面
    agentSetting.controlEl.appendChild(
createSelectField({
        options: allItems.map((a) => ({ value: a.id, label: a.name || a.id })),
        value: inList ? currentAgent : allItems[0]?.id || "build",
        ariaLabel: t("setting.cli.agent"),
        onSelect: async (val) => {
          s.opencode.agent = val;
          await ctx.plugin.saveSettings();
          ctx.refreshChatView();
          ctx.refresh();
        },
      }).el,
    );
    agentSetting.addButton((btn) => {
      btn.setButtonText("↻");
      btn.setTooltip(t("setting.cli.agent.syncTooltip"));
      btn.onClick(async () => {
        try {
          const { ensureOpenCodeAgents } = await import("../opencode-sync");
          await ensureOpenCodeAgents({ plugin: ctx.plugin, silent: false, force: true, reason: "manual" });
          ctx.refreshChatView();
          ctx.refresh();
        } catch (err: unknown) {
          new Notice(t("notice.syncFailed", err instanceof Error ? err.message : String(err)));
        }
      });
    });
    ctx.decorateSetting(agentSetting, "bot");
  }

  const cliReasoningSetting = new Setting(container)
    .setName(t("setting.cli.reasoning"))
    .setDesc(t("setting.cli.reasoning.desc"));
  // 与聊天工具栏共用同一份预设，避免两边标签 / 取值不一致
  const cliReasoningOptions = CLI_REASONING_OPTIONS.map((o) => ({
    value: o.preset,
    label: reasoningPresetLabel(o.preset),
  }));
  cliReasoningSetting.controlEl.appendChild(
createSelectField({
      options: cliReasoningOptions,
      value: toReasoningPreset(s.defaultReasoning),
      ariaLabel: t("setting.cli.reasoning"),
      onSelect: async (val) => {
        const option = CLI_REASONING_OPTIONS.find((o) => o.preset === val);
        if (!option || option.value === s.defaultReasoning) return;
        s.defaultReasoning = option.value;
        await ctx.plugin.saveSettings();
        ctx.refreshChatView();
      },
    }).el,
  );
  ctx.decorateSetting(cliReasoningSetting, "brain");

  const permissionSetting = new Setting(container)
    .setName(t("setting.cli.permission"))
    .setDesc(t("setting.cli.permission.desc.full"));
  permissionSetting.controlEl.appendChild(
createSelectField({
      options: [
        { value: "read-only", label: t("setting.cli.permission.ro") },
        { value: "workspace-write", label: t("setting.cli.permission.ww") },
        { value: "danger-full-access", label: t("setting.cli.permission.dfa") },
      ],
      value: s.defaultPermission,
      ariaLabel: t("setting.cli.permission"),
      onSelect: async (val) => {
        s.defaultPermission = val as PermissionMode;
        await ctx.plugin.saveSettings();
      },
    }).el,
  );
  ctx.decorateSetting(permissionSetting, "shield-check");

  ctx.buildCapabilityCheck(container);
}

/**
 * OpenCode 接口自检。
 *
 * OpenCode 的 CLI 会静默自动升级，而 v2 的次版本也可能改动接口路径或事件名。
 * 这里逐项探测插件真正依赖的能力，升级后用户能立刻看出**哪一项**坏了，
 * 而不是等到聊天失败才隐约觉得不对劲。
 */

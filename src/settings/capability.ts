import type { SettingsCtx } from "./context";
import { t } from "../i18n";
import { getWorkspaceDir } from "../server";
import { Notice, Setting } from "obsidian";

export function buildCapabilityCheck(ctx: SettingsCtx, container: HTMLElement) {
  const resultBox = container.createDiv({ cls: "xyag-capability" });

  ctx.decorateSetting(
    new Setting(container)
      .setName(t("setting.cli.capability.title"))
      .setDesc(t("setting.cli.capability.desc"))
      .addButton((btn) => {
        btn.setButtonText(t("setting.cli.capability.run"));
        btn.onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText(t("setting.cli.capability.running"));
          resultBox.empty();
          resultBox.createDiv({
            cls: "xyag-capability-item xyag-capability-running",
            text: t("setting.cli.capability.running"),
          });
          try {
            const { findOpenCodeConnection } = await import("../opencode-server");
            const { probeOpenCodeCapabilities } = await import("../opencode-probe");
            const cur = ctx.s();
            const conn = await findOpenCodeConnection(cur.opencode.port, cur.opencode.hostname);
            if (!conn) {
              resultBox.empty();
              resultBox.createDiv({
                cls: "xyag-capability-item xyag-capability-fail",
                text: t("setting.cli.capability.noServer"),
              });
              return;
            }
            const results = await probeOpenCodeCapabilities(conn, getWorkspaceDir());
            resultBox.empty();
            for (const item of results) {
              const label = t(`setting.cli.capability.item.${item.key}`);
              const text = `${item.ok ? "✓" : "✗"} ${label}${item.detail ? " — " + item.detail : ""}`;
              const el = resultBox.createDiv({
                cls: `xyag-capability-item ${item.ok ? "xyag-capability-ok" : "xyag-capability-fail"}`,
                text,
              });
              if (!item.ok && item.critical) el.addClass("xyag-capability-critical");
            }
            const failed = results.filter((r) => !r.ok);
            if (failed.length) new Notice(t("setting.cli.capability.failed", String(failed.length)));
            else new Notice(t("setting.cli.capability.passed"));
          } catch (err: unknown) {
            resultBox.empty();
            resultBox.createDiv({
              cls: "xyag-capability-item xyag-capability-fail",
              text: err instanceof Error ? err.message : String(err),
            });
          } finally {
            btn.setDisabled(false);
            btn.setButtonText(t("setting.cli.capability.run"));
          }
        });
      }),
    "stethoscope",
  );
}


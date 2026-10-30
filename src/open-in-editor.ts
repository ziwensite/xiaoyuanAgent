import { TFile, Notice } from "obsidian";
import { t } from "./i18n";
import type { Vault } from "obsidian";
import type { Workspace } from "obsidian";
import { formatDate, formatStamp } from "./utils";

/** 把任意文本转成安全的 YAML 双引号标量（关掉转义、引号与换行） */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").trim()}"`;
}

export async function openInEditor(
  content: string,
  vault: Vault,
  workspace: Workspace,
  chatHistoryPath: string,
  ts?: number,
  source?: string,
): Promise<void> {
  try {
    const tempRel = `${chatHistoryPath}/temp`;
    try {
      await vault.createFolder(tempRel);
    } catch {}

    const stamp = formatStamp(ts ?? Date.now());
    // 有明确时间戳时文件名是确定的：同一条消息反复「在编辑器中打开」会复用同一个
    // 文件，而不是每次都往 temp/ 里丢一个新的随机名文件。
    const suffix = ts ? "" : `-${Math.random().toString(36).slice(2, 8)}`;
    const fileRel = `${tempRel}/msg-${stamp}${suffix}.md`;

    const title = (content.split("\n")[0] || t("openInEditor.defaultTitle")).replace(/^#+\s*/, "").slice(0, 50);
    const dateOnly = formatDate(ts ?? Date.now());
    // title / source 里可能有 `:`、`"`、换行，直接拼会写出非法 YAML
    const frontmatter = `---\ntitle: ${yamlScalar(title)}\ncreated: ${dateOnly}${source ? `\nsource: ${yamlScalar(source)}` : ""}\n---\n\n`;
    const fullContent = frontmatter + content;

    const existing = vault.getAbstractFileByPath(fileRel);
    const file = existing instanceof TFile ? existing : await vault.create(fileRel, fullContent);
    if (existing instanceof TFile) await vault.modify(existing, fullContent);

    await workspace.getLeaf("tab").openFile(file);
  } catch (err: unknown) {
    new Notice(t("error.openFailed", err instanceof Error ? err.message : String(err)));
  }
}

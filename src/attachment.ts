import { Notice } from "obsidian";
import { t } from "./i18n";

const ACCEPT_TYPES = "image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml";

export function pickFiles(
  onFile: (name: string, type: string, data: string, size: number) => void,
  maxAttachmentSize: number,
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ACCEPT_TYPES;
  input.addEventListener("change", async () => {
    if (input.files) handleFiles(input.files, maxAttachmentSize, onFile);
  });
  input.click();
}

export async function handleFiles(
  files: FileList,
  maxAttachmentSize: number,
  onFile: (name: string, type: string, data: string, size: number) => void,
): Promise<void> {
  const maxBytes = maxAttachmentSize * 1024 * 1024;
  for (const file of Array.from(files)) {
    if (file.size > maxBytes) {
      new Notice(t("attachment.tooLarge", file.name, String(maxAttachmentSize)));
      continue;
    }
    try {
      const data = await readFileAsBase64(file);
      onFile(file.name, file.type || "application/octet-stream", data, file.size);
    } catch {}
  }
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

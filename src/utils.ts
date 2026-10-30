export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 127 ? 1.5 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 解析 unified diff 片段（OpenCode v2 `FileDiff.Info.patch`）。
 * 不依赖 `diff --git` / `+++ b/` 头部，只按 hunk 内容还原变更前后文本。
 */
export function parseUnifiedDiff(patch: string): { before: string; after: string } {
  if (!patch) return { before: "", after: "" };
  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  const lines = patch.split("\n");
  // patch 末尾的换行是结束符，不是内容行
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    } else {
      before.push(line);
      after.push(line);
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

/**
 * 抽取版本号里的数字段。
 *
 * 这里是 `majorVersion` / `compareVersions` 唯一的匹配实现，避免两者各写一份
 * 正则导致同一版本字符串被判定成互相矛盾的结论。
 *
 * 规则：
 * - 优先匹配带小数点的版本号，避免把 build 号 / 日期之类的孤立大数字当成版本；
 * - 匹配不到再退回裸数字（`v2`、`2`）。
 */
function versionNumbers(version: string): number[] | null {
  if (!version) return null;
  const match = /v?(\d+(?:\.\d+)+)/i.exec(version.trim()) ?? /v?(\d+)(?![\d.])/i.exec(version.trim());
  if (!match) return null;
  const parts = match[1].split(".").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts;
}

/**
 * 取出版本号的主版本号。
 *
 * 兼容各种输出格式：
 * - `2.1.2`（`/api/info` 的 version 字段）
 * - `v2.1.2`
 * - `opencode v2.1.2`（`opencode --version` 的输出）
 * - `opencode-v2.1.2`
 */
export function majorVersion(version: string): number | null {
  return versionNumbers(version)?.[0] ?? null;
}

/**
 * 比较两个版本号（`a` 相对 `b`）。
 *
 * 返回 `1` 表示 `a` 更新，`-1` 表示 `a` 更旧，`0` 表示相同或无法比较。
 * 只比较数字段（主版本.次版本.修订号），忽略 `v` 前缀与前后缀文字。
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionNumbers(a);
  const pb = versionNumbers(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function ensureApiUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : trimmed + "/chat/completions";
}

/** diff 表格的一行 */
export interface DiffRow {
  kind: "context" | "removed" | "added" | "changed";
  before?: string;
  after?: string;
  beforeLine?: number; // 1-based
  afterLine?: number;
}

/**
 * 行级 diff。
 *
 * 先裁掉公共前缀/后缀（真实改动通常只占文件的一小段），再对中间部分做 LCS；
 * 中间部分过大时退化为按位配对，避免 O(n²) 卡死界面。
 */
export function diffLineRows(beforeText: string, afterText: string): DiffRow[] {
  const b = beforeText.split("\n");
  const a = afterText.split("\n");
  const rows: DiffRow[] = [];

  const minLen = Math.min(b.length, a.length);
  let p = 0;
  while (p < minLen && b[p] === a[p]) p++;
  let s = 0;
  while (s < minLen - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s++;

  for (let i = 0; i < p; i++) {
    rows.push({ kind: "context", before: b[i], after: a[i], beforeLine: i + 1, afterLine: i + 1 });
  }

  const bMid = b.slice(p, b.length - s);
  const aMid = a.slice(p, a.length - s);
  const ops = lcsOps(bMid, aMid);

  let bi = p;
  let ai = p;
  let k = 0;
  // bMid/aMid 已经裁掉前 p 行，取内容要用 `绝对下标 - p`；行号则保留绝对下标 + 1
  while (k < ops.length) {
    if (ops[k] === "context") {
      rows.push({
        kind: "context",
        before: bMid[bi - p],
        after: aMid[ai - p],
        beforeLine: bi + 1,
        afterLine: ai + 1,
      });
      bi++;
      ai++;
      k++;
      continue;
    }
    // 收集一整段增删，再把删除/新增按位置两两配对成「修改」
    const delStart = bi;
    const addStart = ai;
    while (k < ops.length && ops[k] !== "context") {
      if (ops[k] === "removed") bi++;
      else ai++;
      k++;
    }
    const delCount = bi - delStart;
    const addCount = ai - addStart;
    const paired = Math.min(delCount, addCount);
    for (let i = 0; i < paired; i++) {
      rows.push({
        kind: "changed",
        before: bMid[delStart - p + i],
        after: aMid[addStart - p + i],
        beforeLine: delStart + i + 1,
        afterLine: addStart + i + 1,
      });
    }
    for (let i = paired; i < delCount; i++) {
      rows.push({ kind: "removed", before: bMid[delStart - p + i], beforeLine: delStart + i + 1 });
    }
    for (let i = paired; i < addCount; i++) {
      rows.push({ kind: "added", after: aMid[addStart - p + i], afterLine: addStart + i + 1 });
    }
  }

  for (let i = 0; i < s; i++) {
    const bb = b.length - s + i;
    const aa = a.length - s + i;
    rows.push({ kind: "context", before: b[bb], after: a[aa], beforeLine: bb + 1, afterLine: aa + 1 });
  }

  return rows;
}

/** 操作序列 */
type DiffOp = "context" | "removed" | "added";

/**
 * 对中间段求 LCS，返回按顺序排列的操作序列。
 * 乘积超过 1e6 时退化为按位配对，防止大文件把界面卡死。
 */
function lcsOps(b: string[], a: string[]): DiffOp[] {
  const n = b.length;
  const m = a.length;

  if (n * m > 1_000_000) {
    const out: DiffOp[] = [];
    const len = Math.max(n, m);
    for (let i = 0; i < len; i++) {
      const hasB = i < n;
      const hasA = i < m;
      if (hasB && hasA && b[i] === a[i]) {
        out.push("context");
      } else {
        if (hasB) out.push("removed");
        if (hasA) out.push("added");
      }
    }
    return out;
  }

  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = b[i] === a[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      out.push("context");
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push("removed");
      i++;
    } else {
      out.push("added");
      j++;
    }
  }
  while (i < n) {
    out.push("removed");
    i++;
  }
  while (j < m) {
    out.push("added");
    j++;
  }
  return out;
}

/**
 * 全项目统一的时间格式化。
 *
 * 之前 `action-bar.ts` / `chat-view.ts` / `main.ts` / `open-in-editor.ts`
 * 各写了一份 `padStart(2, "0")` 拼接，格式随时会漂移（有的补 0 有的不补），
 * 统一收敛到这里。
 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${formatDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `HH:mm`（消息气泡上的时间角标） */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYYMMDD-HHmm`，用于临时文件名 */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function tryParseJson<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

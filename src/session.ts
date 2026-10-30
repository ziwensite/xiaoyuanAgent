import { Vault } from "obsidian";
import type { ChatMessage, ChatSession, TopicSection } from "./types";
import type XiaoyuanAgentPlugin from "./main";
import { CHAT_SESSIONS_KEY, CURRENT_SESSION_KEY } from "./constants";
import { formatDate, formatTime } from "./utils";
import { t } from "./i18n";

export function getChatHistoryPath(chatHistoryPath: string): string {
  return chatHistoryPath || "_xiaoyuanAgent/chatHistory";
}

function getSessionFilePath(chatHistoryPath: string, sessionId: string): string {
  return `${getChatHistoryPath(chatHistoryPath)}/${sessionId}.md`;
}

export async function ensureChatHistoryFolder(vault: Vault, path: string): Promise<void> {
  const folder = vault.getFolderByPath(path);
  if (folder) return;
  try {
    await vault.createFolder(path);
  } catch (err: unknown) {
    if (vault.getFolderByPath(path)) return;
    throw err;
  }
}

/**
 * 消息头。
 *
 * 形如 `**你** (API · 2025-06-05 10:30):` 或 `**小A**:`。
 *
 * - 名字用 `(.+?)` 通配，**不再写死 你/小元/小A/小C**：Agent 名可在设置里自定义，
 *   写死会导致改名后历史会话整份读不出来。
 * - 时间戳整段可选：`sessionToMarkdown` 对没有 timestamp 的消息只写 `**你**:`
 *   （旧数据迁移过来的消息就没有），写死会让这类消息被静默丢弃。
 * - 通道段兼容 `CLI|API|OpenCode`，避免改名后旧会话读不出来。
 */
const HEADER_RE = /^\*\*(.+?)\*\*(?:\s*\((?:CLI|API|OpenCode)\s*·\s*(.+?)\))?\s*:$/;

/** 话题分段标记：`## 话题 <标题>`（仅展示用，不影响上下文） */
const TOPIC_RE = /^##\s+话题\s+(.+?)\s*$/;
/** 话题结束标记：`## 话题结束` —— 之后的消息回到话题外 */
const TOPIC_END_RE = /^##\s+话题结束\s*$/;

interface DraftMessage {
  name: string;
  ts?: number;
  body: string[];
  thinking: string[];
  inThinking: boolean;
}

/**
 * 从会话 Markdown 还原消息列表。
 *
 * 分段靠**消息头**而不是 `---`：正文里的 markdown 水平线、代码块中的 `---`
 * 都是合法内容，用 `---` 切分会把一条消息劈成两半、后半段直接丢失。
 * 只有当 `---` 后面（跳过空行）紧跟另一个消息头、或者已经到文件末尾时，
 * 才把它当作消息分隔符丢弃。
 *
 * 话题标题（`## 话题 x`）只是排版标记，解析时直接丢弃，不进消息体。
 */
export function parseMarkdownToMessages(content: string): ChatMessage[] {
  return parseSessionContent(content).messages;
}

/**
 * 从会话 Markdown 同时还原消息列表和话题分段。
 * 话题标记（`## 话题 <标题>`）按出现顺序记录，
 * `startIndex` = 该话题第一个消息在消息数组中的下标。
 *
 * 分段靠**消息头**而不是 `---`：正文里的 markdown 水平线、代码块中的 `---`
 * 都是合法内容，用 `---` 切分会把一条消息劈成两半、后半段直接丢失。
 * 只有当 `---` 后面（跳过空行）紧跟另一个消息头 / 话题标记、或者已经到文件末尾时，
 * 才把它当作消息分隔符丢弃。
 *
 * 围栏状态：``` 里的行一律按正文处理。否则 AI 在代码示例里写一行 `**小A**: xxx`
 * 就会被当成消息头、写一行 `---` 恰好下一行又是消息头就会被当成段落分隔符，
 * 历史会话会被从中间劈开、后半段并进别的消息里。
 * 只在 draft 存在时跟踪：消息之前只有 frontmatter，标题里的反引号不该开栏。
 */
export function parseSessionContent(content: string): { messages: ChatMessage[]; topics: TopicSection[] } {
  const messages: ChatMessage[] = [];
  const topics: TopicSection[] = [];
  const lines = content.split("\n");
  let idCounter = 0;
  let draft: DraftMessage | null = null;

  const flush = () => {
    if (!draft) return;
    const d = draft;
    draft = null;
    const text = d.body.join("\n").trim();
    if (!text) return;
    const role: "user" | "assistant" = d.name === "你" ? "user" : "assistant";
    const msg: ChatMessage = {
      id: "msg-" + ++idCounter,
      role,
      content: text,
      source: role === "user" ? "user" : d.name,
    };
    if (d.thinking.length > 0) msg.thinking = d.thinking.join("\n").trim();
    if (d.ts) msg.timestamp = d.ts;
    messages.push(msg);
  };

  let inFence = false;
  let openMarker = "";
  let openTopic: TopicSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (draft) {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const marker = fence[1];
        if (!inFence) {
          inFence = true;
          openMarker = marker;
        } else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
          inFence = false;
          openMarker = "";
        }
        draft.body.push(line);
        continue;
      }
      if (inFence) {
        draft.body.push(line);
        continue;
      }
    }

    const hMatch = line.match(HEADER_RE);
    if (hMatch) {
      flush();
      let ts: number | undefined;
      if (hMatch[2]) {
        const parsed = new Date(hMatch[2]).getTime();
        if (!Number.isNaN(parsed)) ts = parsed;
      }
      draft = { name: hMatch[1], ts, body: [], thinking: [], inThinking: false };
      continue;
    }

    if (TOPIC_END_RE.test(line)) {
      if (draft) {
        flush();
      }
      if (openTopic) {
        openTopic.endIndex = messages.length;
        openTopic = null;
      }
      continue;
    }

    const tMatch = line.match(TOPIC_RE);
    if (tMatch) {
      if (draft) {
        flush();
      }
      // 上一个话题没写结束标记就被新话题打断 ⇒ 隐式结束在当前位置
      if (openTopic && openTopic.endIndex === undefined) {
        openTopic.endIndex = messages.length;
      }
      const section: TopicSection = {
        id: `topic-${topics.length + 1}`,
        title: tMatch[1],
        startIndex: messages.length,
      };
      topics.push(section);
      openTopic = section;
      continue;
    }

    if (!draft) continue;

    if (line.trim() === "---") {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || HEADER_RE.test(lines[j]) || TOPIC_RE.test(lines[j]) || TOPIC_END_RE.test(lines[j]))
        continue;
    }

    if (line.trim() === "> [!thinking] 思考过程") {
      draft.inThinking = true;
      continue;
    }
    if (draft.inThinking) {
      if (line.startsWith("> ")) {
        draft.thinking.push(line.slice(2));
        continue;
      }
      draft.inThinking = false;
    }

    draft.body.push(line);
  }
  flush();

  return { messages, topics };
}

export function sessionToMarkdown(
  session: ChatSession | undefined,
  messages: ChatMessage[],
  execMode: string,
  topics: TopicSection[] = [],
): string {
  const now = Date.now();
  const created = session?.createdAt || now;
  const owner = session?.ownerAgentId ? `\nowner: ${session.ownerAgentId}` : "";
  // 空话题（还没有任何消息）不落盘；结束位置越界的一律夹到末尾。
  const sortedTopics = [...topics]
    .filter((t) => t.startIndex < messages.length)
    .sort((a, b) => a.startIndex - b.startIndex);
  const startIndexes = new Set(sortedTopics.map((t) => t.startIndex));
  // index -> 该位置要写的标记行（同一位置可能既有结束标记又有下一个话题的开始标记）
  const markers = new Map<number, string[]>();
  const pushMarker = (idx: number, line: string) => {
    const arr = markers.get(idx);
    if (arr) arr.push(line);
    else markers.set(idx, [line]);
  };
  for (const topic of sortedTopics) {
    pushMarker(topic.startIndex, `## 话题 ${topic.title}`);
    if (topic.endIndex !== undefined && topic.endIndex > topic.startIndex) {
      const end = Math.min(topic.endIndex, messages.length);
      // 下一个话题正好从这里开始时不写结束标记，避免同一位置两行冗余
      if (!startIndexes.has(end)) pushMarker(end, "## 话题结束");
    }
  }
  // 用数组收集最后 join：长会话下 `content +=` 是 O(n²) 的字符串拷贝
  const out: string[] = [
    `---\ntitle: ${session?.title || t("chat.sessionTitle.default")}\n` +
      `created: ${formatDate(created)}\nupdated: ${formatDate(now)}${owner}\n---\n\n`,
  ];
  const emitMarkers = (idx: number) => {
    const list = markers.get(idx);
    if (!list) return;
    for (const line of list) out.push(`${line}\n\n`);
    markers.delete(idx);
  };
  messages.forEach((msg, idx) => {
    emitMarkers(idx);
    const ts = msg.timestamp ? ` (${execMode.toUpperCase()} · ${formatTime(msg.timestamp)}):` : ":";
    const displayName = msg.source && msg.source !== "user" ? msg.source : msg.role === "user" ? "你" : "小元";
    out.push(`**${displayName}**${ts}\n\n${msg.content}\n\n`);
    if (msg.thinking) {
      out.push(`> [!thinking] 思考过程\n> ${msg.thinking.replace(/\n/g, "\n> ")}\n\n`);
    }
    out.push(`---\n\n`);
  });
  // 落在文末的标记（例如最后一个话题在最后一条消息之后结束）
  for (const idx of [...markers.keys()].sort((a, b) => a - b)) emitMarkers(idx);
  return out.join("");
}

async function collectSessionFiles(vault: Vault, folderPath: string): Promise<string[]> {
  const prefix = folderPath + "/";

  try {
    const listed = await vault.adapter.list(folderPath);
    const files = listed.files.filter((f) => f.endsWith(".md"));
    if (files.length > 0) return files;
  } catch {}

  try {
    const files = vault
      .getFiles()
      .filter((f) => f.path.startsWith(prefix) && f.extension === "md")
      .map((f) => f.path);
    if (files.length > 0) return files;
  } catch {}

  return [];
}

/** 只解析 frontmatter 区块，避免正文里的一行 `owner: xxx` 被当成归属 Agent */
function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!block) return fm;
  for (const line of block[1].split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

/** 时间戳解析：解析不出来就回落，别把 NaN 写进 updatedAt（排序会失效） */
function parseTimestamp(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : fallback;
}

/** 没有 title 时用它兜底：取第一条消息的正文，不为此去解析整份会话 */
function firstMessagePreview(content: string): string {
  const lines = content.split("\n");
  let inFm = lines[0]?.trim() === "---";
  for (let i = inFm ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFm) {
      if (line.trim() === "---") inFm = false;
      continue;
    }
    if (!HEADER_RE.test(line)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (lines[j].trim() === "---") break;
      return lines[j].trim().slice(0, 30);
    }
    break;
  }
  return "";
}

/** 小规模并发：一次扫描要读几十上百个文件，串行 await 太慢 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const r = await fn(item);
        if (r !== null) results.push(r);
      } catch (err: unknown) {
        console.warn("[xiaoyuanAgent] 扫描会话文件失败:", err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scanChatHistoryFolder(vault: Vault, chatHistoryPath: string): Promise<ChatSession[]> {
  try {
    const folderPath = getChatHistoryPath(chatHistoryPath);
    const filePaths = await collectSessionFiles(vault, folderPath);

    // 这里只需要 frontmatter（标题 / 时间 / 归属），不再对每份会话做全量解析；
    // 并且并发读取，避免上百个文件串行 await。
    const loaded = await mapWithConcurrency(filePaths, 8, async (filePath): Promise<ChatSession | null> => {
      const name = filePath.split("/").pop();
      if (!name) return null;
      const sessionId = name.replace(".md", "");
      const content = await vault.adapter.read(filePath);
      const fm = parseFrontmatter(content);
      return {
        id: sessionId,
        title: fm.title || firstMessagePreview(content) || t("chat.sessionTitle.history"),
        createdAt: parseTimestamp(fm.created, Date.now()),
        updatedAt: parseTimestamp(fm.updated, Date.now()),
        ownerAgentId: fm.owner || null,
      };
    });

    loaded.sort((a, b) => b.updatedAt - a.updatedAt);
    return loaded;
  } catch (err: unknown) {
    console.warn("扫描历史会话文件夹失败:", err);
    return [];
  }
}

async function readVaultFile(vault: Vault, filePath: string): Promise<string | null> {
  try {
    if (await vault.adapter.exists(filePath)) {
      return vault.adapter.read(filePath);
    }
  } catch {}
  try {
    const file = vault.getFiles().find((f) => f.path === filePath);
    if (file) return vault.read(file);
  } catch {}
  return null;
}

/**
 * 读取会话并同时还原消息和话题分段（用于重新加载 UI）。
 */
export async function loadSessionWithTopics(
  vault: Vault,
  chatHistoryPath: string,
  sessionId: string,
): Promise<{ messages: ChatMessage[]; topics: TopicSection[] }> {
  const filePath = getSessionFilePath(chatHistoryPath, sessionId);
  const content = await readVaultFile(vault, filePath);
  if (!content) return { messages: [], topics: [] };
  return parseSessionContent(content);
}

export async function saveSessionToFile(
  vault: Vault,
  chatHistoryPath: string,
  sessionId: string,
  session: ChatSession | undefined,
  messages: ChatMessage[],
  execMode: string,
  topics: TopicSection[] = [],
): Promise<boolean> {
  await ensureChatHistoryFolder(vault, chatHistoryPath);
  const filePath = getSessionFilePath(chatHistoryPath, sessionId);
  const content = sessionToMarkdown(session, messages, execMode, topics);

  try {
    if (await vault.adapter.exists(filePath)) {
      await vault.adapter.write(filePath, content);
    } else {
      await vault.create(filePath, content);
    }
    return true;
  } catch (err: unknown) {
    // 返回失败而不是假装成功：调用方可以给提示，而不是让用户以为会话存下来了
    console.warn(`保存会话文件 ${filePath} 失败:`, err);
    return false;
  }
}

export async function deleteSessionFile(vault: Vault, chatHistoryPath: string, sessionId: string): Promise<void> {
  const filePath = getSessionFilePath(chatHistoryPath, sessionId);
  try {
    if (await vault.adapter.exists(filePath)) {
      await vault.adapter.remove(filePath);
    }
  } catch (err: unknown) {
    console.warn(`删除会话文件 ${filePath} 失败:`, err);
  }
}

export async function loadSessionsMeta(
  plugin: XiaoyuanAgentPlugin,
): Promise<{ sessions: ChatSession[]; currentSessionId: string }> {
  const data = await plugin.loadData();
  let sessions: ChatSession[] = [];
  let currentSessionId = "";

  if (data?.[CHAT_SESSIONS_KEY] && typeof data[CHAT_SESSIONS_KEY] === "string") {
    try {
      const parsed = JSON.parse(data[CHAT_SESSIONS_KEY] as string);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        sessions = (parsed as unknown[])
          .filter((s): s is ChatSession => !!s && typeof (s as ChatSession).id === "string")
          // 时间戳可能是 null / NaN（写盘时 JSON.stringify 把 NaN 变成了 null），
          // 不修正的话排序失效，会话列表会出现诡异顺序
          .map((s) => ({
            ...s,
            createdAt: Number.isFinite(s.createdAt) ? s.createdAt : now,
            updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now,
          }));
      }
    } catch (err: unknown) {
      console.warn("[xiaoyuanAgent] 会话元数据解析失败:", err);
    }
  }

  // currentSessionId 必须与 sessions 一样做类型校验，否则脏数据会让后续
  // `find(x => x.id === currentSessionId)` 永远匹配不上
  if (typeof data?.[CURRENT_SESSION_KEY] === "string") {
    currentSessionId = data[CURRENT_SESSION_KEY] as string;
  }

  return { sessions, currentSessionId };
}

export async function saveSessionsMeta(
  plugin: XiaoyuanAgentPlugin,
  sessions: ChatSession[],
  currentSessionId: string,
): Promise<void> {
  const data = (await plugin.loadData()) || {};
  data[CHAT_SESSIONS_KEY] = JSON.stringify(
    sessions.map((s) => {
      const { title, id, createdAt, updatedAt, ownerAgentId } = s;
      return { title, id, createdAt, updatedAt, ownerAgentId: ownerAgentId ?? null };
    }),
  );
  data[CURRENT_SESSION_KEY] = currentSessionId;
  await plugin.saveData(data);
}

export function migrateOldData(data: Record<string, unknown>): ChatMessage[] | null {
  const raw = data?.["xiaoyuan-chat-history"];
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
  } catch {
    return null;
  }
}

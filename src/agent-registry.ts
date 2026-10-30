import type { AgentChannel, AgentConfig, ChatMessage } from "./types";
import { BUILTIN_AGENT_A_ID, BUILTIN_AGENT_C_ID } from "./constants";
import { t } from "./i18n";

type WithAgents = { agents: AgentConfig[]; execMode: AgentChannel };

/** 启用的 Agent（可选包含停用项） */
export function listAgents(s: WithAgents, includeDisabled = false): AgentConfig[] {
  return s.agents.filter((a) => includeDisabled || a.enabled);
}

export function getAgentById(s: WithAgents, id: string): AgentConfig | undefined {
  return s.agents.find((a) => a.id === id);
}

export function getAgentByName(s: WithAgents, name: string): AgentConfig | undefined {
  return s.agents.find((a) => a.name === name);
}

/** 前台默认回答者；缺失时回退第一个启用的 Agent。 */
export function getDefaultAgent(s: WithAgents): AgentConfig | undefined {
  return (
    s.agents.find((a) => a.isDefault && a.enabled) ??
    s.agents.find((a) => a.isDefault) ??
    listAgents(s)[0] ??
    s.agents[0]
  );
}

/** 某通道下的内置/首个 Agent（CLI/API 面板署名用）。 */
export function getAgentForChannel(s: WithAgents, channel: AgentChannel): AgentConfig | undefined {
  const pool = listAgents(s, true).filter((a) => a.channel === channel);
  return pool.find((a) => a.builtin) ?? pool[0];
}

/** 保证有且仅有一个 isDefault；并同步 execMode 与默认 Agent 的通道。 */
export function ensureDefaultAgent(s: WithAgents): void {
  const enabled = s.agents.filter((a) => a.enabled);
  if (s.agents.length === 0) return;
  // 内置 Agent 的 systemPrompt 在 constants 里故意留空、由 loadSettings 按当前语言填充。
  // 若有人直接用 DEFAULT_SETTINGS 而没走迁移，这里兜一层，避免把空提示词发出去。
  for (const a of s.agents) {
    if (!a.builtin || a.systemPrompt) continue;
    if (a.id === BUILTIN_AGENT_A_ID) a.systemPrompt = t("agent.defaultPromptA");
    else if (a.id === BUILTIN_AGENT_C_ID) a.systemPrompt = t("agent.defaultPromptC");
  }
  if (enabled.length === 0) {
    // 至少保留一个启用的 Agent
    s.agents[0].enabled = true;
  }
  const current = s.agents.find((a) => a.isDefault && a.enabled);
  const next = current ?? enabled[0] ?? s.agents[0];
  for (const a of s.agents) a.isDefault = a.id === next.id;
  s.execMode = next.channel;
}

/** 把默认标记移交给指定 Agent。 */
export function setDefaultAgent(s: WithAgents, id: string): void {
  const target = getAgentById(s, id);
  if (!target) return;
  if (!target.enabled) target.enabled = true;
  for (const a of s.agents) a.isDefault = a.id === target.id;
  s.execMode = target.channel;
}

/** 生成不与现有重名的名字。base 缺省时按「小D / 小E…」递增。 */
export function uniqueAgentName(s: WithAgents, base?: string): string {
  const taken = new Set(s.agents.map((a) => a.name));
  if (base && !taken.has(base)) return base;
  const seed = base ?? t("agent.defaultName.new");
  const match = /^(.*?)(\d+)$/.exec(seed);
  const prefix = match ? match[1] : seed;
  let n = match ? Number(match[2]) : 1;
  let name = `${prefix}${n}`;
  while (taken.has(name)) name = `${prefix}${++n}`;
  return name;
}

/** 生成唯一 id。 */
function uniqueAgentId(s: WithAgents): string {
  const taken = new Set(s.agents.map((a) => a.id));
  let id = `agent-${Date.now().toString(36)}`;
  let n = 1;
  while (taken.has(id)) id = `agent-${Date.now().toString(36)}-${n++}`;
  return id;
}

/** 新建 Agent。默认通道沿用当前前台 Agent 的通道（见 DESIGN.md Q2）。 */
export function createAgent(s: WithAgents, partial: Partial<AgentConfig> = {}): AgentConfig {
  const fallbackChannel = getDefaultAgent(s)?.channel ?? "api";
  const name = partial.name ?? uniqueAgentName(s);
  const agent: AgentConfig = {
    id: partial.id ?? uniqueAgentId(s),
    name,
    avatar: partial.avatar ?? "bot",
    channel: partial.channel ?? fallbackChannel,
    systemPrompt: partial.systemPrompt ?? t("agent.defaultPromptNew", name),
    enabled: partial.enabled ?? true,
    model: partial.model,
    isDefault: partial.isDefault ?? false,
    builtin: partial.builtin ?? false,
  };
  return agent;
}

export function canRemoveAgent(agent: AgentConfig): boolean {
  return !agent.builtin;
}

/** 名称是否已被其它 Agent 占用。 */
export function isAgentNameTaken(s: WithAgents, name: string, exceptId?: string): boolean {
  return s.agents.some((a) => a.name === name && a.id !== exceptId);
}

/** 内置 Agent 的默认名（用于恢复与判定）。 */
export function builtinDefaultName(id: string): string | undefined {
  if (id === BUILTIN_AGENT_A_ID) return t("agent.defaultName.new").replace(/D$/, "A");
  if (id === BUILTIN_AGENT_C_ID) return t("agent.defaultName.new").replace(/D$/, "C");
  return undefined;
}

/** 获取 Agent 的显示名：内置 Agent 的名字被误改成 ID 时自动修复显示。 */
export function getAgentDisplayName(agent: AgentConfig): string {
  if (!agent.builtin) return agent.name;
  const looksBroken = !agent.name.trim() || agent.name === agent.id || agent.name.startsWith("agent-");
  if (!looksBroken) return agent.name;
  return builtinDefaultName(agent.id) ?? agent.name;
}

/** 解析 `@名字` / `名字，` 前缀 → { agent, cleanText }。 */
export function resolveAgentTarget(
  text: string,
  s: WithAgents,
): { agent: AgentConfig | undefined; cleanText: string } {
  const agents = listAgents(s);
  // @名字 前缀优先
  for (const agent of agents) {
    const at = `@${agent.name}`;
    if (text.startsWith(at)) {
      return { agent, cleanText: text.slice(at.length).trim() };
    }
  }
  // 「名字，」/「名字,」/「名字 」前缀
  for (const agent of agents) {
    for (const sep of ["，", ",", " "]) {
      const prefix = agent.name + sep;
      if (text.startsWith(prefix)) {
        return { agent, cleanText: text.slice(prefix.length).trim() };
      }
    }
  }
  return { agent: getDefaultAgent(s), cleanText: text };
}

/**
 * 提取回复中的 `@其他Agent 任务`，用于后台委托。
 * 只收集当前可用（启用且非自己）的 Agent。
 */
export function extractAgentDelegations(
  text: string,
  s: WithAgents,
  self?: AgentConfig,
): { agent: AgentConfig; task: string }[] {
  const agents = listAgents(s);
  const result: { agent: AgentConfig; task: string }[] = [];
  const re = /@(\S+?)\s+(.+?)(?=\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const candidate = match[1];
    const task = match[2].trim();
    if (!task) continue;
    const agent = agents.find((a) => a.name === candidate);
    if (agent && agent.id !== self?.id) result.push({ agent, task });
  }
  return result;
}

/**
 * 拼装多轮消息为单条 prompt（含「当前助手」标识）。
 * 会话为群聊语义，全部消息均纳入上下文（见 DESIGN.md 5.10.5）。
 */
export function buildAgentMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  userContent: string,
  source: string,
): string {
  const modeIdentity = `\n\n当前助手: ${source}`;
  const allMessages = [
    { role: "system" as const, content: systemPrompt + modeIdentity },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];
  return allMessages
    .map((m) => `${m.role === "system" ? "[系统]" : m.role === "user" ? "[用户]" : `[${source}]`}: ${m.content}`)
    .join("\n\n");
}

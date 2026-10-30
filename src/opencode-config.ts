import { spawn } from "child_process";
import type { ModelEntry, ModelCaps, OpenCodeAgentInfo } from "./types";
import { httpGetOpenCode } from "./opencode-client";
import { findOpenCodeConnection, resolveOpenCodePath } from "./opencode-server";
import { DEFAULT_OPENCODE_PORT } from "./constants";

/**
 * OpenCode 配置 / 模型与 agent 拉取。
 *
 * v2.1.4 实测契约（都带 `{ location, data }` 信封，由 httpGetOpenCode 自动拆开）：
 * - `GET /api/model`   → Model.Info[]   { id, modelID, providerID, family, name, ... }
 * - `GET /api/provider`→ Provider.Info[]{ id, integrationID, name, activation, ... }
 * - `GET /api/agent`   → Agent.Info[]   { id, name, description, mode, hidden, ... }
 *
 * 注意：这里**只做探测，不顺带拉起服务**——设置里的状态卡片打开时不应该等一轮
 * 15 秒的服务启动。
 */

/** OpenCode v2 `Model.Info`（字段比我们用到的多，只声明关心的部分） */
export interface OpenCodeModelInfo {
  id?: string;
  modelID?: string;
  providerID?: string;
  family?: string;
  name?: string;
  enabled?: boolean;
  status?: string;
  compatibility?: { reasoningField?: string };
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
    temperature?: boolean;
  };
  variants?: { id?: string }[];
  package?: string;
  settings?: Record<string, unknown>;
  /** 模型能力上限，`context` 即上下文窗口大小（token） */
  limit?: { context?: number; input?: number; output?: number };
}

/** OpenCode v2 `Provider.Info` */
export interface OpenCodeProviderInfo {
  id?: string;
  integrationID?: string;
  name?: string;
  activation?: string;
  package?: string;
  settings?: Record<string, unknown>;
}

interface FlattenResult {
  models: ModelEntry[];
  caps: Record<string, ModelCaps>;
}

interface RawModelEntry {
  id?: string;
  name?: string;
  enabled?: boolean;
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean };
    output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean };
  };
}

interface ProviderConfig {
  name?: string;
  models?: Record<string, unknown> | unknown[];
}

function mapModelCaps(m: OpenCodeModelInfo): ModelCaps {
  const input = m.capabilities?.input || [];
  const has = (kind: string) => input.includes(kind);
  const reasoning = !!m.compatibility?.reasoningField || (m.variants?.length ?? 0) > 0;
  return {
    text: has("text") || input.length === 0,
    image: has("image"),
    pdf: has("pdf"),
    audio: has("audio"),
    video: has("video"),
    reasoning,
    toolcall: m.capabilities?.tools ?? false,
    attachment: input.some((k) => k !== "text"),
    temperature: m.capabilities?.temperature ?? true,
    // 变体清单要存下来：建会话时带了模型不支持的 variant，v2 会直接判这一轮失败
    // （实测 `Variant unavailable for opencode/big-pickle: low`）。
    variants: (m.variants || []).map((v) => v?.id || "").filter(Boolean),
    contextLimit: m.limit?.context,
  };
}

/** 把 `Model.Info[]` 摊平成插件的模型表（供应商名从 /api/provider 拿） */
export function flattenModels(
  models: OpenCodeModelInfo[],
  providers: OpenCodeProviderInfo[] = [],
): FlattenResult {
  const providerNames = new Map<string, string>();
  for (const p of providers) {
    if (!p?.id) continue;
    providerNames.set(p.id, p.name || p.id);
  }

  const result = new Map<string, ModelEntry>();
  const caps: Record<string, ModelCaps> = {};
  for (const m of models || []) {
    if (!m) continue;
    if (m.enabled === false) continue;
    if (m.status === "deprecated") continue;

    const providerID = m.providerID || "";
    let modelId = m.modelID || m.id || m.name || "";
    if (typeof modelId === "string" && modelId.includes("/")) {
      modelId = modelId.split("/").slice(-1)[0] || modelId;
    }
    if (!modelId) continue;
    const fullId = providerID ? `${providerID}/${modelId}` : modelId;
    if (result.has(fullId)) continue;
    const providerName = providerNames.get(providerID) || providerID;
    result.set(fullId, { id: fullId, displayName: `${providerName} · ${m.name || modelId}` });
    caps[fullId] = mapModelCaps(m);
  }
  return {
    models: [...result.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    caps,
  };
}

function toRawModelEntries(rawModels: unknown): RawModelEntry[] {
  const entries = Array.isArray(rawModels) ? rawModels : Object.values(rawModels as Record<string, unknown>);
  return entries.map((m) => {
    const mm = m as Record<string, unknown>;
    return {
      id: (mm.id as string) || (mm.name as string) || "",
      name: (mm.name as string) || (mm.id as string) || "",
      enabled: mm.enabled as boolean | undefined,
      capabilities: mm.capabilities as RawModelEntry["capabilities"],
    };
  });
}

/** 从配置文件（v1 风格）里兜底提取模型 */
export function extractModelsFromConfig(parsed: Record<string, unknown>): ModelEntry[] {
  const result = new Map<string, ModelEntry>();
  const providers = (parsed?.providers ?? parsed?.profiles ?? {}) as Record<string, unknown>;
  for (const [providerId, cfg] of Object.entries(providers)) {
    const pc = cfg as ProviderConfig;
    const providerName = pc.name || providerId;
    const entries: RawModelEntry[] = toRawModelEntries(pc.models ?? {});
    for (const m of entries) {
      if (!m.id) continue;
      const modelId = m.id.includes("/") ? m.id : `${providerId}/${m.id}`;
      if (!result.has(modelId)) result.set(modelId, { id: modelId, displayName: `${providerName} · ${m.name || m.id}` });
    }
  }
  if (result.size === 0 && Array.isArray(parsed?.models)) {
    for (const m of parsed.models as Array<string | Record<string, string>>) {
      const rawId = typeof m === "string" ? m : (m.id || m.name || "");
      if (rawId && !result.has(rawId)) result.set(rawId, { id: rawId, displayName: rawId });
    }
  }
  return [...result.values()];
}

/** 配置里的 `model` 可能是字符串，也可能是 `{providerID, modelID}` */
function normalizeModelRef(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const o = value as { providerID?: unknown; modelID?: unknown };
    const providerID = typeof o.providerID === "string" ? o.providerID : "";
    const modelID = typeof o.modelID === "string" ? o.modelID : "";
    if (modelID) return providerID ? `${providerID}/${modelID}` : modelID;
  }
  return "";
}

/** 找出 OpenCode 实际使用的默认模型 */
export function resolveDefaultModel(modelIds: string[], configs: Record<string, unknown>[]): string {
  if (!modelIds.length) return "";
  const known = new Set(modelIds);
  const readKey = (key: string): string[] => configs.map((c) => normalizeModelRef(c?.[key])).filter((v) => v !== "");
  const candidates = [...readKey("model"), ...readKey("small_model")];
  for (const ref of candidates) {
    if (known.has(ref)) return ref;
    const hit = modelIds.find((id) => id.slice(id.indexOf("/") + 1) === ref);
    if (hit) return hit;
  }
  return modelIds[0];
}

/**
 * v2 的 agent 标识是 `Agent.Info.id`（例如 `build`），`name` 只是展示名。
 */
export function filterAgents(agents: OpenCodeAgentInfo[]): { id: string; name: string; description?: string }[] {
  return (agents || [])
    .filter((a) => a && !a.hidden)
    .map((a) => ({ id: a.id, name: a.name || a.id, description: a.description }));
}

/** 连不上服务时返回空结果，而不是抛错——状态卡片要能安静地显示“未连接” */
function emptyModels(): { models: ModelEntry[]; caps: Record<string, ModelCaps>; defaultModel: string } {
  return { models: [], caps: {}, defaultModel: "" };
}

/** 从 OpenCode 服务拉取模型列表 */
export async function fetchOpenCodeModelsFromCLI(
  _opencodePath: string,
  _vaultDir: string,
  port?: number,
  hostname?: string,
): Promise<{ models: ModelEntry[]; caps: Record<string, ModelCaps>; defaultModel: string }> {
  const conn = await findOpenCodeConnection(port || DEFAULT_OPENCODE_PORT, hostname || "127.0.0.1");
  if (!conn) return emptyModels();

  try {
    const [models, providers, config] = await Promise.all([
      httpGetOpenCode(conn.url, "/model", conn.authHeader) as Promise<OpenCodeModelInfo[] | null>,
      httpGetOpenCode(conn.url, "/provider", conn.authHeader) as Promise<OpenCodeProviderInfo[] | null>,
      httpGetOpenCode(conn.url, "/config", conn.authHeader).catch(() => null),
    ]);
    if (!models || !Array.isArray(models)) return emptyModels();
    const flat = flattenModels(models, Array.isArray(providers) ? providers : []);
    const cfgList = Array.isArray(config) ? (config as Record<string, unknown>[]) : config ? [config as Record<string, unknown>] : [];
    return {
      models: flat.models,
      caps: flat.caps,
      defaultModel: resolveDefaultModel(flat.models.map((m) => m.id), cfgList),
    };
  } catch (err: unknown) {
    console.warn("[xiaoyuanAgent] 读取 OpenCode 模型失败:", err);
    return emptyModels();
  }
}

/** 从 OpenCode 服务拉取 agent 列表 */
export async function fetchOpenCodeAgents(
  _opencodePath: string,
  _vaultDir: string,
  port?: number,
  hostname?: string,
): Promise<OpenCodeAgentInfo[]> {
  const conn = await findOpenCodeConnection(port || DEFAULT_OPENCODE_PORT, hostname || "127.0.0.1");
  if (!conn) return [];
  try {
    const agents = (await httpGetOpenCode(conn.url, "/agent", conn.authHeader)) as OpenCodeAgentInfo[] | null;
    return Array.isArray(agents) ? agents : [];
  } catch (err: unknown) {
    console.warn("[xiaoyuanAgent] 读取 OpenCode agent 失败:", err);
    return [];
  }
}

/** 检测 OpenCode CLI 是否可用，并读版本号 */
export async function checkOpenCodeStatus(
  opencodePath: string,
  _vaultDir: string,
  port?: number,
  hostname?: string,
): Promise<{ ok: boolean; version: string; bin: string; error?: string }> {
  const bin = await resolveOpenCodePath(opencodePath);
  const version = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const p = spawn(bin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    p.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    p.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const settle = () => {
      if (done) return;
      done = true;
      resolve(out.trim());
    };
    p.on("error", settle);
    p.on("close", settle);
    setTimeout(settle, 5000);
  });

  const m = version.match(/(\d+\.\d+\.\d+)/);
  if (!m) {
    return { ok: false, version: "", bin, error: version || "opencode 未安装或不可用" };
  }
  // 顺带看看服务在不在，不在也算“CLI 可用”，只是没连上
  const conn = await findOpenCodeConnection(port || DEFAULT_OPENCODE_PORT, hostname || "127.0.0.1");
  return { ok: true, version: m[1], bin, error: conn ? undefined : "未找到运行中的 OpenCode 服务" };
}

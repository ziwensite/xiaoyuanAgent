import type { ModelCaps, XiaoyuanAgentSettings, OpenCodeAgentInfo } from "./types";
import { fetchOpenCodeModelsFromCLI, fetchOpenCodeAgents } from "./opencode-config";

/**
 * 把 OpenCode 的模型 / agent 同步进插件设置。
 *
 * 只在缓存为空或调用方显式 force 时才真正去拉；并且**连不上就保持原样返回 null**，
 * 绝不把已有缓存清掉——否则断网的时候模型列表会整个消失。
 */

export interface SyncModelsResult {
  models: { label: string; value: string }[];
  caps: Record<string, ModelCaps>;
  defaultModel: string;
}

/** 同步只用到插件的这几样东西，收窄类型而不是到处 `any` */
export interface SyncPlugin {
  settings?: XiaoyuanAgentSettings;
  saveSettings?: () => Promise<void> | void;
  app?: {
    workspace?: {
      getLeavesOfType?: (type: string) => { view?: unknown }[];
    };
  };
}

/** 同一时刻只跑一次，避免状态卡 / 设置页 / 工具栏并发刷新 */
let modelsPromise: Promise<SyncModelsResult | null> | null = null;
let agentsPromise: Promise<OpenCodeAgentInfo[] | null> | null = null;

/** 同步 agent 列表 */
export async function ensureOpenCodeAgents(opts: {
  plugin: SyncPlugin;
  force?: boolean;
  silent?: boolean;
  reason?: string;
}): Promise<OpenCodeAgentInfo[] | null> {
  const s = opts.plugin?.settings;
  if (!s) return null;
  if (!opts.force && s.opencodeAgents?.length) return s.opencodeAgents;
  if (agentsPromise) return agentsPromise;

  agentsPromise = (async () => {
    try {
      const agents = await fetchOpenCodeAgents(
        s.opencode.cliPath,
        "",
        s.opencode.port,
        s.opencode.hostname,
      );
      if (!agents.length) return null;
      s.opencodeAgents = agents;
      await opts.plugin.saveSettings?.();
      return agents;
    } catch (err: unknown) {
      if (!opts.silent) console.warn("[xiaoyuanAgent] 同步 OpenCode agent 失败:", err);
      return null;
    } finally {
      agentsPromise = null;
    }
  })();
  return agentsPromise;
}

/** 同步模型列表（含能力表与默认模型） */
export async function ensureOpenCodeModels(opts: {
  plugin: SyncPlugin;
  force?: boolean;
  silent?: boolean;
  reason?: string;
}): Promise<SyncModelsResult | null> {
  const s = opts.plugin?.settings;
  if (!s) return null;
  // 已有缓存且没要求强制刷新时，直接用缓存，别每次都打服务端。
  // 例外：老缓存里没有 variants（变体清单是后来才加的），得重新拉一次，
  // 否则建会话时无从判断哪些 variant 是模型真的支持的。
  const cachedCaps = s.opencodeModelCaps;
  const capsStale = !cachedCaps || Object.values(cachedCaps).some((c) => !c || !Array.isArray(c.variants));
  if (!opts.force && s.opencodeModels?.length && !capsStale) {
    return {
      models: s.opencodeModels,
      caps: s.opencodeModelCaps ?? {},
      defaultModel: s.opencode.model || "",
    };
  }
  if (modelsPromise) return modelsPromise;

  modelsPromise = (async () => {
    try {
      const res = await fetchOpenCodeModelsFromCLI(
        s.opencode.cliPath,
        "",
        s.opencode.port,
        s.opencode.hostname,
      );
      if (!res || !res.models.length) return null;

      const models = res.models.map((m) => ({ label: m.displayName, value: m.id }));
      s.opencodeModels = models;
      s.opencodeModelCaps = res.caps;
      // 只在用户还没选过模型时填默认，别把用户的选择冲掉
      if (res.defaultModel && !s.opencode.model) s.opencode.model = res.defaultModel;
      await opts.plugin.saveSettings?.();
      return { models, caps: res.caps, defaultModel: res.defaultModel };
    } catch (err: unknown) {
      if (!opts.silent) console.warn("[xiaoyuanAgent] 同步 OpenCode 模型失败:", err);
      return null;
    } finally {
      modelsPromise = null;
    }
  })();
  return modelsPromise;
}

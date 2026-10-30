import { ensureOpenCodeServer, findOpenCodeConnection } from "./opencode-server";
import { getActiveProvider } from "./constants";
import type { AgentChannel, XiaoyuanAgentSettings } from "./types";
import { healthCheck } from "./opencode-client";

/** 只允许 http/https：避免把 API Key 发到 `file://`、`javascript:` 之类地址 */
function isSafeHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * 探一下 provider 的 `/models`：能通就说明 Base URL 和 Key 都对。
 *
 * 设置面板的「测试连接」和状态卡片共用这一份，别各写一遍 ——
 * 之前两处的超时、斜杠处理、鉴权头就是复制出来的。
 */
export async function probeProvider(provider: { baseUrl: string; apiKey: string }): Promise<boolean> {
  if (!provider.baseUrl || !provider.apiKey) return false;
  if (!isSafeHttpUrl(provider.baseUrl)) {
    console.warn("[xiaoyuanAgent] 已拒绝非 http(s) 的 API 地址:", provider.baseUrl);
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const modelsUrl = provider.baseUrl.replace(/\/+$/, "") + "/models";
    const resp = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    // 不读响应体就丢开连接，socket 会一直挂到 GC 才释放
    resp.body?.cancel().catch(() => {});
    return resp.ok;
  } catch (err: unknown) {
    // 旧实现 `catch {}` 什么都不留，「测试连接」失败时完全查不到原因
    console.warn("[xiaoyuanAgent] provider 探测失败:", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取 provider 的模型列表（OpenAI 兼容的 `GET {baseUrl}/models`）。
 *
 * 用于设置页「在线获取模型」：不用手敲模型名，从服务端清单里选。
 * 失败返回 null（连不上 / 鉴权失败 / 响应格式不对都归这里），由调用方提示。
 */
export async function fetchProviderModels(provider: { baseUrl: string; apiKey: string }): Promise<string[] | null> {
  if (!provider.baseUrl || !provider.apiKey) return null;
  if (!isSafeHttpUrl(provider.baseUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const modelsUrl = provider.baseUrl.replace(/\/+$/, "") + "/models";
    const resp = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      resp.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await resp.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(body?.data)) return null;
    // 只收字符串 id，去重并按字典序排一下，列表好找
    const ids = body.data.map((m) => m?.id).filter((v): v is string => typeof v === "string" && !!v);
    return [...new Set(ids)].sort();
  } catch (err: unknown) {
    console.warn("[xiaoyuanAgent] 拉取 provider 模型列表失败:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCLIConnections(settings: XiaoyuanAgentSettings): Promise<string[]> {
  const existing = await findOpenCodeConnection(settings.opencode.port, settings.opencode.hostname);
  if (!existing) return [];
  const ok = await healthCheck(existing.url, existing.authHeader);
  if (!ok) return [];
  return [existing.url.replace(/\/$/, "")];
}

export async function checkConnection(
  settings: XiaoyuanAgentSettings,
  vaultDir: string,
  mode: AgentChannel = "cli",
  /** 状态卡只做"探测"，绝不能顺带拉起服务（否则打开设置要等 8 轮 × 30s 启动） */
  startIfNeeded = true,
): Promise<boolean> {
  if (mode === "cli") {
    const urls = await getCLIConnections(settings);
    if (urls.length > 0) return true;
    if (startIfNeeded && settings.opencode.autoStart) {
      try {
        await ensureOpenCodeServer(
          settings.opencode.cliPath,
          settings.opencode.hostname,
          settings.opencode.port,
          vaultDir,
          true,
        );
        return true;
      } catch (err: unknown) {
        console.warn("[xiaoyuanAgent] OpenCode 服务启动失败:", err);
      }
    }
    return false;
  }

  const provider = getActiveProvider(settings);
  if (!provider) return false;
  return probeProvider(provider);
}

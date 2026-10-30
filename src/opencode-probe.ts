import type { ServerConn } from "./opencode-client";
import { getServerInfo, httpGetOpenCode } from "./opencode-client";

/**
 * 服务端接口能力自检。
 *
 * 逐项探测插件真正依赖的 v2 接口（实测契约见 opencode-config.ts 注释），
 * 结果给设置里的状态卡片显示。critical=true 的能力挂了基本就没法用。
 */

/** 单项能力的探测结果 */
export interface CapabilityResult {
  /** 稳定的机器可读标识 */
  key: string;
  /** 是否通过 */
  ok: boolean;
  /** 补充信息（版本号、数量、错误原因……） */
  detail: string;
  /** 该能力是不是插件的核心依赖（核心能力挂了基本没法用） */
  critical: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** 逐项探测插件依赖的 v2 接口 */
export async function probeOpenCodeCapabilities(
  conn: ServerConn,
  _directory?: string,
): Promise<CapabilityResult[]> {
  const results: CapabilityResult[] = [];

  // 1) 服务信息（版本）
  try {
    const info = await getServerInfo(conn.url, conn.authHeader);
    results.push({
      key: "info",
      ok: !!info?.version,
      detail: info?.version ? `v${info.version}` : "无版本号",
      critical: true,
    });
  } catch (err: unknown) {
    results.push({ key: "info", ok: false, detail: errText(err), critical: true });
  }

  // 2) 模型列表
  try {
    const models = await httpGetOpenCode(conn.url, "/model", conn.authHeader);
    const n = isArray(models) ? models.length : 0;
    results.push({
      key: "model",
      ok: n > 0,
      detail: n > 0 ? `${n} 个模型` : "空",
      critical: true,
    });
  } catch (err: unknown) {
    results.push({ key: "model", ok: false, detail: errText(err), critical: true });
  }

  // 3) agent 列表
  try {
    const agents = await httpGetOpenCode(conn.url, "/agent", conn.authHeader);
    const n = isArray(agents) ? agents.length : 0;
    results.push({ key: "agent", ok: n > 0, detail: n > 0 ? `${n} 个 agent` : "空", critical: false });
  } catch (err: unknown) {
    results.push({ key: "agent", ok: false, detail: errText(err), critical: false });
  }

  // 4) 供应商列表
  try {
    const providers = await httpGetOpenCode(conn.url, "/provider", conn.authHeader);
    const n = isArray(providers) ? providers.length : 0;
    results.push({ key: "provider", ok: n > 0, detail: n > 0 ? `${n} 个供应商` : "空", critical: false });
  } catch (err: unknown) {
    results.push({ key: "provider", ok: false, detail: errText(err), critical: false });
  }

  // 5) 会话数据读取 —— 流式轮询依赖它（渲染进程 fetch 走 SSE 会被 CORS 拦，
  //    所以插件实际用的是 requestUrl 轮询，这里验证轮询链路能读到数据）
  try {
    const sessions = await httpGetOpenCode(conn.url, "/session", conn.authHeader);
    const n = Array.isArray(sessions) ? sessions.length : -1;
    results.push({
      key: "event",
      ok: n >= 0,
      detail: n >= 0 ? `会话可读（${n} 条）· 流式走轮询` : `返回格式异常：${typeof sessions}`,
      critical: true,
    });
  } catch (err: unknown) {
    results.push({ key: "event", ok: false, detail: errText(err), critical: true });
  }

  return results;
}

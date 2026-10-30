import { t } from "./i18n";

/** 单条 SSE 事件的原始行（去掉 `data:` 前缀后按换行拼接） */
function parseSseFrames(buffer: string, onFrame: (payload: string) => void): string {
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const payloads: string[] = [];
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue; // 空行 / 注释心跳
      if (trimmed.startsWith("data:")) payloads.push(trimmed.slice(5).trim());
    }
    if (payloads.length) onFrame(payloads.join("\n"));
    boundary = rest.indexOf("\n\n");
  }
  return rest;
}

export async function callAIWithAPI(
  apiEndpoint: string,
  apiKey: string,
  model: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  maxTokens: number,
  temperature: number,
  stream = false,
  signal?: AbortSignal,
  reasoningEffort?: string,
  timeoutMs = 0,
): Promise<Response> {
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens, temperature, stream };
  if (reasoningEffort && reasoningEffort !== "none") {
    body.reasoning_effort = reasoningEffort;
  }
  const resp = await fetch(apiEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // 只依赖调用方传入的 signal 时，忘记传就永远挂住；这里兜一个内部超时
    signal: timeoutMs > 0 ? combineAbort(signal, timeoutMs) : signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return resp;
}

/**
 * 把外部 signal 与超时合并成一个（超时后自动 abort）。
 * 不用 `AbortSignal.any` / `AbortSignal.timeout`：旧版 Electron 里不一定有。
 */
export function combineAbort(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const dispose = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => ctrl.abort(signal?.reason);
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      dispose();
      ctrl.abort(signal.reason);
      return ctrl.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const origAbort = ctrl.abort.bind(ctrl);
  ctrl.abort = (reason?: unknown) => {
    dispose();
    origAbort(reason);
  };
  return ctrl.signal;
}

export async function processAPISSEStream(
  resp: Response,
  onThinking?: (text: string) => void,
  onTextUpdate?: (text: string) => void,
): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error(t("error.noResponseBody"));
  const decoder = new TextDecoder("utf-8");
  let fullContent = "";
  let fullThinking = "";
  let buffer = "";

  const read = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return fullContent || fullThinking || t("error.emptyResponse");
    // TCP 分块可能把一条 `data:` 切成两半。旧实现直接按行解析并把
    // JSON.parse 的失败吞掉，那一半正文就永久丢了。这里保留尾部残留，
    // 只在拿到完整帧（空行）时才提交解析。
    const chunk = decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    buffer += chunk;
    buffer = parseSseFrames(buffer, (payload) => {
      if (payload === "[DONE]") return;
      try {
        const data = JSON.parse(payload) as {
          choices?: { delta?: { reasoning_content?: string; content?: string } }[];
        };
        const delta = data.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          fullThinking += delta.reasoning_content;
          onThinking?.(fullThinking);
        }
        if (delta?.content) {
          fullContent += delta.content;
          onTextUpdate?.(fullContent);
        }
      } catch (err) {
        // 静默 catch 会让丢正文变得完全不可见，至少留一条 warn
        console.warn("[xiaoyuanAgent] API 流式事件解析失败:", err);
      }
    });
    return read();
  };
  return read();
}

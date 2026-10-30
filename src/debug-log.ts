import * as fs from "fs";
import * as path from "path";
import type { App } from "obsidian";

/**
 * 调试输出的落盘位置。
 *
 * 一律走 Obsidian 自己的文件接口（`adapter.write`）—— 最稳，
 * 插件目录读写权限、路径转义都由 Obsidian 兜底，落盘路径与插件目录一致。
 *
 * 以前还有一路「绕过 adapter 用 fs 直接写库内 `.obsidian/plugins/...`」的兜底，
 * 那会绕过 Obsidian 的写入协调，直接把同步冲突文件（`.sync-conflict-*.json`）
 * 拉进用户的同步盘。这里只保留插件自身目录（CommonJS 下 `__dirname`）作为最后退路。
 */
let appRef: App | null = null;

/** 插件启动时把 App 交进来，调试文件才有得写。 */
export function initDebugLog(app: App): void {
  appRef = app;
}

/** 往插件目录里写一个文件（失败只记日志，不打扰用户）。 */
export async function writeDebugFile(file: string, content: string): Promise<void> {
  // ① Obsidian 的文件接口 —— 最可靠的一条路
  const adapter = appRef?.vault?.adapter;
  if (adapter) {
    try {
      await adapter.write(`.obsidian/plugins/xiaoyuanAgent/${file}`, content);
      return;
    } catch (e) {
      console.warn("[xiaoyuanAgent] 调试文件写入失败:", e);
    }
  }

  // ② 插件自己的目录（CommonJS 环境下 __dirname 就是插件目录）
  try {
    const dir = typeof __dirname === "string" ? __dirname : "";
    if (dir) {
      // 用异步 fs：调试输出不该同步阻塞主线程
      await fs.promises.writeFile(path.join(dir, file), content, "utf8");
    }
  } catch (e) {
    console.warn("[xiaoyuanAgent] 调试文件写入失败:", e);
  }
}

/**
 * 把一次弹层的真实几何写到磁盘。
 *
 * 设置面板里的弹层最容易出幺蛾子（弹窗、滚动区、层叠顺序三重约束），
 * 光看代码猜不出来；落一份快照下来，对着真实数值排查比在控制台里手抄靠谱。
 */
export function dumpPopupGeometry(snapshot: unknown): void {
  void writeDebugFile("xyag-popup-debug.json", JSON.stringify(snapshot, null, 2));
}

/**
 * 记下「现在跑的是哪一版」。
 *
 * 插件热重载之后，Obsidian 里看到的界面可能还是旧的（设置面板不会重建），
 * 这时候光靠猜没用 —— 落个版本号到磁盘，一看就知道用户那边跑的是不是新包。
 */
export function writeBuildStamp(version: string, extra?: Record<string, unknown>): void {
  void writeDebugFile(
    "xyag-build.json",
    JSON.stringify(
      {
        version,
        loadedAt: new Date().toISOString(),
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        ...extra,
      },
      null,
      2,
    ),
  );
}

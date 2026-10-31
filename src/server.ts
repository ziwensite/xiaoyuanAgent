// 库根目录（Node 侧 fs 操作的基准）。
// 只通过 get/set 暴露：导出的可变绑定一旦被外部直接读，就会绕过 set 的一致性处理。
let vaultBasePath = "";

export function setVaultBasePath(path: string) {
  vaultBasePath = path;
}

export function getVaultBasePath(): string {
  return vaultBasePath;
}

// 工作区目录：AI（OpenCode 会话）实际操作的目录。
// 默认等于库根目录；用户在聊天顶栏切换后指向任意目录。
// 与 vaultBasePath 分离：聊天历史、日志等插件自身数据永远写库内，不跟工作区走。
let workspacePath = "";

export function setWorkspacePath(path: string) {
  workspacePath = path;
}

/** AI 的工作目录：用户设置的工作区，未设置时回落到库根目录 */
export function getWorkspaceDir(): string {
  return workspacePath || vaultBasePath;
}

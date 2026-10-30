// 库根目录（Node 侧 fs 操作的基准）。
// 只通过 get/set 暴露：导出的可变绑定一旦被外部直接读，就会绕过 set 的一致性处理。
let vaultBasePath = "";

export function setVaultBasePath(path: string) {
  vaultBasePath = path;
}

export function getVaultBasePath(): string {
  return vaultBasePath;
}

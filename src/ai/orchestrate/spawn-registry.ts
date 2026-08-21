/**
 * RB-SV-P2-1：per-book spawn 运行闸（与 self-heal 的 running Map 同模式）——
 * 双标签页时序窗口并发双 spawn 会互相覆写草稿回流。占位在首个 await 前同步完成
 * （比 auto-write 的「检查→await→二次检查」更严，无 TOCTOU 窗口），终态 finally 释放。
 *
 * M-2（第八轮）：从 stream.ts 移驻 ai 层——chat 的嵌套生成工具闸（turns.ts 的
 * AI_GEN_TOOLS / write_chapter）需要查 spawn 在途（手动写稿同样按章记账、与
 * 嵌套生成互覆草稿），ai 编排层不得反向 import server 路由层，闸随依赖就位；
 * stream.ts 再导出 isSpawnRunning/__setSpawnRunning，server 侧既有导入（books/
 * audit/测试）不变。
 */
const spawnRunning = new Map<string, true>()

/** 本书是否正在手动写稿（spawn 在途） */
export function isSpawnRunning(bookName: string): boolean {
  return spawnRunning.has(bookName)
}

/** 占闸（/spawn 路由在首个 await 前同步调用，无 TOCTOU） */
export function holdSpawnGate(bookName: string): void {
  spawnRunning.set(bookName, true)
}

/** 释放闸（终态 finally；未占位时幂等） */
export function releaseSpawnGate(bookName: string): void {
  spawnRunning.delete(bookName)
}

/** 测试用：直接置/清 spawn 运行闸（并发 409 用例的确定性夹具，同 __clearDocumentServices 风格）。 */
export function __setSpawnRunning(bookName: string, running: boolean): void {
  if (running) spawnRunning.set(bookName, true)
  else spawnRunning.delete(bookName)
}

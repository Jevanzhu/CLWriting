/**
 * R0910-W：e2e 临时目录清理的 Windows 韧性封装。
 *
 * 背景：e2e 各 spec 的 afterAll 用裸 `rmSync(dir, { recursive: true, force: true })`
 * 清临时 workDir/userData 目录。Windows 上目录内文件句柄（典型：node:sqlite 的
 * `.cache/index.db`）的关闭是异步收尾——即便 server.close() 回调已 resolve，句柄
 * 仍可能短暂存活，此刻 rmSync 抛 `ENOTEMPTY`（目录项已列但删不掉）/`EPERM`/`EBUSY`。
 * 实测 ai-degrade.spec.ts 3 次隔离重跑挂 1 次的病根即此（残件
 * `<workDir>/长篇/长篇测试书/.cache/index.db`）。根因已由 server.close 自包含化修掉
 * （在途 SSE/worker 有界等待），本封装是第二道防线：句柄关闭本就是异步竞态，
 * 数量级毫秒级，重试几次即可，不必让整套 e2e 因此炸。
 *
 * 口径（不得放宽）：
 * - 只重试瞬时 errno（ENOTEMPTY/EPERM/EBUSY）；其余错误（如 ENOENT 之外的权限、
 *   路径非法）立即原样抛出——不吞真故障、不假绿。
 * - 重试耗尽仍抛最后一个错误（fail loud）：真正的句柄泄漏照旧红，绝不静默放行。
 * - 退避总时长有界（默认 6 次 × 25ms = 最坏 125ms，远低于「几百毫秒」上限），
 *   不引入长墙钟 sleep；同步退避用 Atomics.wait，零依赖。
 */
import { rmSync } from 'node:fs'

/** 瞬时、可重试的删除失败 errno（句柄关闭竞态族）；其余一律直抛 */
const TRANSIENT_RM_CODES = new Set(['ENOTEMPTY', 'EPERM', 'EBUSY'])

// 同步退避：Node 主线程无可用的同步 sleep，Atomics.wait 在共享缓冲上即得
// （e2e hook 为同步/await 上下文，无法在此处 await，故用同步实现）。
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

export interface RmTempDirOptions {
  /** 最多尝试次数（含首次），默认 6；最后一击仍失败即抛 */
  attempts?: number
  /** 每次重试前的同步退避毫秒数，默认 25（总退避 = (attempts-1) × delayMs） */
  delayMs?: number
}

/**
 * 带瞬时 errno 重试的递归删除（e2e 临时目录专用）。
 * 目录不存在时因 `force: true` 视作成功；其余非瞬时错误立即抛出。
 */
export function rmTempDirRetry(dir: string, opts: RmTempDirOptions = {}): void {
  const attempts = opts.attempts ?? 6
  const delayMs = opts.delayMs ?? 25
  for (let i = 1; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // 非瞬时错误、或重试已耗尽：原样抛出（不吞真故障）
      if (!code || !TRANSIENT_RM_CODES.has(code) || i >= attempts) throw e
      // R0910-W：瞬时竞态——等一个极短退避后重试
      sleepSync(delayMs)
    }
  }
}

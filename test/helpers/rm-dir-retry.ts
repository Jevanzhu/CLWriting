/**
 * 临时目录递归删除的单源原语：瞬时 errno 有界重试 + 收口必留痕。
 *
 * 语义契约（消费面共用一套，不各自放宽）：
 * - 只重试瞬时 errno（ENOTEMPTY/EPERM/EBUSY——句柄关闭竞态族：目录项已列出但删不掉，
 *   占用者毫秒级后释放）；其余错误码（无 code、EACCES 等确定性错误）不重试，立即收口。
 * - 尝试次数有界：最多 attempts 次（含首次），每次失败后同步退避 delayMs，总退避
 *   (attempts-1)×delayMs——不引入长墙钟 sleep。
 * - 收口前必留痕一行（console.warn，含目标路径与最后一次 errno）：不存在静默路径。
 *   之后按 onExhausted 分档——'throw' 原样上抛（真句柄泄漏照旧红），'warn' 吞掉
 *   （清理是失败路径上的兜底，不改写用例自身结果）。
 * - 目标路径不存在时按 force:true 视作成功。
 *
 * 本档零 vitest 依赖（Playwright 语境无 vitest 钩子，e2e 与 vitest 侧同源消费这一份）。
 */
import { rmSync } from 'node:fs'

/** 瞬时、可重试的删除失败 errno（句柄关闭竞态族）。 */
const TRANSIENT_RM_CODES: ReadonlySet<string> = new Set(['ENOTEMPTY', 'EPERM', 'EBUSY'])

// 同步退避：Node 主线程无同步 sleep，Atomics.wait 在共享缓冲上即得。本原语是同步签名
// （调用面含同步收尾 hook），故不改为 await 形态。
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

export interface RmDirRetryOptions {
  /** 最多尝试次数（含首次），默认 6；末次仍失败即收口。 */
  attempts?: number
  /** 每次重试前的同步退避毫秒数，默认 25。 */
  delayMs?: number
  /** 收口语义：'throw' 上抛最后一次错误（默认）；'warn' 留痕后吞。 */
  onExhausted?: 'throw' | 'warn'
  /** 删除实现（注入失败桩用），默认 `rmSync(dir, { recursive: true, force: true })`。 */
  rm?: (dir: string) => void
}

/** 瞬时 errno 有界重试的递归删除；收口语义与留痕格式见文件头注。 */
export function rmDirRetry(dir: string, opts: RmDirRetryOptions = {}): void {
  const attempts = opts.attempts ?? 6
  const delayMs = opts.delayMs ?? 25
  const rm = opts.rm ?? ((d: string) => rmSync(d, { recursive: true, force: true }))
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== undefined && TRANSIENT_RM_CODES.has(code) && attempt < attempts) {
        sleepSync(delayMs)
        continue
      }
      console.warn(`[rm-dir-retry] 删除失败（尝试 ${attempt} 次，最后 ${code ?? '无 errno'}）：${dir}`)
      if (opts.onExhausted === 'warn') return
      throw e
    }
  }
}

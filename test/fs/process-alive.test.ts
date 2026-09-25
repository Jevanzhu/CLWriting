/**
 * R0916-7-P3-3（2026-09-16 评审修复批）：isProcessAlive 新家导出面直测。
 *
 * 被测行为：存活探测（process.kill(pid,0)；ESRCH = 死，EPERM = 存在但属他人 → 按存活）
 * 自 fs/cross-process-lock.ts 拆至 fs/process-alive.ts 后语义逐位不变，且
 * ① 旧家 re-export 与新家是**同一函数对象**（events/task-gate 的既有 import 面不断）；
 * ② 锁模块与 atomic 清扫各自消费同一实现（新家单一真相源）。
 */
import { describe, expect, it } from 'vitest'
import { isProcessAlive } from '../../src/fs/process-alive.js'
import { isProcessAlive as lockHomeAlive } from '../../src/fs/cross-process-lock.js'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, existsSync, utimesSync } from 'node:fs'

describe('fs/process-alive：isProcessAlive 导出面（R0916-7-P3-3）', () => {
  it('本进程 pid 必活（真探测，不注入）', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('不存在的 pid 判死（ESRCH → false；取高位 pid 避让系统复用）', () => {
    expect(isProcessAlive(0x7ffffff)).toBe(false)
  })

  it('非正 pid 不误判为活（process.kill 抛 ESRCH/EINVAL → false）', () => {
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('旧家（cross-process-lock）re-export 与新家同一函数对象（events/task-gate import 面不断）', () => {
    expect(lockHomeAlive).toBe(isProcessAlive)
  })

  it('atomic 清扫消费同一探测：活 pid 名下超龄 .lock 不被误清（新家口径到达清零路径）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-alive-'))
    const lock = join(dir, '.样本.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, bootTime: 1 }))
    const old = Date.now() / 1000 - 3600
    utimesSync(lock, old, old) // 超龄（> 10min 门槛）但持有进程仍活 → 不清
    expect(sweepAbandonedTmpFiles(dir)).toBe(0)
    expect(existsSync(lock)).toBe(true)
  })
})

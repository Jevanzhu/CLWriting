/**
 * R1010b-AI-P2-1（2026-09-10 内存专项重审修复批）回归：批量暂停记录的 detached 落盘
 * 收编 per-book 后台任务表。
 *
 * 修复前：orchestrateBatch 的 recordPause 是裸 fire-and-forget（void + catch）——
 * writeBatchPause 先抢跨进程锁（竞争下最长 2s 轮询）再 mkdirSync + 原子写，而
 * waitSelfHealSettled 只等编排本体：锁竞争使写在途时 runSelfHeal 已返回，books.ts
 * 删书/改名（hasBackgroundTasks → awaitOrchestrationsSettled）等不到这次写，写在
 * 已删/已搬路径恢复后 mkdirSync 重建孤儿目录。同族 detached 写（账本推进草稿）已按
 * M-2 收编，本写漏网。
 *
 * 测试层级（如实记档）：删书端到端无现成装置，测到「后台表登记 + settle 等待覆盖」层
 * ——books.ts 删书/改名（:395/:632）先查 hasBackgroundTasks 再 await
 * awaitOrchestrationsSettled（内含 waitBackgroundTasks，只读核线），登记面被等待面
 * 覆盖即闭合「删书不撞在途暂停写」链。
 *
 * 确定性装置：genFn 钩子落一个本进程在位锁文件（r73-batch-pause-lock 先例：pid 活
 * ⇒ 锁被占；同进程嵌套自锁）——暂停写在该锁上轮询（缺省 PAUSE_LOCK_TIMEOUT_MS=2000，
 * 远大于下方同步断言窗口），断言窗口内写必然在途，无墙钟赛跑；删锁文件释放后写正常
 * 落盘，waitBackgroundTasks 追上并清表。
 */
import { test, expect, vi, describe, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, abortSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { readBatchPause } from '../../src/state/batch-pause.js'
import { hasBackgroundTasks, waitBackgroundTasks } from '../../src/ai/orchestrate/background.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'

vi.mock('../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/calls.js')>()
  return { ...actual, checkAiCallBudget: vi.fn() }
})

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

function makeSave(): typeof saveDraft {
  return async (_bookRoot, _chapter, content) => ({
    relPath: '写作/正文/1-测试章.md',
    docId: 'doc-短篇-1',
    words: content.length,
    snapshotted: false,
  })
}

describe('R1010b-AI-P2-1：批量暂停写登记后台任务表', () => {
  const cleanup: string[] = []
  afterEach(() => {
    while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
  })

  test('批停 recordPause 在途时 hasBackgroundTasks 为真；释放锁后写落盘、等待面覆盖并清表', async () => {
    const workDir = makeDualTrackWorkdir()
    cleanup.push(workDir)
    const bookRoot = join(workDir, '短篇', SHORT_BOOK)
    const lockPath = join(bookRoot, '工作区', '待定稿', '.auto-batch.json.lock')
    const emitted: DriverEvent[] = []
    const genFn = async (): Promise<string> => {
      // 在途窗口装置：本进程在位锁——暂停写在此轮询直到锁超时/释放（见文件头注释）
      mkdirSync(join(bookRoot, '工作区', '待定稿'), { recursive: true })
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
      abortSelfHeal(SHORT_BOOK)
      return '---\n章号: 1\n标题: 测试章\n---\n一章'
    }
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: join(tmpdir(), 'clwriting-test'),
      cwd: workDir,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      chapters: [1],
      save: makeSave(),
      genFn,
    }
    vi.mocked(checkAiCallBudget).mockReturnValue({ ok: true, used: 0, limit: 8 })

    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('aborted')

    // 编排本体已收尾而暂停写必然仍在途（锁在本进程手里）→ 后台表必须有登记（修复前恒 false）
    expect(hasBackgroundTasks(SHORT_BOOK)).toBe(true)

    // 释放锁 → 暂停写落盘 → settle 等待面追上并清表（books.ts 删书/改名的等待链即此层）
    rmSync(lockPath, { force: true })
    await waitBackgroundTasks(SHORT_BOOK)
    const p = readBatchPause(bookRoot)
    expect(p?.atChapter).toBe(1)
    expect(p?.reason).toBe('aborted')
    expect(hasBackgroundTasks(SHORT_BOOK)).toBe(false)
  })
})

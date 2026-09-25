/**
 * 复审-0914-修复批 P3-R3-5：audit DELETE 复查闸（重评二轮-P3-2 的开库 await 窗口
 * 内新起任务拒绝臂）回归。
 *
 * 重评二轮报告 §八原记「开库 await 窗口无注入点可控（3 行薄胶水未单设竞态复现
 * 测试）」——失实记正：store.ts 首开经 acquireCrossProcessLockAsync(
 * sessionMigrateLockPath(...)) 让出，测试侧先持同一把迁移锁即得确定性停走窗
 * （sessionMigrateLockPath / tryAcquireCrossProcessLock 皆导出，零 vi.mock——
 * 注入点是真实生产路径，非测试特设）。窗口内真占 task-gate（chatClearGateReason
 * 六闸第二闸），放行锁后复查命中 → 409；入口时点无闸，本次拒绝只能来自复查臂。
 * 手法：withRouteTable 直调 books.audit.delete handler（r1010b 先例）+ 假 req/res。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processRouteDeps } from './helpers/route-deps.js' // R0916-7-P3-6：路由注入面（生产口径）
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { fakeReqRes } from '../helpers/fake-reqres.js'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerAuditRoutes } from '../../src/studio/server/api/audit.js'
import { openSessionStore, bookHash, sessionMigrateLockPath } from '../../src/events/store.js'
import { stepStartEvent } from '../../src/events/chain-bridge.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

const BOOK = '复查闸书'

interface Rig {
  workDir: string
  userDataPath: string
  bookRoot: string
  auditDelete: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

/** 每用例独立临时书（workDir + 登记 + book.yaml）+ 独立 userData（事件库）。 */
function makeRig(): Rig {
  const workDir = mkdtempTracked(join(tmpdir(), 'clwriting-audit-recheck-'))
  const userDataPath = mkdtempTracked(join(tmpdir(), 'clwriting-audit-recheck-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: `长篇/${BOOK}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', BOOK)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\nhost: cc\n`, 'utf-8')
  const auditDelete = withRouteTable(createRouteTable(), () => {
    registerAuditRoutes({ workDir, userDataPath, ...processRouteDeps() })
    return getRouteSchema('books.audit.delete')!
  })
  return {
    workDir,
    userDataPath,
    bookRoot,
    auditDelete,
    cleanup: () => {
      rmSync(workDir, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    },
  }
}

/** 播种一条工作流侧事件（bookHash 键——闸要保护的清理面）。 */
function seedWorkflowEvent(rig: Rig): void {
  const store = openSessionStore(rig.userDataPath, rig.bookRoot)!
  try {
    const wsSid = store.workspaceSession(bookHash(rig.bookRoot))
    store.appendEvents(wsSid, [stepStartEvent('chat', 'chat')])
  } finally {
    store.close()
  }
}

/** 工作流侧事件计数（再开 store 本身即 handler 侧 finally close / 无锁残留的证明）。 */
function workflowEvents(rig: Rig): number {
  const store = openSessionStore(rig.userDataPath, rig.bookRoot)!
  try {
    return store.listEvents(bookHash(rig.bookRoot)).length
  } finally {
    store.close()
  }
}

function invokeAuditDelete(rig: Rig): {
  done: Promise<unknown>
  captured: { status: number | null; body: string }
} {
  const { req, res, captured } = fakeReqRes()
  // handler 类型为同步/异步联合——Promise.resolve 归一后统一 await
  const done = Promise.resolve(
    rig.auditDelete.handler({ params: { name: BOOK }, input: undefined }, req, res),
  )
  return { done, captured }
}

describe('复审-0914-修复批 P3-R3-5: audit DELETE 开库 await 窗口复查闸（真实迁移锁停走窗）', () => {
  it('窗口内新起任务 → 复查命中 409 拒清，事件原样未清（入口时点无闸）', async () => {
    const rig = makeRig()
    try {
      seedWorkflowEvent(rig)
      // 停走窗：先持首开迁移锁——handler 的 openSessionStoreAsync 让出于同锁获取
      const releaseMigrate = tryAcquireCrossProcessLock(
        sessionMigrateLockPath(rig.userDataPath, rig.bookRoot),
      )
      expect(releaseMigrate).toBeTruthy()

      const { done, captured } = invokeAuditDelete(rig)

      // 窗口内真占 task-gate（六闸第二闸）。次序即确定性：先占闸、再放锁——复查
      // 只能在锁放行（开库返回）后执行，必然看见闸在持
      const releaseGate = acquireTaskGate(BOOK, 'analyze')!
      expect(releaseGate).toBeTruthy()
      releaseMigrate!()

      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { error: string }).error).toContain('任务在跑')
      expect(workflowEvents(rig)).toBe(1) // 未被清掉
      releaseGate()
    } finally {
      rig.cleanup()
    }
  })

  it('对照组：无窗口无闸 → 200 且工作流侧清空（复查不误伤成功路径）', async () => {
    const rig = makeRig()
    try {
      seedWorkflowEvent(rig)
      const { done, captured } = invokeAuditDelete(rig)
      await done
      expect(captured.status).toBe(200)
      expect(workflowEvents(rig)).toBe(0)
    } finally {
      rig.cleanup()
    }
  })
})

/**
 * R0913-B-P2（2026-09-13 服务端端点/摘要簇修复批）回归：PUT /api/books/:name/prefs
 * 临界段书注册重验——books.prefs.put 此前 readJson（body 在途最长 30s）窗口跨越
 * books.ts 删书/改名后，mkdirSync recursive 重建无 book.yaml 幽灵目录 + 布局偏好
 * 静默写旧路径 200 假成功。修复后写前重验（bookMovedFailure 单源，config
 * R0911-B-P3-4 同款）命中回 409 BOOK_MOVED。
 *
 * 手法：镜像 r0911-srv-write-bookmoved——handler 直调（withRouteTable 注册 +
 * getRouteSchema 取 handler）+ 假 req/res；假 req 悬持 body 模拟「入口已过、
 * 临界段未跑」窗口，窗口内删书/改名再放行 body（确定性复现）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeReqRes, waitForBodyArmed } from '../helpers/fake-reqres.js'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerPrefsRoutes } from '../../src/studio/server/api/prefs.js'

interface Rig {
  workDir: string
  bookRoot: string
  prefsPut: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

/** 每用例独立临时书（workDir + 登记 + book.yaml）；prefs 路由注册。 */
function makeBook(name: string): Rig {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-r0913-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', name)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\nhost: cc\n`, 'utf-8')
  const handlers = withRouteTable(createRouteTable(), () => {
    registerPrefsRoutes({ workDir, userDataPath: null })
    return { prefsPut: getRouteSchema('books.prefs.put')! }
  })
  return { workDir, bookRoot, ...handlers, cleanup: () => rmSync(workDir, { recursive: true, force: true }) }
}

/** 窗口内改名（books.ts rename 完成态模拟：登记换新名 + 目录搬走）。 */
function renameBookReg(workDir: string, from: string, to: string): void {
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: to, path: `长篇/${to}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  renameSync(join(workDir, '长篇', from), join(workDir, '长篇', to))
}

/** 窗口内删书（books.ts 删除完成态模拟：登记清空 + 目录移除）。 */
function deleteBookReg(workDir: string, bookRoot: string): void {
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
  rmSync(bookRoot, { recursive: true, force: true })
}

describe('R0913-B-P2: books.prefs.put 临界段书注册重验', () => {
  it('readJson 窗口内书被删 → 409 BOOK_MOVED 且旧路径无幽灵目录复活', async () => {
    const rig = makeBook('重验偏好书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.prefsPut.handler({ params: { name: '重验偏好书' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12） // 悬在 readJson（入口快照已过——正是被修的窗口）
      deleteBookReg(rig.workDir, rig.bookRoot)
      send({ prefs: { pageWidth: 900 } })
      await done
      expect(captured.status).toBe(409)
      const envelope = JSON.parse(captured.body) as { code: string; error: string }
      expect(envelope.code).toBe('BOOK_MOVED')
      expect(typeof envelope.error).toBe('string')
      // mkdirSync recursive / atomicWriteFile 不得对已删路径重建 .clwriting/prefs.json
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('readJson 窗口内书被改名 → 409 BOOK_MOVED 且新旧路径均无本次写残留', async () => {
    const rig = makeBook('重验改名书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.prefsPut.handler({ params: { name: '重验改名书' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      renameBookReg(rig.workDir, '重验改名书', '重验改名书乙')
      send({ prefs: { pageWidth: 900 } })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // 布局偏好不静默写旧路径：旧根无 .clwriting/prefs.json，新根也无本次写入
      expect(existsSync(join(rig.bookRoot, '.clwriting', 'prefs.json'))).toBe(false)
      expect(existsSync(join(rig.workDir, '长篇', '重验改名书乙', '.clwriting', 'prefs.json'))).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('无移书时 PUT 照常 200（重验不改变成功路径语义）', async () => {
    const rig = makeBook('重验常态书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.prefsPut.handler({ params: { name: '重验常态书' }, input: undefined }, req, res)
      send({ prefs: { pageWidth: 900 } })
      await done
      expect(captured.status).toBe(200)
      expect(JSON.parse(captured.body)).toEqual({ ok: true, revision: 1 })
      // 布局键照常落盘（合并写 + revision 保留键语义不变）
      const raw = readFileSync(join(rig.bookRoot, '.clwriting', 'prefs.json'), 'utf-8')
      expect(raw).toContain('pageWidth')
      expect(raw).toContain('"revision": 1')
    } finally {
      rig.cleanup()
    }
  })
})

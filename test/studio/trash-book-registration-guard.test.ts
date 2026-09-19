/**
 * 回收站端点书注册重验回归（2026-09-19 源码独立重评七轮修复批 七轮-1/七轮-2）：
 * books.trash.restore / books.trash.delete 两端点此前漏配 bookMovedFailure 写端点
 * 重验（同文件 words-diary.post 等六族写端点均有）——restoreTrash/purgeTrash 对
 * bookRoot 下路径 mkdir recursive，窗口内书被删/改名即对旧捕获路径重建孤儿目录树。
 *
 * 七轮-2 同批加固：bookMovedFailure 增盘面校验——改名/删书端点「renameWithRetry 搬盘
 * 先行、books.jsonl 登记改写隔多个 await」的陈旧注册窗内，注册比对被旧条目骗过；
 * 盘面目录缺失即 fail-closed 409 BOOK_MOVED。
 *
 * 手法：handler 直调（withRouteTable + getRouteSchema + 假 req/res，r1010b 先例）；
 * 端点无 body 读取，无需喂 body。窗口态用「请求前预置」确定性构造：
 * - 改名窗 = 登记仍指旧 path + 磁盘目录已 rename 走（books-rename 搬盘→登记改写间快照）；
 * - 盘面删除 = 登记完好 + 目录被外力 rm（registration-only 态）。
 */
import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { fakeReqRes } from '../helpers/fake-reqres.js'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerDocumentRoutes } from '../../src/studio/server/api/documents.js'
import { __clearDocumentServices } from '../../src/studio/server/api/documents-core.js'

interface Rig {
  workDir: string
  bookRoot: string
  restore: NonNullable<ReturnType<typeof getRouteSchema>>
  purge: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

function makeBook(name: string): Rig {
  const workDir = mkdtempTracked(join(tmpdir(), 'clwriting-trash-guard-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', name)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\nhost: cc\n`, 'utf-8')
  const handlers = withRouteTable(createRouteTable(), () => {
    registerDocumentRoutes({ workDir, userDataPath: null })
    return {
      restore: getRouteSchema('books.trash.restore')!,
      purge: getRouteSchema('books.trash.delete')!,
    }
  })
  return {
    workDir,
    bookRoot,
    ...handlers,
    cleanup: () => {
      __clearDocumentServices()
      rmSync(workDir, { recursive: true, force: true })
    },
  }
}

/** 改名窗：磁盘目录搬走、books.jsonl 登记仍指旧 path（登记改写前的陈旧注册态）。 */
function renameDirKeepRegistration(rig: Rig, to: string): string {
  const newRoot = join(rig.workDir, '长篇', to)
  renameSync(rig.bookRoot, newRoot)
  return newRoot
}

afterEach(() => {
  __clearDocumentServices()
})

describe('回收站端点书注册重验（七轮-1 补配 + 七轮-2 盘面校验）', () => {
  it('restore：改名窗（登记未变、目录已搬走）→ 409 BOOK_MOVED，旧路径无孤儿重建', async () => {
    const rig = makeBook('回收守卫改名书')
    try {
      const newRoot = renameDirKeepRegistration(rig, '回收守卫改名书乙')
      const { req, res, captured } = fakeReqRes()
      const done = rig.restore.handler({ params: { name: '回收守卫改名书', id: 'doc_x' }, input: undefined }, req, res)
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // 旧路径不得被 mkdir recursive 重建（孤儿目录树面）
      expect(existsSync(rig.bookRoot)).toBe(false)
      expect(existsSync(newRoot)).toBe(true)
    } finally {
      rig.cleanup()
    }
  })

  it('restore：登记完好、盘面目录被外力删除 → 409 BOOK_MOVED（盘面校验臂）', async () => {
    const rig = makeBook('回收守卫删盘书')
    try {
      rmSync(rig.bookRoot, { recursive: true, force: true })
      const { req, res, captured } = fakeReqRes()
      const done = rig.restore.handler({ params: { name: '回收守卫删盘书', id: 'doc_x' }, input: undefined }, req, res)
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('purge：改名窗（登记未变、目录已搬走）→ 409 BOOK_MOVED', async () => {
    const rig = makeBook('回收守卫清除书')
    try {
      renameDirKeepRegistration(rig, '回收守卫清除书乙')
      const { req, res, captured } = fakeReqRes()
      const done = rig.purge.handler({ params: { name: '回收守卫清除书', id: 'doc_x' }, input: undefined }, req, res)
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('不误伤：书完好时守卫放行——无回收站清单照常落到业务 NOT_FOUND（404）', async () => {
    const rig = makeBook('回收守卫放行书')
    try {
      const { req, res, captured } = fakeReqRes()
      const done = rig.restore.handler({ params: { name: '回收守卫放行书', id: 'doc_x' }, input: undefined }, req, res)
      await done
      // 守卫不拦：restoreTrash 正常执行（清单缺失 → 业务 NOT_FOUND，非 BOOK_MOVED）
      expect(captured.status).toBe(404)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('NOT_FOUND')
    } finally {
      rig.cleanup()
    }
  })
})

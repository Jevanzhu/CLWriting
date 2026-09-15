/**
 * R0915-P3-1（四轮重评处置批）回归：review.ts 三审流端点族书注册重验接线。
 *
 * 修复前：review-verdict 的 readJson await 窗口内书被删/改名 → 旧 bookRoot 上
 * resolveDocEntry 以误导性 404「文档ID未登记」回信（书不在了而非文档不在）；review
 * run 端点 lens 循环分钟级让出窗后照写 writeAnalysisAsync 会在旧路径 mkdir recursive
 * 重建孤儿分析目录（documents/config 家族已接线，本文件两写点漏网——四轮重评 P3-1）。
 * 修复后：verdict 在 readJson 后、run 端点在写临界段各按 bookMovedFailure 单源重验
 * → 409 BOOK_MOVED 人话信封，不落盘。
 * 手法：r1010b 先例——handler 直调（withRouteTable + getRouteSchema）+ 假 req/res，
 * 假 req 悬持 body 模拟窗口，窗口内改名/删书再放行（确定性，不赌真实竞态时序）。
 * run 端点写点深居 lens 循环之后（需 driver/生成链，单测不可达），其重验与 verdict
 * 同源同 idiom（bookMovedFailure 单源行），由 verdict 两臂钉信封契约。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeReqRes, waitForBodyArmed } from '../helpers/fake-reqres.js'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerReviewRoutes } from '../../src/studio/server/api/review.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

interface Rig {
  workDir: string
  bookRoot: string
  verdict: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

/** 每用例独立临时书（workDir + 登记 + book.yaml + 清单登记 doc_v1）。verdict 重验在
 *  readJson 窗口后即触发，正文文件无需落盘；清单登记照建以贴近真实形态。 */
function makeBook(name: string): Rig {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-r0915rev-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', name)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\nhost: cc\n`, 'utf-8')
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  upsertEntry(m, { id: 'doc_v1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)
  const verdict = withRouteTable(createRouteTable(), () => {
    registerReviewRoutes({ workDir, userDataPath: null })
    return getRouteSchema('books.documents.review-verdict')!
  })
  return { workDir, bookRoot, verdict, cleanup: () => rmSync(workDir, { recursive: true, force: true }) }
}

describe('R0915-P3-1：review 三审流书注册重验（readJson 窗口）', () => {
  it('review-verdict：readJson 窗口内书被改名 → 409 BOOK_MOVED 人话信封（旧 404「文档ID未登记」语义误导不再）', async () => {
    const rig = makeBook('重验改名书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.verdict.handler({ params: { name: '重验改名书', docId: 'doc_v1' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 悬在 readJson（resolveBookOrReply 已过 = 入口快照窗）
      // 窗口内改名（books.ts rename 完成态模拟：登记换新名 + 目录搬走，同 r1010b 口径）
      writeFileSync(
        join(rig.workDir, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: '重验改名书乙', path: '长篇/重验改名书乙', kind: 'long' }) + '\n',
        'utf-8',
      )
      renameSync(join(rig.workDir, '长篇', '重验改名书'), join(rig.workDir, '长篇', '重验改名书乙'))
      send({ approved: true })
      await done
      expect(captured.status).toBe(409)
      const envelope = JSON.parse(captured.body) as { code: string; error: string }
      expect(envelope.code).toBe('BOOK_MOVED')
      expect(envelope.error).toContain('书已改名或已删除')
      expect(existsSync(rig.bookRoot)).toBe(false) // 旧路径无孤儿
    } finally {
      rig.cleanup()
    }
  })

  it('review-verdict：窗口内删书 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验删书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.verdict.handler({ params: { name: '重验删书', docId: 'doc_v1' }, input: undefined }, req, res)
      await waitForBodyArmed(req)
      // 窗口内删书（登记移除 + 目录入墓地 = books.ts 删除完成态模拟）
      writeFileSync(join(rig.workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
      rmSync(rig.bookRoot, { recursive: true, force: true })
      send({ approved: true })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })
})

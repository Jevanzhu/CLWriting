/**
 * P3-4（全库重评-0914）回归：acknowledge 落账后 /state TTL 缓存即时失效。
 *
 * 场景：POST /journal/:opId/acknowledge 成功 appendAborted 后直接 200——R75-D-P3b
 * 的 /state 5s TTL 缓存不失效，前端确认后立即 refreshState 撞陈旧窗，态 1 的
 * crashedWrite 提醒回显（opId 仍在 crashedPendingOpIds 里）直到 TTL 过期。修复后
 * 成功路径挂 forgetStateCache（对照 review.ts verdict 落盘即 forgetTreeIssuesCache
 * 先例）；幂等 acknowledged:false 路径不改盘，不挂 forget（缓存语义不变）。
 *
 * 装置（手搭书脚手架 + 假 req/res 直调 handler）照抄 journal-acknowledge-endpoint.test.ts；
 * 测试期把 TTL 拉大（60s），无本修复时第二次 GET 必然命中陈旧缓存，用例确定性。
 */
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { fakeReqRes } from '../helpers/fake-reqres.js'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import {
  registerStateRoutes,
  __setStateTtlForTest,
  __stateCacheHasForTest,
} from '../../src/studio/server/api/state.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevisionBytes } from '../../src/document/revision.js'
import { makeGitBook } from '../helpers/book.js'

const BODY_V1 = '---\n章号: 1\n标题: 开篇\n---\n\n第一版正文。\n'
const BODY_V2 = BODY_V1 + '真未落盘的新键入。\n'

/** 造书 + 登记 + 盘上文件 + 悬置 save pending（真未落盘形态），同 r0912 装置。 */
function makeBook(name: string): {
  workDir: string
  bookRoot: string
  opId: string
  state: NonNullable<ReturnType<typeof getRouteSchema>>
  ack: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
} {
  const workDir = mkdtempTracked(join(tmpdir(), 'clwriting-r0914b-ack-cache-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = makeGitBook()
  const entryPath = join(workDir, '长篇', name)
  mkdirSync(join(workDir, '长篇'), { recursive: true })
  renameSync(bookRoot, entryPath)
  const root = entryPath

  const docId = generateDocId()
  const rel = '写作/正文/0001-开篇.md'
  writeFileSync(join(root, rel), BODY_V1, 'utf-8')
  const mp = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(mp)
  upsertEntry(m, { id: docId, nodeType: 'document', path: rel, parentId: null })
  writeManifest(mp, m)
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  const jPath = join(root, '工作区', '.journal', `${docId}.jsonl`)
  // 造 pending 直接写 journal 行（与 appendPending 落盘形态逐位一致，同 r0912 注）
  const opId = `OPTEST${Date.now().toString(36).toUpperCase()}XXXXXXXX`
  writeFileSync(
    jPath,
    JSON.stringify({
      opId,
      docId,
      baseRevision: computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8')),
      ts: new Date().toISOString(),
      status: 'pending',
      content: BODY_V2,
    }) + '\n',
    'utf-8',
  )
  const mk = (route: string): NonNullable<ReturnType<typeof getRouteSchema>> =>
    withRouteTable(createRouteTable(), () => {
      registerStateRoutes({ workDir, userDataPath: null })
      return getRouteSchema(route)
    })!
  return {
    workDir,
    bookRoot: root,
    opId,
    state: mk('books.state'),
    ack: mk('books.state.journal-acknowledge'),
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  }
}

async function getState(state: NonNullable<ReturnType<typeof getRouteSchema>>, name: string): Promise<{
  status: number | null
  body: { state: number; crashedPendingOpIds?: string[] }
}> {
  const { req, res, captured } = fakeReqRes()
  await state.handler({ params: { name }, input: undefined }, req, res)
  return { status: captured.status, body: JSON.parse(captured.body) as { state: number; crashedPendingOpIds?: string[] } }
}

describe('P3-4（全库重评-0914）: acknowledge 后 /state 缓存即时失效', () => {
  it('确认成功后缓存已清，紧随的 GET 不再回显已确认的 crashedPendingOpIds', async () => {
    const name = '确认失效书'
    const rig = makeBook(name)
    // TTL 拉大到 60s：无本修复时第二次 GET 必命中陈旧缓存（回显 opId），用例确定性
    __setStateTtlForTest(60_000)
    try {
      // 首次 GET：报红 + 缓存落位
      const first = await getState(rig.state, name)
      expect(first.status).toBe(200)
      expect(first.body.state).toBe(1)
      expect(first.body.crashedPendingOpIds).toContain(rig.opId)
      expect(__stateCacheHasForTest(rig.bookRoot)).toBe(true)

      // acknowledge 成功
      const ack = fakeReqRes()
      const ackDone = rig.ack.handler({ params: { name, opId: rig.opId }, input: undefined }, ack.req, ack.res)
      ack.send({})
      await ackDone
      expect(ack.captured.status).toBe(200)
      expect(JSON.parse(ack.captured.body)).toEqual({ ok: true, acknowledged: true })

      // 修复锚点：缓存已被 acknowledge 即时清掉
      expect(__stateCacheHasForTest(rig.bookRoot)).toBe(false)
      // 用户可见结果：紧随的 GET 重算，opId 不再回显（修复前撞 5s 陈旧窗会回显）
      const second = await getState(rig.state, name)
      expect(second.status).toBe(200)
      expect(second.body.crashedPendingOpIds ?? []).not.toContain(rig.opId)
    } finally {
      __setStateTtlForTest(null)
      rig.cleanup()
    }
  })
})

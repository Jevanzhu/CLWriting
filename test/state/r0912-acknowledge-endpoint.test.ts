/**
 * R0912-1b（2026-09-11 重评-0911c 修复批）：崩溃 pending 人工确认端点。
 *
 * POST /api/books/:name/journal/:opId/acknowledge → 对该 save 类 pending
 * appendAborted（journal.ts 既有原语），使其不再报 crashedWrite。幽灵红消解
 * 闭环的人工半边（R0912-1a 是「盘上已落盘」的自动半边）。
 *
 * 契约锚定：
 * - 命中 pending → 200 {ok:true, acknowledged:true}，findUnsettled 清零，下次
 *   detectState 不再报红；
 * - opId 不存在 / 已 settled（重复确认）→ 200 {ok:true, acknowledged:false}（幂等）；
 * - 书改名/删除 → 409 BOOK_MOVED（documents.ts bookMovedFailure 同款重验）；
 * - 循环健康报文消解链路：报红 → acknowledge → 复查不报红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterAll } from 'vitest'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerStateRoutes, __setStateTtlForTest } from '../../src/studio/server/api/state.js'
import { appendSettled, findUnsettled } from '../../src/document/journal.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevisionBytes } from '../../src/document/revision.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { makeGitBook } from '../helpers/book.js'

/** 假 req/res（r1010b-srv-documents-bookmoved 同款形态，对齐 error-envelope 先例）。 */
function fakeReqRes(): {
  req: IncomingMessage
  res: ServerResponse
  send: (body: unknown) => void
  captured: { status: number | null; body: string }
} {
  const em = new EventEmitter()
  const req = em as unknown as IncomingMessage
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  const captured = { status: null as number | null, body: '' }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
  } as unknown as ServerResponse
  return {
    req,
    res,
    send: (body: unknown) => {
      em.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'))
      em.emit('end')
    },
    captured,
  }
}

const BODY_V1 = '---\n章号: 1\n标题: 开篇\n---\n\n第一版正文。\n'
const BODY_V2 = BODY_V1 + '真未落盘的新键入。\n'

/** 造书 + 登记 + 盘上文件 + 悬置 save pending（真未落盘形态：盘上仍是基线）。 */
function makeBook(name: string): {
  workDir: string
  bookRoot: string
  docId: string
  jPath: string
  opId: string
  ack: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
} {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-r0912-ack-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = makeGitBook()
  // 把书目录搬进 workDir 登记位（makeGitBook 是 mkdtempTracked 自管根——直接在其下
  // 建 books.jsonl 不可行；改为在 workDir 下登记指向该根的相对形态不可靠，干脆让
  // books.jsonl 的 path 用绝对形态由 resolveBook join 处理不可行——所以这里换手法：
  // 直接把 makeGitBook 根改名进 workDir 登记的目录位。
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
  // 同步侧不发 await 的造 pending：直接写 journal 行（appendPending 异步锁形态在
  // 同步函数里不可用；本测试造态走底层行格式，与 appendPending 落盘形态逐位一致）
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
  const ack = withRouteTable(createRouteTable(), () => {
    registerStateRoutes({ workDir, userDataPath: null })
    return getRouteSchema('books.state.journal-acknowledge')!
  })
  return {
    workDir,
    bookRoot: root,
    docId,
    jPath,
    opId,
    ack: ack!,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  }
}

afterAll(() => {
  // makeGitBook 的 mkdtempTracked 由其 afterEach 收走；本文件 workDir 各用例自清
})

describe('R0912-1b：journal acknowledge 端点', () => {
  it('命中 pending → acknowledged:true，findUnsettled 清零，detectState 不再报红', async () => {
    const rig = makeBook('确认书')
    try {
      // 前置：报红在案
      const before = await detectState(rig.bookRoot, DEFAULT_CONFIG)
      expect(before.state).toBe(1)
      if (before.state === 1) expect(before.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)

      const { req, res, send, captured } = fakeReqRes()
      const done = rig.ack.handler(
        { params: { name: '确认书', opId: rig.opId }, input: undefined },
        req,
        res,
      )
      send({}) // POST 空体（parse 未声明，body 不被读）
      await done
      expect(captured.status).toBe(200)
      expect(JSON.parse(captured.body)).toEqual({ ok: true, acknowledged: true })
      // journal 已 aborted（findUnsettled 清零），下次进门不再报红
      expect(findUnsettled(rig.jPath)).toHaveLength(0)
      const after = await detectState(rig.bookRoot, DEFAULT_CONFIG)
      if (after.state === 1) expect(after.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('opId 不存在 → 200 acknowledged:false（幂等，不报错）', async () => {
    const rig = makeBook('不存在书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.ack.handler({ params: { name: '不存在书', opId: 'OPNOPE000000000000000000' }, input: undefined }, req, res)
      send({})
      await done
      expect(captured.status).toBe(200)
      expect(JSON.parse(captured.body)).toEqual({ ok: true, acknowledged: false })
      // 原 pending 不受影响
      expect(findUnsettled(rig.jPath)).toHaveLength(1)
    } finally {
      rig.cleanup()
    }
  })

  it('已 settled 的 opId 重复确认 → 200 acknowledged:false（幂等）', async () => {
    const rig = makeBook('已结算书')
    try {
      await appendSettled(rig.jPath, rig.opId, computeRevisionBytes(Buffer.from(BODY_V2, 'utf-8')))
      expect(findUnsettled(rig.jPath)).toHaveLength(0)
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.ack.handler({ params: { name: '已结算书', opId: rig.opId }, input: undefined }, req, res)
      send({})
      await done
      expect(captured.status).toBe(200)
      expect(JSON.parse(captured.body)).toEqual({ ok: true, acknowledged: false })
    } finally {
      rig.cleanup()
    }
  })

  it('书删除后确认 → resolveBook 404 错误信封，旧 journal 未动', async () => {
    // 注：BOOK_MOVED 重验分支（documents.ts bookMovedFailure 同款）是防御性纵深——
    // 本端点无 readJson await 窗口，入口 resolveBook 与重验之间是同步段，单进程测试
    // 无外部介入点可确定性构造「入口成功、重验失败」时序；他进程改 books.jsonl 的
    // µs 级竞态由该分支兜底。此处锚定其入口侧行为：书已删 → 404 NOT_FOUND 信封，
    // 且不对旧捕获路径落账。
    const rig = makeBook('删书确认')
    try {
      writeFileSync(join(rig.workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.ack.handler({ params: { name: '删书确认', opId: rig.opId }, input: undefined }, req, res)
      send({})
      await done
      expect(captured.status).toBe(404)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('NOT_FOUND')
      // 旧路径 journal 未动（pending 保留）
      expect(findUnsettled(rig.jPath)).toHaveLength(1)
    } finally {
      rig.cleanup()
    }
  })

  it('R0912：GET /state payload 透出 crashedPendingOpIds（FE「忽略此提醒」接线面）', async () => {
    const rig = makeBook('透出书')
    // R75-D-P3b 的 5s TTL 缓存会吃掉 acknowledge 前后两次 GET 的差异——测试期 TTL 置 0
    // （本批只验 payload 组装面，缓存语义归 R75-D-P3b 自己的测试），结束恢复默认
    __setStateTtlForTest(0)
    try {
      const stateSchema = withRouteTable(createRouteTable(), () => {
        registerStateRoutes({ workDir: rig.workDir, userDataPath: null })
        return getRouteSchema('books.state')
      })!
      const { req, res, captured } = fakeReqRes()
      const done = stateSchema.handler({ params: { name: '透出书' }, input: undefined }, req, res)
      await done
      expect(captured.status).toBe(200)
      const body = JSON.parse(captured.body) as { state: number; crashedPendingOpIds?: string[] }
      expect(body.state).toBe(1)
      expect(body.crashedPendingOpIds).toContain(rig.opId)
      // acknowledge 后复查：opId 消失（消解闭环贯通到 payload 面）
      const ack = fakeReqRes()
      const ackDone = rig.ack.handler({ params: { name: '透出书', opId: rig.opId }, input: undefined }, ack.req, ack.res)
      ack.send({})
      await ackDone
      const stateSchema2 = withRouteTable(createRouteTable(), () => {
        registerStateRoutes({ workDir: rig.workDir, userDataPath: null })
        return getRouteSchema('books.state')
      })!
      const { req: req2, res: res2, captured: captured2 } = fakeReqRes()
      const done2 = stateSchema2.handler({ params: { name: '透出书' }, input: undefined }, req2, res2)
      await done2
      const body2 = JSON.parse(captured2.body) as { state: number; crashedPendingOpIds?: string[] }
      expect(body2.crashedPendingOpIds ?? []).not.toContain(rig.opId)
    } finally {
      __setStateTtlForTest(null)
      rig.cleanup()
    }
  })
})

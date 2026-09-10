/**
 * R1010b-SRV-P2-1 / R1010b-SRV-P3-1（2026-09-10 内存专项重审修复批）回归：
 * documents.ts 五处链内写单元的书注册重验（面 A）+ 伏笔保存串行链 drain（面 B）
 * + 链尾自清理 / forget 挂点（P3-1）。
 *
 * 面 A（P2-1）：handler 开头 resolveBook 捕获的 bookRoot 只是入口快照——await readJson /
 * 伏笔链排队可跨过 books.ts 删书/改名的 drain 时点，单元体才开跑并对旧捕获路径落盘成
 * 孤儿文件。修复后单元体首行按书名重验（与 files.ts R70-6 同族）：已删（解析失败）或
 * bookRoot 变化（改名）→ 409 BOOK_MOVED 不落盘。
 * 手法：handler 直调（withRouteTable 注册 + getRouteSchema 取 handler）+ 假 req/res
 * （error-envelope.test.ts 假 res 先例）；假 req 悬持 body 模拟「入口已过、单元未跑」
 * 窗口，窗口内改名/删书再放行 body——确定性复现，不赌真实竞态时序。
 * 面 B（P2-1）：已入队未启动的伏笔单元不在 drainDocumentSaves 的 SaveQueue 计数内——
 * drainForeshadowSaveChains 必须等到链尾单元（含在途 svc.save）收尾才 resolve
 * （测试以本进程持有 per-doc 保存锁挡住 svc.save 造确定性在途窗，观测钩子轮询手法
 * 对齐 r71-files-drain-realpath）。
 * P3-1：链尾 settle 后 Map 条目自清理（不留死 Promise）；forget 钩子按书清悬挂条目。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import {
  registerDocumentRoutes,
  drainForeshadowSaveChains,
  forgetForeshadowSaveChain,
  __foreshadowSaveChainKeysForTest,
  __clearDocumentServices,
} from '../../src/studio/server/api/documents.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { encodeDocDirName } from '../../src/document/version.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 假 req（EventEmitter 手工喂 data/end；readJson 的闲置 30s 窗内挂持即「入口已过、
 *  单元未跑」确定性窗口）+ 假 res（捕获状态码与信封体，形状对齐 error-envelope 先例）。 */
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

interface Rig {
  workDir: string
  bookRoot: string
  content: NonNullable<ReturnType<typeof getRouteSchema>>
  create: NonNullable<ReturnType<typeof getRouteSchema>>
  patch: NonNullable<ReturnType<typeof getRouteSchema>>
  wordsDiary: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

/** 每用例独立临时书（workDir + 登记 + 清单登记 doc_f1→设定/伏笔/伏笔-001.md，正文文件
 *  不落盘——PUT expectedRevision=null 走新建路径）。伏笔域路径让 PUT 进链、PATCH 判定
 *  伏笔域；create 用非伏笔 relPath 覆盖直调分支。 */
function makeBook(name: string): Rig {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-r1010b-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', name)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '设定', '伏笔'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\nhost: cc\n`, 'utf-8')
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  upsertEntry(m, { id: 'doc_f1', nodeType: 'document', path: '设定/伏笔/伏笔-001.md', parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)
  const handlers = withRouteTable(createRouteTable(), () => {
    registerDocumentRoutes({ workDir, userDataPath: null })
    return {
      content: getRouteSchema('books.documents.content')!,
      create: getRouteSchema('books.documents')!,
      patch: getRouteSchema('books.documents.patch')!,
      wordsDiary: getRouteSchema('books.words-diary.post')!,
    }
  })
  return {
    workDir,
    bookRoot,
    ...handlers,
    cleanup: () => {
      __clearDocumentServices()
      forgetForeshadowSaveChain(bookRoot)
      rmSync(workDir, { recursive: true, force: true })
    },
  }
}

/** 窗口内改名（books.ts rename 全量路径完成态模拟：登记换新名 + 目录搬走）。 */
function renameBookReg(workDir: string, from: string, to: string): void {
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: to, path: `长篇/${to}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  renameSync(join(workDir, '长篇', from), join(workDir, '长篇', to))
}

/** 该 doc 的 per-doc 保存锁键（service.ts executeSave 同构：`<journal>.save.lock`）。 */
function saveLockPathOf(bookRoot: string): string {
  return `${join(bookRoot, '工作区', '.journal', `${encodeDocDirName('doc_f1')}.jsonl`)}.save.lock`
}

afterAll(() => {
  __clearDocumentServices()
})

describe('R1010b-SRV-P2-1 面 A：链内写单元书注册重验', () => {
  it('PUT content（伏笔链单元）：单元开跑前书被改名 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验改名书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.content.handler({ params: { name: '重验改名书', docId: 'doc_f1' }, input: undefined }, req, res)
      // 悬在 readJson（resolveBook/resolvePathAsync 已过——正是被修的入口快照窗）
      await sleep(50)
      renameBookReg(rig.workDir, '重验改名书', '重验改名书乙')
      // 放行 body → 伏笔链单元开跑 → 首行重验命中改名
      send({ content: '窗口期正文', expectedRevision: null, operationId: 'op-r1010b-a1', origin: 'manual' })
      await done
      expect(captured.status).toBe(409)
      const envelope = JSON.parse(captured.body) as { code: string; error: string }
      expect(envelope.code).toBe('BOOK_MOVED')
      expect(typeof envelope.error).toBe('string')
      // 旧路径无孤儿：改名后旧根不存在，重验失败不得经 svc.save mkdir 重建
      expect(existsSync(rig.bookRoot)).toBe(false)
      // 顺带锚定 P3-1：失败单元 settle 后链条目自清理
      await sleep(0)
      expect([...__foreshadowSaveChainKeysForTest()]).not.toContain(rig.bookRoot)
    } finally {
      rig.cleanup()
    }
  })

  it('POST documents（非伏笔直调单元）：单元开跑前书被删 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验删书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.create.handler({ params: { name: '重验删书' }, input: undefined }, req, res)
      await sleep(50)
      // 窗口内删书（登记移除 + 目录入墓地 = books.ts 删除完成态模拟）
      writeFileSync(join(rig.workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
      rmSync(rig.bookRoot, { recursive: true, force: true })
      send({ relPath: '写作/正文/0002-新章.md', content: '---\n章号: 2\n---\n新章' })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('PATCH fm：单元开跑前书被改名 → 409 BOOK_MOVED（runPatch 单元重验）', async () => {
    const rig = makeBook('重验patch书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.patch.handler({ params: { name: '重验patch书', docId: 'doc_f1' }, input: undefined }, req, res)
      await sleep(50)
      renameBookReg(rig.workDir, '重验patch书', '重验patch书乙')
      send({ op: 'fm', meta: { 状态: '进行中' } })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('POST words-diary（同型扫描接线）：readJson 窗口内书被删 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验字数书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.wordsDiary.handler({ params: { name: '重验字数书' }, input: undefined }, req, res)
      await sleep(50)
      writeFileSync(join(rig.workDir, '.clwriting', 'books.jsonl'), '', 'utf-8')
      rmSync(rig.bookRoot, { recursive: true, force: true })
      send({ baseline: 1000 })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // appendBaseline 的 mkdir recursive 不得对旧路径重建 项目/ 目录
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })
})

describe('R1010b-SRV-P2-1 面 B：drainForeshadowSaveChains', () => {
  it('链上有在途单元（svc.save 被保存锁挡住）时 drain 等到其收尾才 resolve', async () => {
    const rig = makeBook('drain等待书')
    const release = await acquireCrossProcessLockAsync(saveLockPathOf(rig.bookRoot), 1_000)
    expect(release).not.toBeNull()
    let released = false
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.content.handler({ params: { name: 'drain等待书', docId: 'doc_f1' }, input: undefined }, req, res)
      // 先等 handler 悬在 readJson（假 req 事件无缓冲，早喂即丢），再放行完整 body
      // ——单元开跑、svc.save 悬在保存锁上
      await sleep(50)
      send({ content: 'drain 窗正文', expectedRevision: null, operationId: 'op-r1010b-b1', origin: 'manual' })
      // 轮询观测钩子等链键出现（单元已开跑、svc.save 悬在保存锁上）——r71 同手法
      let seen = false
      for (let i = 0; i < 2000 && !seen; i++) {
        seen = __foreshadowSaveChainKeysForTest().includes(rig.bookRoot)
        if (!seen) await sleep(1)
      }
      expect(seen).toBe(true)
      let drained = false
      const drainP = drainForeshadowSaveChains(rig.bookRoot).then(() => {
        drained = true
      })
      await sleep(60)
      // 单元仍在途（保存锁被本测试持着）→ drain 必须仍挂起（修复前无此 drain，链单元
      // 对删书/改名完全不可见）
      expect(drained).toBe(false)
      released = true
      release!()
      await drainP
      expect(drained).toBe(true)
      await done
      // 在途单元在书尚在时正常落盘（drain 等待不改变单元语义）
      expect(captured.status).toBe(200)
      expect(readFileSync(join(rig.bookRoot, '设定', '伏笔', '伏笔-001.md'), 'utf-8')).toBe('drain 窗正文')
      // 链 settle 后自清理（P3-1）
      await sleep(0)
      expect(__foreshadowSaveChainKeysForTest().includes(rig.bookRoot)).toBe(false)
    } finally {
      if (!released) release?.()
      rig.cleanup()
    }
  })
})

describe('R1010b-SRV-P3-1：链尾自清理与 forget 挂点', () => {
  it('forgetForeshadowSaveChain 按书清悬挂链条目；无条目时 drain 立即 resolve', async () => {
    const rig = makeBook('forget书')
    // 无条目即 resolve（drain 口径）
    await expect(drainForeshadowSaveChains(rig.bookRoot)).resolves.toBeUndefined()
    const release = await acquireCrossProcessLockAsync(saveLockPathOf(rig.bookRoot), 1_000)
    expect(release).not.toBeNull()
    let released = false
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.content.handler({ params: { name: 'forget书', docId: 'doc_f1' }, input: undefined }, req, res)
      // 同面 B：先等 handler 悬在 readJson 再放行 body
      await sleep(50)
      send({ content: 'forget 窗正文', expectedRevision: null, operationId: 'op-r1010b-c1', origin: 'manual' })
      let seen = false
      for (let i = 0; i < 2000 && !seen; i++) {
        seen = __foreshadowSaveChainKeysForTest().includes(rig.bookRoot)
        if (!seen) await sleep(1)
      }
      expect(seen).toBe(true)
      // forget 清悬挂条目（删书/改名 forgetBookKeyedCaches 挂点语义）
      forgetForeshadowSaveChain(rig.bookRoot)
      expect(__foreshadowSaveChainKeysForTest().includes(rig.bookRoot)).toBe(false)
      // forget 只清 Map 条目不动在途单元——释放锁后单元照常收尾
      released = true
      release!()
      await done
      expect(captured.status).toBe(200)
    } finally {
      if (!released) release?.()
      rig.cleanup()
    }
  })
})

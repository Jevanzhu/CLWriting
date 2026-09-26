/**
 * R0911-B-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）回归：非闸书级写端点的临界段
 * 书注册重验——knowledge（learn-commit）/ style（entries 新增/删除、候选确认/忽略）/
 * config（PUT /config）三文件套 documents.ts R1010b-SRV-P2-1 同型防线。
 *
 * 竞态时序：handler 入口 resolveBook 捕获的 bookRoot 只是快照——await readJson /
 * 批量落盘的周期让出（R0911-B-P3-3）可跨过 books.ts 删书/改名时点（这些端点无任务
 * 闸，busyGate 看不见在途请求），对旧捕获路径写盘会 mkdir 复活幽灵目录。修复后写
 * 前/每次让出后重验 name→bookRoot：已删或变化 → 409 BOOK_MOVED 不落盘。
 *
 * 手法：镜像 r1010b-srv-documents-bookmoved——handler 直调（withRouteTable 注册 +
 * getRouteSchema 取 handler）+ 假 req/res；假 req 悬持 body 模拟「入口已过、临界段
 * 未跑」窗口，窗口内删书/改名再放行 body（确定性复现）。learn-commit 另有让出点
 * 用例：注入 yield 桩（KnowledgeCtx learnCommitYield 注入，原 setter 已删）在首个让出点改名，锚定让出后
 * 重验中止剩余条目。style 四端点自 R0916-7-P3-13 起 body 读取在 defineRoute 包装层
 * （parse 段），窗口转由整表 dispatch 复现——见 styleDispatch 头注。
 */
import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processRouteDeps } from './helpers/route-deps.js' // R0916-7-P3-6：路由注入面（生产口径）
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { createRouteTable, dispatch, withRouteTable, type RouteTable } from '../../src/studio/server/router.js'
import { getRouteSchema } from '../../src/studio/server/api/schema.js'
import { registerKnowledgeRoutes } from '../../src/studio/server/api/knowledge.js'
import { defaultCommitYield } from '../../src/learn/commit.js'
import { registerStyleRoutes } from '../../src/studio/server/api/style.js'
import { registerConfigRoutes } from '../../src/studio/server/api/config.js'
import { fakeReqRes, waitForBodyArmed } from '../helpers/fake-reqres.js'

// 假 req/res 已收编 helpers/fake-reqres.ts 单源（测试精简批 2026-09-12）。

interface Rig {
  workDir: string
  bookRoot: string
  table: RouteTable
  learnCommit: NonNullable<ReturnType<typeof getRouteSchema>>
  configPut: NonNullable<ReturnType<typeof getRouteSchema>>
  cleanup: () => void
}

// learn-commit 让出桩（ctx 注入的委托壳按用例置位；null = 生产口径 defaultCommitYield）
let learnCommitYieldFn: (() => Promise<void>) | null = null

/** 每用例独立临时书（workDir + 登记 + book.yaml）；三个被修文件的路由一并注册。 */
function makeBook(name: string): Rig {
  const workDir = mkdtempTracked(join(tmpdir(), 'clwriting-r0911-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, '长篇', name)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: ${name}\nhost: cc\n`,
    'utf-8',
  )
  const table = createRouteTable()
  const handlers = withRouteTable(table, () => {
    // R0911b-B-P3-2：KnowledgeCtx token 死字段删除，注入随之去 token；
    // learnCommitYield 走委托壳（未置位回落生产口径 defaultCommitYield）
    registerKnowledgeRoutes({
      workDir,
      learnCommitYield: () => (learnCommitYieldFn ?? defaultCommitYield)(),
      ...processRouteDeps(),
    })
    registerStyleRoutes({ workDir, userDataPath: null, ...processRouteDeps() })
    registerConfigRoutes({ workDir })
    return {
      learnCommit: getRouteSchema('books.learn-commit')!,
      configPut: getRouteSchema('books.config.put')!,
    }
  })
  return {
    workDir,
    bookRoot,
    table,
    ...handlers,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  }
}

/** R0916-7-P3-13：style 四端点的 body 读取已迁入 defineRoute 包装层的 parse 段
 *  （handler 不再自读 readJson），handler 直调复现不出「入口已过、临界段未跑」窗口——
 *  改走整表 dispatch（闸→parse→handler 全栈），假 req 补 method/url 供分发器匹配。
 *  观测点随 readJson 落点迁移，断言语义（409 BOOK_MOVED + 旧根无孤儿）不变。 */
function styleDispatch(
  rig: Rig,
  method: 'POST' | 'DELETE',
  url: string,
): {
  req: ReturnType<typeof fakeReqRes>['req']
  send: ReturnType<typeof fakeReqRes>['send']
  captured: ReturnType<typeof fakeReqRes>['captured']
  done: Promise<boolean>
} {
  const { req, res, send, captured } = fakeReqRes()
  const mutable = req as unknown as { method: string; url: string }
  mutable.method = method
  mutable.url = url
  return { req, send, captured, done: dispatch(req, res, rig.table) }
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

/** 样章条目目录 .md 计数（addEntry 落 文风/条目/样章/场景-NNN.md） */
function entryCount(bookRoot: string): number {
  const dir = join(bookRoot, '文风', '条目', '样章')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0
}

/** n 条互异样章候选（learn-commit body 用） */
function samples(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    场景: '对话',
    正文: `「样本${i}。」`,
    出处: `《测试》第 ${i + 1} 章`,
    章号: i + 1,
    打分: 50,
  }))
}

describe('R0911-B-P3-4: knowledge learn-commit 临界段书注册重验', () => {
  it('readJson 窗口内书被删 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验learn书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.learnCommit.handler({ params: { name: '重验learn书' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 悬在 readJson（入口快照已过）——就绪探针取代 sleep(50)（重评-0914-三轮 P3-12）
      deleteBookReg(rig.workDir, rig.bookRoot)
      send({ samples: samples(2), quotes: [] })
      await done
      expect(captured.status).toBe(409)
      const envelope = JSON.parse(captured.body) as { code: string; error: string }
      expect(envelope.code).toBe('BOOK_MOVED')
      expect(typeof envelope.error).toBe('string')
      // 旧路径无孤儿：commitSamples 的 addEntry 不得对已删路径 mkdir 重建
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('批量落盘首个让出点书被改名 → 409 BOOK_MOVED，前 100 条随目录迁移、余 150 中止', async () => {
    const rig = makeBook('重验让出书')
    let stubCalls = 0
    learnCommitYieldFn = () => {
      // 让出点 = 并发改名窗（周期让出是 B-P3-3 引入的新 await 窗）：首个让出时搬书
      stubCalls++
      renameBookReg(rig.workDir, '重验让出书', '重验让出书乙')
      return Promise.resolve()
    }
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.learnCommit.handler({ params: { name: '重验让出书' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      send({ samples: samples(250), quotes: [] })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // 旧路径不存在（让出后重验拒写，未对旧根复活任何条目）
      expect(existsSync(rig.bookRoot)).toBe(false)
      // 新路径恰 100 条：首段已落条目随目录一起迁移；中止信号在首个让出点生效
      //（后续让出不再发生）
      expect(stubCalls).toBe(1)
      expect(entryCount(join(rig.workDir, '长篇', '重验让出书乙'))).toBe(100)
    } finally {
      learnCommitYieldFn = null
      rig.cleanup()
    }
  })
})

describe('R0911-B-P3-4: style 写端点临界段书注册重验', () => {
  it('POST entries：readJson 窗口内书被删 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验条目书')
    try {
      const { req, send, captured, done } = styleDispatch(rig, 'POST', '/api/books/重验条目书/style/entries')
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      deleteBookReg(rig.workDir, rig.bookRoot)
      send({ 类型: '样章', 正文: '窗口期正文' })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // addEntry 的 mkdir recursive 不得对旧路径重建 文风/ 条目目录
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('DELETE entries：readJson 窗口内书被改名 → 409 BOOK_MOVED（先于旧根 realpath 失败的 400）', async () => {
    const rig = makeBook('重验删条书')
    try {
      const { req, send, captured, done } = styleDispatch(rig, 'DELETE', '/api/books/重验删条书/style/entries')
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      renameBookReg(rig.workDir, '重验删条书', '重验删条书乙')
      send({ path: '文风/条目/样章/对话-001.md' })
      await done
      // 重验置于 resolveWithinRoot 之前——书已搬走时不得误报 400「路径非法」
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('POST candidates/confirm：readJson 窗口内书被改名 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验确认书')
    try {
      const { req, send, captured, done } = styleDispatch(rig, 'POST', '/api/books/重验确认书/style/candidates/confirm')
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      renameBookReg(rig.workDir, '重验确认书', '重验确认书乙')
      send({ path: '文风/候选/对话-001.md' })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // confirmCandidate 的搬文件/写盘不得对旧路径重建目录
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('POST candidates/ignore：readJson 窗口内书被删 → 409 BOOK_MOVED 且旧路径无孤儿', async () => {
    const rig = makeBook('重验忽略书')
    try {
      const { req, send, captured, done } = styleDispatch(rig, 'POST', '/api/books/重验忽略书/style/candidates/ignore')
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      deleteBookReg(rig.workDir, rig.bookRoot)
      send({ path: '文风/候选/对话-001.md' })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })
})

describe('R0911-B-P3-4: config PUT 临界段书注册重验', () => {
  it('readJson 窗口内书被改名 → 409 BOOK_MOVED 且旧 book.yaml 未被复活', async () => {
    const rig = makeBook('重验配置书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.configPut.handler({ params: { name: '重验配置书' }, input: undefined }, req, res)
      await waitForBodyArmed(req) // 就绪探针取代 sleep(50)：轮询到 readJson 挂持再放行（重评-0914-三轮 P3-12）
      renameBookReg(rig.workDir, '重验配置书', '重验配置书乙')
      send({ config: { book: { title: '窗口期新题' } } })
      await done
      expect(captured.status).toBe(409)
      expect((JSON.parse(captured.body) as { code: string }).code).toBe('BOOK_MOVED')
      // atomicWriteFile 的 mkdir recursive 不得对旧路径复活 book.yaml
      expect(existsSync(rig.bookRoot)).toBe(false)
    } finally {
      rig.cleanup()
    }
  })

  it('无移书时 PUT 照常 200（重验不改变成功路径语义）', async () => {
    const rig = makeBook('重验常态书')
    try {
      const { req, res, send, captured } = fakeReqRes()
      const done = rig.configPut.handler({ params: { name: '重验常态书' }, input: undefined }, req, res)
      // config 须为完整 BookConfig（spec_version/leads/budget/growth 必填——patch 与
      // stringify 回落都直读 leads.enabled / growth.realm_span_max，残缺形状 500 是
      // 既有行为，与本修复无关；形状对齐 cov-server-config-draft-branches 先例）
      send({ config: { spec_version: 1, book: { title: '常态新题' }, leads: { enabled: [] }, budget: {}, growth: {} } })
      await done
      expect(captured.status).toBe(200)
      const d = JSON.parse(captured.body) as { ok: boolean; revision: number }
      expect(d.ok).toBe(true)
      expect(typeof d.revision).toBe('number')
    } finally {
      rig.cleanup()
    }
  })
})

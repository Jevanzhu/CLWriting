/**
 * R29-7（二十九轮）回归：布线文件写路径的第二道同名跨进程文件锁。
 *
 * 背景：lead-finalize.applyLeadUpdates 对单个布线文件的「读旧→补履历→writeLead」
 * 持 `<布线文件绝对路径>.lock`；service 三写路径（executeSave / updateChapterMeta /
 * updateDocMeta）此前只持按 journal 命名的 save 锁，两锁互不感知——R26-6 注释宣称
 * 防住的「作者经 executeSave 保存同一布线文件」的覆盖（lost update）实际没防住。
 * 修复后：布线/ 与 大纲/关系线/ 下的文档，在 save 锁内再取同名文件锁（锁序单向
 * save→file），超时按 WRITE_ERROR 拒绝保存（fail-closed 不降级裸写）；非布线文件
 * 不受影响（不加锁）。
 *
 * 锁探针法：预置一把「活进程」锁文件（pid=本进程，必然存活，与锁基建内容格式一致）
 * 模拟另一进程（回写侧）在临界段内——保存方拿不到锁即证明其在探测**同名**键。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService, __setWiringSaveLockTimeoutForTest } from '../../src/document/service.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'
import { writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'

const WIRING_REL = '布线/悬念/悬念-001-灭门.md'
const WIRING_RELATION_REL = '大纲/关系线/关系线-001-师徒.md'
const BODY_REL = '写作/正文/0001-开篇.md'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r29-wiring-lock-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
  // 锁探针等待档缩到 80ms 保快（生产 5s，afterEach 还原）
  __setWiringSaveLockTimeoutForTest(80)
})

afterEach(() => {
  __setWiringSaveLockTimeoutForTest(5_000)
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 预置一把「活进程」同名锁（模拟回写侧在临界段内）。 */
function holdLock(targetAbs: string): void {
  mkdirSync(dirname(targetAbs), { recursive: true })
  writeFileSync(`${targetAbs}.lock`, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

describe('R29-7 / executeSave 布线文件锁', () => {
  it('布线文件被同名锁占用 → WRITE_ERROR 拒绝保存，文件未写、他人锁未删、save 锁未残留', async () => {
    const wiringAbs = join(bookRoot, ...WIRING_REL.split('/'))
    holdLock(wiringAbs)
    const r = await svc.save('doc_w1', WIRING_REL, {
      content: '---\n标题: 灭门\n---\n\n新正文',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('回写此布线文件')
    }
    // fail-closed：文件未落盘；回写侧的锁未被误删
    expect(existsSync(wiringAbs)).toBe(false)
    expect(existsSync(`${wiringAbs}.lock`)).toBe(true)
    // save 锁已随拒绝路径释放（不在盘残留，不阻塞后续保存）
    const saveLock = join(bookRoot, '工作区', '.journal', 'doc_w1.jsonl.save.lock')
    expect(existsSync(saveLock)).toBe(false)
  })

  it('锁释放后布线文件保存照常成功，且 `<文件>.lock` 不残留（证明保存确实探测该键）', async () => {
    const wiringAbs = join(bookRoot, ...WIRING_REL.split('/'))
    const r1 = await svc.save('doc_w1', WIRING_REL, {
      content: '---\n标题: 灭门\n---\n\n新正文',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r1.ok).toBe(true)
    expect(existsSync(wiringAbs)).toBe(true)
    // 成功保存后同名文件锁不残留——上一步若换名探测（如 realpath 拼键）此断言与
    // 用例 1 会双双失真，两用例共同锁定「键 = join(bookRoot, relPath) 词法路径」
    expect(existsSync(`${wiringAbs}.lock`)).toBe(false)
    // 覆盖保存（合法基线）同样成功
    if (!r1.ok) throw new Error('prereq')
    const r2 = await svc.save('doc_w1', WIRING_REL, {
      content: '---\n标题: 灭门\n---\n\n第二版',
      expectedRevision: r1.revision,
      operationId: 'op2',
      origin: 'manual',
    })
    expect(r2.ok).toBe(true)
    expect(readFileSync(wiringAbs, 'utf-8')).toContain('第二版')
  })

  it('大纲/关系线/（lead-finalize 同口径布线族写点）同样受同名锁保护', async () => {
    const relAbs = join(bookRoot, ...WIRING_RELATION_REL.split('/'))
    holdLock(relAbs)
    const r = await svc.save('doc_w2', WIRING_RELATION_REL, {
      content: '---\n标题: 师徒\n---\n\n新正文',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
    expect(existsSync(relAbs)).toBe(false)
  })

  it('非布线文件不取 `<文件>.lock`：同名锁在位时保存照常成功（不受影响面）', async () => {
    const bodyAbs = join(bookRoot, ...BODY_REL.split('/'))
    holdLock(bodyAbs) // 布线族以外的文件锁与保存链路无关
    const r = await svc.save('doc_b1', BODY_REL, {
      content: '---\n章号: 1\n标题: 开篇\n---\n\n正文',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(existsSync(bodyAbs)).toBe(true)
    expect(existsSync(`${bodyAbs}.lock`)).toBe(true) // 探针锁原样（保存没碰它）
  })
})

describe('R29-7 / updateDocMeta 布线文件锁', () => {
  function registerWiringDoc(): { docId: string; abs: string } {
    const abs = join(bookRoot, ...WIRING_REL.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '---\n标题: 灭门\n状态: 进行中\n---\n\n旧正文\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    mkdirSync(dirname(manifestPath), { recursive: true })
    const m: Manifest = { version: 1, entries: new Map() }
    upsertEntry(m, { id: 'doc_w1', nodeType: 'document', path: WIRING_REL, parentId: null })
    writeManifest(manifestPath, m)
    return { docId: 'doc_w1', abs }
  }

  it('布线文件被同名锁占用 → WRITE_ERROR 拒绝元数据保存（不裸写）', async () => {
    const { docId, abs } = registerWiringDoc()
    holdLock(abs)
    const r = await svc.updateDocMeta(docId, { 状态: '已收尾' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('回写此布线文件')
    }
    // 文件未被改写（状态键保持原值）
    expect(readFileSync(abs, 'utf-8')).toContain('状态: 进行中')
    expect(existsSync(`${abs}.lock`)).toBe(true)
    const saveLock = join(bookRoot, '工作区', '.journal', 'doc_w1.jsonl.save.lock')
    expect(existsSync(saveLock)).toBe(false)
  })

  it('锁释放后元数据保存照常成功（写入 + 基线 revision 对齐）', async () => {
    const { docId, abs } = registerWiringDoc()
    const r = await svc.updateDocMeta(docId, { 状态: '已收尾' })
    expect(r.ok).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toContain('状态: 已收尾')
    expect(existsSync(`${abs}.lock`)).toBe(false)
    expect(computeRevision(abs)).toBeTruthy()
  })
})

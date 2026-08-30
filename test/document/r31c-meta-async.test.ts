/**
 * R31-19 / R31-20（三十一轮）回归——meta PATCH 链异步化：
 *
 * - R31-20 [P3]：updateChapterMeta / updateDocMeta 的 save/布线/清单锁等待此前为
 *   Atomics.wait 同步睡（最坏 ≈20s 冻结服务进程事件循环，与 R30-6 异步化 executeSave/
   * finalize 的理由正面冲突）。修复后：取锁等待走 acquireCrossProcessLockAsync
 *   （setTimeout 轮询）/ withManifestLockAsync，锁内临界段保持全同步 FS；同进程同
 *   docId 并发经 chainDocMetaOp promise 链串行（防锁文件同 pid 自锁窗口）。
 *   探针法：锁被占用时启动 PATCH（不 await），事件循环定时器须照常触发。
 * - R31-19 [P3]：executeSave 锁内复核的 legacy 收编链改走异步清单锁孪生
 *   （lookupPathByDocIdAdoptAsync → upsertManifestEntryAsync）——行为与同步版等价
 *   （命中返回路径 + 补登记），等待期不阻塞事件循环。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService, __setMetaSaveLockTimeoutForTest, __setWiringSaveLockTimeoutForTest } from '../../src/document/service.js'
import { __setManifestLockTimeoutForTest } from '../../src/document/manifest.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'
import { readManifest } from '../../src/document/manifest.js'
import { legacyId } from '../../src/document/stable-id.js'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r31c-meta-async-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
  // 锁等待档缩到 300ms 保快（生产 5s，afterEach 还原）
  __setMetaSaveLockTimeoutForTest(300)
  __setWiringSaveLockTimeoutForTest(300)
  __setManifestLockTimeoutForTest(200)
})

afterEach(() => {
  __setMetaSaveLockTimeoutForTest(5_000)
  __setWiringSaveLockTimeoutForTest(5_000)
  __setManifestLockTimeoutForTest(5_000)
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 预置一把「活进程」同名锁（模拟另一进程在临界段内；探针法见 r29 同款）。 */
function holdLock(targetAbs: string): void {
  mkdirSync(dirname(targetAbs), { recursive: true })
  writeFileSync(`${targetAbs}.lock`, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('R31-20: meta PATCH 锁等待不阻塞事件循环', () => {
  it('updateChapterMeta 等锁期间定时器照常触发（探针），锁释放后保存成功', async () => {
    const c = await svc.createDocument({ relPath: '写作/正文/0001-开篇.md', content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文' })
    if (!c.ok) throw new Error('prereq create 失败')
    const saveLock = join(bookRoot, '工作区', '.journal', `${c.docId}.jsonl.save.lock`)
    holdLock(saveLock)
    try {
      const p = svc.updateChapterMeta(c.docId, { 标题: '新标题' })
      // 探针：等锁窗口（300ms）内 50ms 定时器必须触发——同步 Atomics.wait 形态下
      // 本断言超时红（事件循环冻结至锁等待结束）
      let probe = false
      setTimeout(() => { probe = true }, 50)
      await sleep(120)
      expect(probe).toBe(true)
      // 释放锁 → 等待中的 PATCH 正常完成
      unlinkSync(`${saveLock}.lock`)
      const r = await p
      expect(r.ok).toBe(true)
    } finally {
      if (existsSync(`${saveLock}.lock`)) unlinkSync(`${saveLock}.lock`)
    }
  })

  it('updateDocMeta 等锁期间定时器照常触发（探针），锁释放后保存成功', async () => {
    const c = await svc.createDocument({ relPath: '设定/角色/主角.md', content: '---\n标题: 主角\n---\n\n设定' })
    if (!c.ok) throw new Error('prereq create 失败')
    const saveLock = join(bookRoot, '工作区', '.journal', `${c.docId}.jsonl.save.lock`)
    holdLock(saveLock)
    try {
      const p = svc.updateDocMeta(c.docId, { 状态: '草稿' })
      let probe = false
      setTimeout(() => { probe = true }, 50)
      await sleep(120)
      expect(probe).toBe(true)
      unlinkSync(`${saveLock}.lock`)
      const r = await p
      expect(r.ok).toBe(true)
    } finally {
      if (existsSync(`${saveLock}.lock`)) unlinkSync(`${saveLock}.lock`)
    }
  })

  it('chainDocMetaOp：同 docId 并发 PATCH 串行完成（不撞同进程 pid 自锁超时）', async () => {
    const c = await svc.createDocument({ relPath: '设定/角色/配角.md', content: '---\n标题: 配角\n---\n\n设定' })
    if (!c.ok) throw new Error('prereq create 失败')
    // 两笔并发：链串行后都应成功（若自锁则第二笔 300ms 超时 WRITE_ERROR）
    const [r1, r2] = await Promise.all([
      svc.updateDocMeta(c.docId, { 标题: '甲' }),
      svc.updateDocMeta(c.docId, { 标题: '乙' }),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})

describe('R31-19: legacy 收编链异步化', () => {
  it('lookupPathByDocIdAdoptAsync：无清单登记的 legacy 文件 → 返回路径并经异步清单锁补登记', async () => {
    const rel = '设定/物品/旧物.md'
    mkdirSync(join(bookRoot, '设定', '物品'), { recursive: true })
    writeFileSync(join(bookRoot, rel), '---\n标题: 旧物\n---\n\n说明', 'utf-8')
    const id = legacyId(rel)
    const target = svc as unknown as { lookupPathByDocIdAdoptAsync: (id: string) => Promise<string | null> }
    const hit = await target.lookupPathByDocIdAdoptAsync(id)
    expect(hit).toBe(rel)
    // 补登记落盘（异步清单锁通道）
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
    expect(m.entries.get(id)?.path).toBe(rel)
    // 幂等：再查直达清单命中
    const again = await target.lookupPathByDocIdAdoptAsync(id)
    expect(again).toBe(rel)
  })

  it('非 legacy docId miss → null（不触发收编，与同步版口径一致）', async () => {
    const target = svc as unknown as { lookupPathByDocIdAdoptAsync: (id: string) => Promise<string | null> }
    expect(await target.lookupPathByDocIdAdoptAsync('doc_not_exist')).toBeNull()
  })
})

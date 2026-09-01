/**
 * R35-5（三十五轮）回归：healMovePending 崩溃自愈链异步化。
 *
 * 场景核心：服务进程 HTTP 路径（/api/state、/api/overview → detectState → healthCheck
 * → healMovePending）在书内有悬置 move pending + 跨进程清单锁被持有（CLI 批量定稿/
 * 慢盘）时，原同步版（withManifestLock + appendSettledSync 的 Atomics.wait）冻结事件
 * 循环最坏 ≈12s（含 SSE 心跳）。锁定两条契约：
 *   1. 清单锁被持有期间 detectState 可 await（30ms 定时器在等待窗内照常触发——同步版
 *      下该定时器只能等锁等待全部结束后才跑），自愈 fail-closed 报 crashedWrite、
 *      清单不被陈旧镜像改写；
 *   2. 无争用时异步自愈路径的悬置 pending 清理仍正确（补清单 + settled，不报
 *      crashedWrite）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { detectState } from '../../src/state/state.js'
import { __setManifestLockTimeoutForTest, MANIFEST_LOCK_TIMEOUT_MS, readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { appendMovePending, findUnsettled } from '../../src/document/journal.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

let bookRoot = ''
let docId = ''
let jPath = ''
let manifestPath = ''

/** 造「rename 已发生、清单未跟上」的悬置 move pending 书（new 在盘、old 不在）。 */
async function makePendingBook(): Promise<void> {
  docId = generateDocId()
  const oldRel = '写作/正文/0001-开篇.md'
  const newRel = '写作/正文/0002-开篇.md'
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, newRel),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )
  manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: docId, nodeType: 'document', path: oldRel, parentId: null })
  writeManifest(manifestPath, m)
  mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
  jPath = join(bookRoot, '工作区', '.journal', `${docId}.jsonl`)
  await appendMovePending(jPath, docId, oldRel, '写作/正文/0002-开篇.md')
}

beforeEach(async () => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r35-5-'))
  await makePendingBook()
})

afterEach(() => {
  __setManifestLockTimeoutForTest(MANIFEST_LOCK_TIMEOUT_MS)
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

test('R35-5: 清单锁被持有时事件循环不冻结（等待窗内定时器照常触发），自愈 fail-closed 报 crashedWrite', async () => {
  // 预占清单锁文件（本进程 pid 存活 → 判 held，模拟他进程持锁）：锁文件路径与
  // withManifestLockAsync 取锁同源（manifestPath + '.lock'）
  writeFileSync(`${manifestPath}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }), 'utf-8')
  __setManifestLockTimeoutForTest(100) // 缩短：2 轮 × 100ms + 50ms 间隔，总等待 ~250ms

  // 30ms 标记定时器：同步版 Atomics.wait 冻结事件循环时，它只能在 detectState 完成
  // 后才触发；异步版在锁等待窗内即触发
  let markerFired = false
  const timer = setTimeout(() => {
    markerFired = true
  }, 30)
  const d = await detectState(bookRoot, DEFAULT_CONFIG)
  clearTimeout(timer)

  expect(markerFired).toBe(true)
  // 自愈 fail-closed：锁拿不到 → 悬置 pending 未收口，报 crashedWrite 交作者
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  } else {
    expect.unreachable('清单锁 fail-closed 时应落在态 1')
  }
  // 清单不被陈旧镜像改写（entry 仍指旧路径）
  expect(readManifest(manifestPath).entries.get(docId)?.path).toBe('写作/正文/0001-开篇.md')
  // pending 仍悬置（下次锁空闲时再自愈）
  expect(findUnsettled(jPath)).toHaveLength(1)
})

test('R35-5: 无争用时异步自愈路径悬置 pending 清理仍正确（补清单 + settled）', async () => {
  const d = await detectState(bookRoot, DEFAULT_CONFIG)
  // 不因 move pending 报 crashedWrite（确定性自愈不门禁；无布线书的 wiringMissing 与本链无关）
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  }
  // 清单已对齐新路径 + journal 已配对 settled（下次进门不再处理）
  expect(readManifest(manifestPath).entries.get(docId)?.path).toBe('写作/正文/0002-开篇.md')
  expect(findUnsettled(jPath)).toHaveLength(0)
})

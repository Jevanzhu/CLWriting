/**
 * R0912-1a（2026-09-11 重评-0911c 修复批）：save 类崩溃 pending 的确定性自动消解。
 *
 * 修复前：healthCheck 对 save 类 pending 一律报 crashedWrite「可能丢字」，journal
 * compact 恒保留未结算行、无任何复核/确认通道——settled 写失败（executeSave R27-44
 * best-effort）后每次进门重复报红（幽灵红永久化）。
 *
 * 修复后：healthCheck 对 save 类 pending 读盘上文件 computeRevision 与
 * pending.baseRevision 比对——
 * - 不一致 ⇒ 该次保存实际已落盘：自动 appendSettled 消解，不再报红（本文件臂 1）；
 * - 相等 ⇒ 真未落盘：维持报红（臂 2）；
 * 保守边界（一律维持报红）：baseRevision null（journal.ts 合法形态，无从比对，臂 3）、
 * 盘上文件不存在 ENOENT（臂 4）、读盘异常非 ENOENT（mock EBUSY，保守报红 + warn
 * 留痕，臂 5）。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FAIL = vi.hoisted(() => ({ busy: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (FAIL.busy && typeof p === 'string' && p.endsWith(join('写作', '正文', '0001-开篇.md'))) {
        throw Object.assign(new Error('EBUSY: 瞬时占用（模拟同步盘扫描锁）'), { code: 'EBUSY' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { appendPending, findUnsettled } from '../../src/document/journal.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevisionBytes } from '../../src/document/revision.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { makeGitBook } from '../helpers/book.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'

const BODY_V1 = '---\n章号: 1\n标题: 开篇\n---\n\n第一版正文。\n'
const BODY_V2 = BODY_V1 + '崩溃窗内新键入的内容。\n'

/** 造书 + 清单登记 + journal 悬置 save pending（baseRevision/盘上内容由臂定制）。 */
async function makePendingBook(
  baseRevision: `sha256:${string}` | null,
  fileBody: string | null,
): Promise<{ root: string; jPath: string }> {
  const root = makeGitBook()
  const docId = generateDocId()
  const rel = '写作/正文/0001-开篇.md'
  if (fileBody !== null) writeFileSync(join(root, rel), fileBody, 'utf-8')
  const mp = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(mp)
  upsertEntry(m, { id: docId, nodeType: 'document', path: rel, parentId: null })
  writeManifest(mp, m)
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  const jPath = join(root, '工作区', '.journal', `${docId}.jsonl`)
  await appendPending(jPath, docId, baseRevision, '崩溃窗内未保存的键入快照')
  return { root, jPath }
}

test('R0912-1a: 盘上指纹已非 pending 基线（该次保存已落盘）→ 自动 settled 消解，不报红', async () => {
  // 基线 = V1 字节指纹；盘上已是 V2（atomicWrite 落盘后 settled 写失败/崩溃窗幸存态）
  const base = computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8'))
  const { root, jPath } = await makePendingBook(base, BODY_V2)
  const d = await detectState(root, DEFAULT_CONFIG)
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  }
  // journal 已补 settled（findUnsettled 清零——下次进门/compact 不再保留）
  expect(findUnsettled(jPath)).toHaveLength(0)
})

test('R0912-1a: 盘上仍是 pending 基线（真未落盘）→ 维持报红，pending 保留', async () => {
  const base = computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8'))
  const { root, jPath } = await makePendingBook(base, BODY_V1) // 盘上 = 基线
  const d = await detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  expect(findUnsettled(jPath)).toHaveLength(1)
})

test('R0912-1a: baseRevision 为 null（新建场景合法）→ 无法比对，保守维持报红', async () => {
  const { root, jPath } = await makePendingBook(null, BODY_V1)
  const d = await detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  expect(findUnsettled(jPath)).toHaveLength(1)
})

test('R0912-1a: 盘上文件不存在（ENOENT，定稿丢失面另有检查）→ 维持报红，不消解', async () => {
  const base = computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8'))
  const { root, jPath } = await makePendingBook(base, null)
  const d = await detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  expect(findUnsettled(jPath)).toHaveLength(1)
})

test('R0912-1a: 读盘异常（非 ENOENT）→ 保守报红留痕，pending 保留；恢复后消解', async () => {
  const base = computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8'))
  const { root, jPath } = await makePendingBook(base, BODY_V2)
  FAIL.busy = true // computeRevision 读盘 EBUSY → 保守报红
  const d1 = await detectState(root, DEFAULT_CONFIG)
  expect(d1.state).toBe(1)
  if (d1.state === 1) expect(d1.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  expect(findUnsettled(jPath)).toHaveLength(1)
  FAIL.busy = false // 瞬态恢复 → 下次进门自动消解（可自愈）
  const d2 = await detectState(root, DEFAULT_CONFIG)
  if (d2.state === 1) expect(d2.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  expect(findUnsettled(jPath)).toHaveLength(0)
})

test('重评-0912-4 P2-3: save 锁在持（保存进行中）→ 不报 crashedWrite 亦不消解，释放后收敛报红', async () => {
  const base = computeRevisionBytes(Buffer.from(BODY_V1, 'utf-8'))
  const { root, jPath } = await makePendingBook(base, BODY_V1) // 盘上 = 基线（在途保存的「比对相等」形态）
  const release = await acquireCrossProcessLockAsync(`${jPath}.save.lock`, 100)
  expect(release).not.toBeNull()
  const d1 = await detectState(root, DEFAULT_CONFIG)
  if (d1.state === 1) expect(d1.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  expect(findUnsettled(jPath)).toHaveLength(1) // 不消解：pending 原样（在途保存自身收尾会写 settled）
  release!()
  const d2 = await detectState(root, DEFAULT_CONFIG)
  expect(d2.state).toBe(1)
  if (d2.state !== 1) return
  expect(d2.issues.some((i) => i.kind === 'crashedWrite')).toBe(true) // 锁释放 → 真未落盘面照常报红
  expect(findUnsettled(jPath)).toHaveLength(1)
})

/**
 * R49-15（评审 R49）回归：healMovePending 同 inode 硬链中间态删旧收编 rmWithRetry。
 *
 * doMoveOrRename 的 link+rm 两步落盘在「link 成功、删源前崩溃」后留下 old/new 两端
 * 同 inode 并存的中间态；自愈删旧恰是 win 杀软/索引器瞬时锁高发点（文件刚被落位），
 * 此前裸 rmSync 直败走 catch 报 crashedWrite 误报。修复后走 rmWithRetry（退避后仍
 * 失败仍上抛走同一 catch，自愈失败语义不变）。本测以 pass-through spy 锚定路由：
 * 删旧必经 rmWithRetry（回退为裸 rmSync 则 spy 零调用即红）；自愈收口语义不变
 * （删旧 → 清单对齐新路径 → settled，不报 crashedWrite）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, linkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const rmSpyState = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...orig,
    rmWithRetry: (p: string, opts?: Parameters<typeof orig.rmWithRetry>[1]) => {
      rmSpyState.calls.push(p)
      return orig.rmWithRetry(p, opts)
    },
  }
})

import { detectState } from '../../src/state/state.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { appendMovePending, findUnsettled } from '../../src/document/journal.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

let bookRoot = ''
let docId = ''
let jPath = ''
let manifestPath = ''
let oldRel = ''
let newRel = ''

/** 造「link 成功、删源前崩溃」的同 inode 硬链中间态书（old/new 两端并存）。 */
async function makeHardlinkPendingBook(): Promise<void> {
  docId = generateDocId()
  oldRel = '写作/正文/0001-开篇.md'
  newRel = '写作/正文/0002-开篇.md'
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, newRel),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )
  linkSync(join(bookRoot, newRel), join(bookRoot, oldRel)) // 同 inode 两端并存
  manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: docId, nodeType: 'document', path: oldRel, parentId: null })
  writeManifest(manifestPath, m)
  mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
  jPath = join(bookRoot, '工作区', '.journal', `${docId}.jsonl`)
  await appendMovePending(jPath, docId, oldRel, newRel)
}

beforeEach(async () => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r49-15-heal-'))
  await makeHardlinkPendingBook()
})

afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

test('R49-15: 硬链中间态自愈删旧走 rmWithRetry（spy 锚定），收口语义不变', async () => {
  rmSpyState.calls = []
  const d = await detectState(bookRoot, DEFAULT_CONFIG)
  // 自愈确定性收口：move pending 已 heal，不报 crashedWrite
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  }
  expect(existsSync(join(bookRoot, oldRel))).toBe(false) // 旧硬链已删
  expect(existsSync(join(bookRoot, newRel))).toBe(true) // 新位内容完好
  expect(readManifest(manifestPath).entries.get(docId)?.path).toBe(newRel) // 清单对齐
  expect(findUnsettled(jPath)).toHaveLength(0) // settled 已配对
  // 路由锚定：删旧必经 rmWithRetry（回退裸 rmSync 则本断言红）
  expect(rmSpyState.calls).toHaveLength(1)
  expect(rmSpyState.calls[0]).toContain('0001-开篇.md')
})

/**
 * R37-13（三十七轮）回归：syncRenamePieceList fallback 失败不再静默。
 *
 * 背景：短篇（kind: short）改标题 → 正文 rename 后同步章纲同名文件。fallback 落位
 * 原为裸 renameSync（对已存在目标静默替换）+ catch {} 整段吞错——章纲滞留旧名零可见。
 *
 * 修复后行为（本文件锁定）：
 * 1. 未登记章纲：linkOrRenameExclusive 独占落位，旧名清理，内容不变；
 * 2. 已登记章纲：委托 doMoveOrRename（清单 path 同步更新）；
 * 3. 目标名被占：不覆盖，时间戳后缀保双份（R70-18 口径经 'exists' 分支延续）；
 * 4. 删源失败（mock rmSync 注入 EPERM，r35-27 同款先例）：回收新位 + 结构化 warn
 *    留痕，正文 rename 不受阻断。
 */
import { test, expect, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { readManifest } from '../../src/document/manifest.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// actual 经 hoisted 容器带出——用例内 mockImplementation 需要真实现做 pass-through
const actualFs = vi.hoisted(() => ({
  rmSync: undefined as unknown as typeof import('node:fs').rmSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.rmSync = actual.rmSync
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

import { rmSync as rmSyncMocked } from 'node:fs'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

const roots: string[] = []
afterEach(() => {
  vi.mocked(rmSyncMocked).mockReset()
  vi.mocked(rmSyncMocked).mockImplementation((...args) => actualFs.rmSync(...args))
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 造短篇书 + 一章正文（经 createDocument 落清单） */
async function makeShortBook(): Promise<{ root: string; svc: DocumentService; docId: string }> {
  const root = mkdtempTracked(join(tmpdir(), 'r37-piece-'))
  roots.push(root)
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, kind: 'short', book: { title: '测试书', genre: '玄幻' } })
  mkdirSync(join(root, '工作区'), { recursive: true })
  const svc = new DocumentService({ bookRoot: root })
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-旧标题.md',
    content: '---\n章号: 1\n标题: 旧标题\n---\n\n短篇正文。',
  })
  if (!c.ok) throw new Error('prereq create 失败')
  return { root, svc, docId: c.docId }
}

/** 手写一份未登记章纲（fallback 路径的入口条件） */
function writeUnregisteredPieceList(root: string, name: string): string {
  const dir = join(root, '大纲', '章纲')
  mkdirSync(dir, { recursive: true })
  const fp = join(dir, name)
  writeFileSync(fp, '---\n标题: 旧标题\n---\n\n章纲内容。', 'utf-8')
  return fp
}

test('R37-13: 未登记章纲随正文改名（独占落位 + 旧名清理 + 内容不变）', async () => {
  const { root, svc, docId } = await makeShortBook()
  writeUnregisteredPieceList(root, '0001-旧标题.md')

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)

  // 正文已改名
  expect(existsSync(join(root, '写作', '正文', '001-新标题.md'))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '0001-旧标题.md'))).toBe(false)
  // 章纲跟随改名，内容不变，旧名清理
  const newList = join(root, '大纲', '章纲', '001-新标题.md')
  expect(existsSync(newList)).toBe(true)
  expect(readFileSync(newList, 'utf-8')).toContain('章纲内容。')
  expect(existsSync(join(root, '大纲', '章纲', '0001-旧标题.md'))).toBe(false)
})

test('R37-13: 已登记章纲走 doMoveOrRename（清单 path 同步更新）', async () => {
  const { root, svc, docId } = await makeShortBook()
  const p = await svc.createDocument({ relPath: '大纲/章纲/0001-旧标题.md', content: '---\n标题: 旧标题\n---\n\n登记章纲。' })
  if (!p.ok) throw new Error('prereq create 章纲失败')

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)

  expect(existsSync(join(root, '大纲', '章纲', '001-新标题.md'))).toBe(true)
  expect(existsSync(join(root, '大纲', '章纲', '0001-旧标题.md'))).toBe(false)
  // 章纲清单条目 path 已更新（旧 path 无残留孤儿条目）
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  expect([...m.entries.values()].some((e) => e.path === '大纲/章纲/0001-旧标题.md')).toBe(false)
  expect([...m.entries.values()].some((e) => e.path === '大纲/章纲/001-新标题.md')).toBe(true)
})

test('R37-13: 目标名被占 → 不覆盖，时间戳后缀保双份', async () => {
  const { root, svc, docId } = await makeShortBook()
  writeUnregisteredPieceList(root, '0001-旧标题.md')
  // 预占目标位（手工副本）：不得被静默覆盖
  writeFileSync(join(root, '大纲', '章纲', '001-新标题.md'), '既有手工副本', 'utf-8')

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)

  expect(readFileSync(join(root, '大纲', '章纲', '001-新标题.md'), 'utf-8')).toBe('既有手工副本')
  const left = readdirSync(join(root, '大纲', '章纲')).filter((f) => /^001-新标题-旧稿-\d+\.md$/.test(f))
  expect(left).toHaveLength(1) // 同步章纲以时间戳后缀保双份
  expect(readFileSync(join(root, '大纲', '章纲', left[0]!), 'utf-8')).toContain('章纲内容。')
  expect(existsSync(join(root, '大纲', '章纲', '0001-旧标题.md'))).toBe(false)
})

test('R37-13: 删源失败（rmSync EPERM）→ 回收新位 + warn 留痕，正文改名不受阻断', async () => {
  const { root, svc, docId } = await makeShortBook()
  const oldList = writeUnregisteredPieceList(root, '0001-旧标题.md')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  // 仅对章纲旧名路径注入 EPERM（win 瞬时占用形态）；其余 rmSync（含回滚删新位）照常。
  // 按目录段+文件名匹配而非全等——resolveSafePath 走 realpath 归一（mac 上 /var →
  // /private/var），字符串全等对不上；正文旧名同文件名但路径无「章纲」段，不误伤。
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('章纲') && p.endsWith('0001-旧标题.md')) throw errOf('EPERM')
    return actualFs.rmSync(...args)
  })

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true) // 章纲同步失败不阻断正文 rename

  // 正文改名成功
  expect(existsSync(join(root, '写作', '正文', '001-新标题.md'))).toBe(true)
  // 章纲：旧名在（删源失败）、新位无残留（回滚删掉了 link 落位副本）
  expect(existsSync(oldList)).toBe(true)
  expect(readFileSync(oldList, 'utf-8')).toContain('章纲内容。')
  expect(existsSync(join(root, '大纲', '章纲', '001-新标题.md'))).toBe(false)
  expect(readdirSync(join(root, '大纲', '章纲')).filter((f) => f.includes('旧稿'))).toHaveLength(0)
  // 结构化 warn 留痕（修复前 catch {} 整段静默）
  expect(warn).toHaveBeenCalledWith('document', expect.stringContaining('章纲滞留旧名'))
})

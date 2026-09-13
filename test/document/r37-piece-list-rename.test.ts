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
  failManifestRead: false, // 重评-0912-4 P2-2：清单同步读点的瞬态锁占武装标记（时序锚见 writeFileSync 包装）
  armOnBodyManifestWrite: false, // P2-2 用例专属闸门：仅该用例按内容标记武装（本文件各用例同款改名流，不闸会互相误伤）
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.rmSync = actual.rmSync
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
    // 重评-0912-4 P2-2：strict 命中读撞瞬态锁占（EBUSY）——mock 注入形态同
    // test/state/r0912-save-pending-reconcile.test.ts 顶部先例
    readFileSync: ((p, ...rest) => {
      if (actualFs.failManifestRead && typeof p === 'string' && p.endsWith('文档清单.jsonl')) {
        throw Object.assign(new Error('mock EBUSY：清单瞬态锁占'), { code: 'EBUSY' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
    // 时序锚：清单 RMW 写落盘后，同步读点进入瞬态锁占形态（先透传后武装）。按写入
    // 内容标记而非路径——清单写走 atomicWriteFile（tmp+rename，fsync 路径 writeFileSync
    // 收 fd 数字，收不到清单路径字符串）；正文 rename 的清单 RMW 写（updateManifestPath
    // 自身 strict 读之后）序列化内容含新正文 path，恰在同步读点前武装；journal 追加走
    // appendFileSync（不经本包装），章纲清单写内容为章纲 path 不含标记，均不误伤。
    // 闸门（armOnBodyManifestWrite）仅 P2-2 用例前置 true——本文件各用例都改名到同一
    // 新正文名，无闸则内容标记会武装到既有用例的同步读点（其期望同步成功）。
    writeFileSync: ((p, ...rest) => {
      const r = (actual.writeFileSync as typeof writeFileSync)(p, ...rest)
      const data = rest[0]
      if (
        actualFs.armOnBodyManifestWrite &&
        typeof data === 'string' &&
        data.includes('写作/正文/001-新标题.md')
      ) {
        actualFs.failManifestRead = true
        actualFs.armOnBodyManifestWrite = false // 单发：武装一次即撤闸
      }
      return r
    }) as typeof writeFileSync,
  }
})

import { rmSync as rmSyncMocked } from 'node:fs'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

const roots: string[] = []
afterEach(() => {
  actualFs.failManifestRead = false
  actualFs.armOnBodyManifestWrite = false
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

// ── 重评-13（全库代码重评审 2026-09-05）：删源失败回滚链「回收新位」收编退避删 ──

test('重评-13: 回滚删新位撞瞬时 EPERM → 退避后回收干净，正文改名不受阻断', async () => {
  const { root, svc, docId } = await makeShortBook()
  const oldList = writeUnregisteredPieceList(root, '0001-旧标题.md')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  // 删源（章纲旧名）持续 EPERM → rmWithRetry 耗尽进回滚；回滚删新位首删 EPERM
  // （win 瞬时锁形态，一次后放行）。匹配口径同上用例：realpath 归一禁全等，按
  // 目录段+文件名；新位（001-新标题.md）与旧名不同名互不误伤。
  let newListRmCalls = 0
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('章纲') && p.endsWith('0001-旧标题.md')) throw errOf('EPERM')
    if (typeof p === 'string' && p.includes('章纲') && p.endsWith('001-新标题.md')) {
      newListRmCalls++
      if (newListRmCalls === 1) throw errOf('EPERM')
    }
    return actualFs.rmSync(...args)
  })

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true) // 章纲同步失败不阻断正文 rename

  // 回滚经退避后收净（收编前裸 rmSync 首删直败 → 新位孤儿副本滞留）
  expect(newListRmCalls).toBe(2) // 首删 EPERM + 退避重试成功——退避链确被走
  expect(existsSync(join(root, '大纲', '章纲', '001-新标题.md'))).toBe(false)
  expect(readdirSync(join(root, '大纲', '章纲')).filter((f) => f.includes('旧稿'))).toHaveLength(0)
  // 章纲滞留旧名 + 结构化 warn（R37-13 语义不变）
  expect(existsSync(oldList)).toBe(true)
  expect(warn).toHaveBeenCalledWith('document', expect.stringContaining('章纲滞留旧名'))
})

test('重评-13: 回滚删新位持续 EPERM → 重试耗尽吞错留孤儿副本 + warn（与裸删时代一致）', async () => {
  const { root, svc, docId } = await makeShortBook()
  const oldList = writeUnregisteredPieceList(root, '0001-旧标题.md')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  // 删源与回滚删新位均持续占用（非瞬时形态）
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('章纲')) throw errOf('EPERM')
    return actualFs.rmSync(...args)
  })

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)
  // 回滚退避耗尽仍失败 → 照旧 catch 吞掉：新位孤儿副本残留（硬链接同数据，无丢失）
  expect(existsSync(join(root, '大纲', '章纲', '001-新标题.md'))).toBe(true)
  expect(existsSync(oldList)).toBe(true)
  expect(warn).toHaveBeenCalledWith('document', expect.stringContaining('章纲滞留旧名'))
})

// ── 重评-0912-4 P2-2（2026-09-12 全量重评修复批）：章纲命中读 strict 化 ──
test('重评-0912-4 P2-2: 章纲命中读撞瞬态锁占（strict 抛）→ 滞留旧名不走裸兜底，正文改名不受阻断', async () => {
  const { root, svc, docId } = await makeShortBook()
  const p = await svc.createDocument({ relPath: '大纲/章纲/0001-旧标题.md', content: '---\n标题: 旧标题\n---\n\n登记章纲。' })
  if (!p.ok) throw new Error('prereq create 章纲失败')
  actualFs.failManifestRead = false // prereq 期间的清单写已武装标记 → 复位，只打本次改名流内 RMW 写之后的同步读点
  actualFs.armOnBodyManifestWrite = true // 撤闸：本次改名流的清单 RMW 写（内容含新正文 path）落盘即武装
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  const r = await svc.updateChapterMeta(docId, { 标题: '新标题' })
  expect(r.ok).toBe(true) // strict 读失败不阻断正文 rename
  expect(existsSync(join(root, '写作', '正文', '001-新标题.md'))).toBe(true)
  // 章纲滞留旧名：登记态未知时不走裸 rename 兜底（新位零副本，登记与盘上保持一致）
  expect(existsSync(join(root, '大纲', '章纲', '0001-旧标题.md'))).toBe(true)
  expect(existsSync(join(root, '大纲', '章纲', '001-新标题.md'))).toBe(false)
  expect(warn).toHaveBeenCalledWith('document', expect.stringContaining('章纲清单读失败'))
})

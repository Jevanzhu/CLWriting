/**
 * R41-2（四十一轮）回归：文档身份 join 键折叠（docJoinKey = relPathKey + NFC）。
 *
 * 修复前 tree.buildTree / state.findUnfinishedChapter 用精确字符串 join：
 * - win 外部 case-only 改名（资源管理器两步改名后的新拼写）→ 清单登记路径与扫描
 *   路径仅大小写异 → docId 落 legacyId、定稿章显示回草稿、进门恒报「未完成中断」。
 * - mac APFS 分解形（NFD）文件名 vs 应用 NFC 登记 → 同型失配。
 * 修复后 join 键统一 docJoinKey（win32 折叠 + NFC 归一），两形态身份保持。
 * 同族连带：overview / export / service 三处既有 relPathKey 比较面升 docJoinKey。
 */
import { test, expect, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTree, type TreeNode } from '../../src/document/tree.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { detectState } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { docJoinKey } from '../../src/fs/safe-path.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r41-join-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  return root
}

/** 登记正文文档（不写盘上文件——本测试只验 join 身份，不涉内容探测）。 */
function registerDoc(root: string, rel: string, finalized = false): string {
  const mp = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  const id = generateDocId()
  upsertEntry(m, {
    id, nodeType: 'document', path: rel, parentId: null,
    ...(finalized ? { finalizedRevision: 'deadbeef', finalizedAt: new Date().toISOString() } : {}), // 登记辅助（未用真实 revision，不涉状态机）
  })
  writeManifest(mp, m)
  return id
}

function flatNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => (n.isDirectory ? [n, ...flatNodes(n.children)] : [n]))
}

test('R41-2: buildTree NFC join——mac 分解形文件名与 NFC 登记身份不劈（平台无关）', () => {
  const root = makeBook()
  try {
    // NFC：é（U+00E9）合成形登记；盘上写分解形 e + U+0301（mac 外部工具惯存形态）
    const nfdName = '001-E\u0301tude.md'
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', nfdName), '---\n章号: 1\n标题: 外传\n---\n正文', 'utf8')
    const id = registerDoc(root, '写作/正文/001-Étude.md')
    const nodes = flatNodes(buildTree(root))
    const leaf = nodes.find((n) => !n.isDirectory && n.path.normalize('NFC').includes('001-'))
    expect(leaf?.docId).toBe(id) // 修复前：NFD 扫描路径精确 join 失配 → legacyId 兜底
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R41-2: buildTree win32 折叠 join——外部 case-only 改名后 docId 不落 legacy（钉 win32）', () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const root = makeBook()
  try {
    // 盘上新拼写小写、清单登记旧拼写大写（资源管理器 case-only 改名后的经典形态）
    writeFileSync(join(root, '写作', '正文', '001-pian.md'), '---\n章号: 1\n标题: 外传\n---\n正文', 'utf8')
    const id = registerDoc(root, '写作/正文/001-Pian.md')
    const leaf = flatNodes(buildTree(root)).find((n) => !n.isDirectory && n.path === '写作/正文/001-pian.md')
    expect(leaf?.docId).toBe(id) // 修复前：精确 join 失配 → legacyId
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R41-2: docJoinKey 单元语义（posix 保大小写 / win32 折叠 / NFC 双侧归一）', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  expect(docJoinKey('写作/A.md')).not.toBe(docJoinKey('写作/a.md')) // posix：大小写保持（R41-13 维持口径）
  expect(docJoinKey('写作/001-E\u0301tude.md')).toBe(docJoinKey('写作/001-Étude.md')) // NFC 任意平台归一
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  expect(docJoinKey('写作/A.md')).toBe(docJoinKey('写作/a.md')) // win32 折叠
})

// 状态机侧（findUnfinishedChapter）：需宿主 FS 对 case-variant 路径查找宽容
//（mac 默认卷/win NTFS 均大小写不敏感；linux 字节敏感查不到 → finalizedLost 分支，
// 与本缺陷正交），linux 腿跳过。
test.skipIf(process.platform === 'linux')(
  'R41-2: 定稿章外部 case-only 改名后（win 语义）进门不再误报中断', async () => {
    if (process.platform !== 'win32') {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    }
    const root = makeBook()
    try {
      // 定稿 001-Pian.md（fm 章号 1）→ 外部改名 001-pian.md，清单仍登记旧拼写
      const abs = join(root, '写作', '正文', '001-Pian.md')
      writeFileSync(abs, '---\n章号: 1\n标题: 外传\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n第1篇正文。', 'utf8')
      const mp = join(root, '项目', '文档清单.jsonl')
      const m = readManifest(mp)
      upsertEntry(m, {
        id: generateDocId(), nodeType: 'document', path: '写作/正文/001-Pian.md', parentId: null,
        finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
      })
      writeManifest(mp, m)
      renameSync(abs, join(root, '写作', '正文', '001-pian.md'))
      const d = await detectState(root, SHORT_CONFIG)
      // 修复前：finalizedStems 精确匹配失配 → 定稿章被算「未完成」→ 进门报中断（态≠7）
      expect(d.state).toBe(7)
      if (d.state === 7) expect(d.nextChapter).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

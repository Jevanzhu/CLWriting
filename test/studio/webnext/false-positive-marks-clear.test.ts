// @vitest-environment happy-dom
/**
 * 误报灰显键（clw-fp）清理行为族——按行为合并四散落文件（原 r51-h4-fp-prefix-single-source /
 * backlog-r60d3-check-mark-prefix / r29-fe-e8-e10-ui E-10 节 / r1010b-fe-chapter-tree-rename-fp）。
 *
 * 四条批次线钉的是同一面：误报标记的 localStorage 清理必须「键构造单源（fpBookPrefix）+
 * 书/docId 双边界精确等值」且接入所有会孤立 docId 的结构性动作链：
 * - R51-H-4（五十一轮）：clearFalsePositiveMarks 书名边界（\u0000）精确前缀，不长书名
 *   误吞、不连带旧式冒号键（R49-27 口径）；清理处不再内联重拼键。
 * - R60-D-3（六十轮）：clearFalsePositiveMarksForDoc 删键由 startsWith 前缀匹配改
 *   docId 段精确等值——a.md / a.md2 互为前缀时删 A 章不连带兄弟 B 章。
 * - E-10（二十九轮批 E）：删章动作（doDelete）接入按文档清理。
 * - R1010b-FE-P3-2（2026-09-10 内存专项重审修复批）：改名链（onRenameCommit）补同款
 *   清理——legacy docId 由路径派生，改名后旧 id 孤儿化，残留键会把旧章灰显态带给新章；
 *   book 用入口快照，在途切书清理不落空。
 *
 * 去重记录：原 E-10 第一例（裸字符串键直测只清该书该 doc）与 R60-D-3 第一/三例语义重合，
 * 且裸重拼键正是 R50-D2-1/R51-H-4 单源化要消灭的测试写法，按新口径收编不保留。
 *
 * 装置对齐 real-stores 纪律（R0916-6-P2-5）：store 全真件 + spy 副作用（tree.load），
 * 只 mock 网络面（api/documents）；原 r1010b 的全 store mock 迁真件（byPath 索引经
 * raw 种树）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（prefs-store.test 同款）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

const apiDocuments = vi.hoisted(() => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(async () => ({ ok: true })),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => apiDocuments)

import {
  clearFalsePositiveMarks,
  clearFalsePositiveMarksForDoc,
  fpBookPrefix,
} from '../../../src/studio/web-next/src/stores/check'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { setupRealStores, autoConfirm, type RealStores } from './helpers/real-stores'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

let currentBook = '书A'
let stores: RealStores

/** 种一棵带 docId 的正文叶（真 tree store 的 byPath/byDocId 索引从 raw 派生）。 */
function makeNode(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
    wordCount: 0,
  } as TreeNode
}

function seedFpKey(docId: string, value: string): string {
  const key = fpBookPrefix('书A') + docId
  localStorageMock.setItem(key, value)
  return key
}

beforeEach(() => {
  vi.clearAllMocks()
  stores = setupRealStores()
  vi.spyOn(stores.tree, 'load').mockResolvedValue(undefined) // 副作用面：树重载不在本文件断言面
  autoConfirm(stores.ui, true) // doDelete 确认框
  currentBook = '书A'
  localStorageMock.clear()
})

// ── R51-H-4 ──────────────────────────────────────────────────
describe('R51-H-4: clearFalsePositiveMarks 与 fpBookPrefix 单源', () => {
  it('清该书全部误报键；书名边界（\\u0000）精确匹配——更长书名键不误吞', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'd1', '["c1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'd2', '["c2"]')
    localStorageMock.setItem(fpBookPrefix('书AB') + 'd1', '["c9"]')

    clearFalsePositiveMarks('书A')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd1')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd2')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书AB') + 'd1')).toBe('["c9"]')
  })

  it('书名含冒号：不连带命中他书键（R49-27 改 \\u0000 分隔符的原始动机）', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'd1', '["c1"]')
    localStorageMock.setItem(fpBookPrefix('书A:B') + 'd1', '["c8"]')
    // 旧式冒号键（存量不迁移、自然失配即弃）——清理不得顺手吞掉
    localStorageMock.setItem('clw-fp:书A:d1', '["old"]')

    clearFalsePositiveMarks('书A')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd1')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A:B') + 'd1')).toBe('["c8"]')
    expect(localStorageMock.getItem('clw-fp:书A:d1')).toBe('["old"]')
  })
})

// ── R60-D-3 ──────────────────────────────────────────────────
describe('R60-D-3: clearFalsePositiveMarksForDoc 精确归属删键', () => {
  it('docId 互为字符串前缀（a.md / a.md2）：清 a.md → a.md 全清、a.md2 存活', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md2', '["ck2"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'b.md', '["ck3"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBeNull() // 目标全清
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md2')).toBe('["ck2"]') // 前缀兄弟存活
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'b.md')).toBe('["ck3"]') // 无关章不动
  })

  it('反向清除（清 a.md2）：a.md 不受牵连', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md2', '["ck2"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md2')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md2')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBe('["ck1"]')
  })

  it('书名前缀边界（\\u0000）仍精确：他书同名 docId 的键不动', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书AB') + 'a.md', '["ck9"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书AB') + 'a.md')).toBe('["ck9"]')
  })

  it('清不到时静默（无匹配键不抛错）——既有 best-effort 口径不变', () => {
    expect(() => clearFalsePositiveMarksForDoc('书C', 'none.md')).not.toThrow()
  })
})

// ── E-10（接线面）─────────────────────────────────────────────
describe('E-10: 删章动作接线——doDelete 成功即清该章灰显键', () => {
  it('doDelete 成功 → deleteDoc 发出且该章灰显键被清', async () => {
    const oldKey = seedFpKey('d1', '["ck1"]')
    stores.tree.raw = [makeNode('写作/正文/d1.md', 'd1')]
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doDelete(stores.tree.byPath.get('写作/正文/d1.md')!)
    expect(apiDocuments.deleteDoc).toHaveBeenCalledWith('书A', 'd1')
    expect(localStorageMock.getItem(oldKey)).toBeNull() // 修复点：删章即清灰显键
  })
})

// ── R1010b-FE-P3-2 ───────────────────────────────────────────
describe('R1010b-FE-P3-2: onRenameCommit 清旧 docId 误报灰显键', () => {
  it('改名成功 → 旧 fp 键清除；docId 兄弟前缀键（doc_10）不受连带', async () => {
    apiDocuments.renameDoc.mockResolvedValue(undefined)
    const oldKey = seedFpKey('doc_1', '["chk-1"]')
    const siblingKey = seedFpKey('doc_10', '["chk-2"]') // R60-D-3 精确等值口径：doc_10 不得被误删
    stores.tree.raw = [
      makeNode('写作/正文/0001-旧标题.md', 'doc_1'),
      makeNode('写作/正文/0010-兄弟.md', 'doc_10'),
    ]
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    actions.renamePath.value = '写作/正文/0001-旧标题.md'
    await actions.onRenameCommit('写作/正文/0001-旧标题.md', '新标题')
    expect(localStorageMock.getItem(oldKey)).toBeNull() // 修复前：残留（改名链漏清）
    expect(localStorageMock.getItem(siblingKey)).toBe('["chk-2"]')
  })

  it('改名在途切书：清理用入口快照书名，旧书 fp 键仍被清（不落空）', async () => {
    apiDocuments.renameDoc.mockImplementation(async () => {
      currentBook = '书B' // 重命名请求在途期间用户切书
    })
    const oldKey = seedFpKey('doc_1', '["chk-1"]')
    stores.tree.raw = [makeNode('写作/正文/0001-旧标题.md', 'doc_1')]
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    actions.renamePath.value = '写作/正文/0001-旧标题.md'
    await actions.onRenameCommit('写作/正文/0001-旧标题.md', '新标题')
    expect(localStorageMock.getItem(oldKey)).toBeNull()
  })
})

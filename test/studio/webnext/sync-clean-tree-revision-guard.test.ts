// @vitest-environment happy-dom
/**
 * 0918二轮修复批（E107）回归：syncCleanWithTree 迟到批次回写前的树 revision 复检。
 *
 * 原回写守卫只查书名/条目身份/dirty/conflict/saving——批在途期间树又刷新（重扫/
 * 结构性 mutation 推进 revision）时，本批 curRev 已过期，迟到回写把 e.treeRev 盖回
 * 旧版（下一轮 sync 整批重复重拉）并可能写入过期内容。修复：回写前复检
 * tree.revision === curRev，不符放弃回写（交下一轮按新 revision 对账）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1：doOpen 走完整载荷——委托默认包装既有 getContent mock
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = '书A'
const OLD_CONTENT = '旧内容'
const NEW_CONTENT = '外部改动后的新内容'

function makeNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

async function openCleanDoc(): Promise<{ doc: ReturnType<typeof useDocStore>; tree: ReturnType<typeof useTreeStore> }> {
  const doc = useDocStore()
  doc.setBook(BOOK)
  const tree = useTreeStore()
  tree.raw = [makeNode('d1')]
  tree.ownerBook = BOOK
  tree.revision = 'r1'
  vi.mocked(getContent).mockResolvedValueOnce(OLD_CONTENT)
  await doc.open(makeNode('d1')) // entry.treeRev = 'r1'（打开时树版本）
  return { doc, tree }
}

/** 悬挂一批 sync（getContent 在途），返回放行函数——对齐真实时序：tree.load 落定
 *  r2（revision 推进 + syncCleanWithTree(book, 'r2') 同窗发起） */
function startSync(doc: ReturnType<typeof useDocStore>, tree: ReturnType<typeof useTreeStore>): () => Promise<void> {
  let release!: () => void
  vi.mocked(getContent).mockImplementationOnce(() => new Promise((r) => (release = () => r(NEW_CONTENT))))
  tree.revision = 'r2' // 本批触发源（load 落定 r2）
  const p = doc.syncCleanWithTree(BOOK, 'r2') // 本批 curRev = 'r2'
  return async () => {
    release()
    await p
  }
}

describe('E107: syncCleanWithTree 迟到批次回写的 revision 复检', () => {
  it('批在途期间树 revision 前进（r2→r3）→ 迟到回写被丢弃（treeRev/内容不被盖回旧批）', async () => {
    const { doc, tree } = await openCleanDoc()
    const finish = startSync(doc, tree)
    // 批在途窗口：另一条树刷新链推进 revision（结构性 mutation 后 doLoad 落定 r3）
    tree.revision = 'r3'
    await finish()

    const entry = doc.get('d1')!
    // 修复点：迟到批次不回写——内容保持打开时的旧值（交下一轮 sync 按 r3 对账）
    expect(entry.content).toBe(OLD_CONTENT)
    expect(entry.treeRev).toBe('r1') // 未被盖成本批的 'r2'（下一轮仍会重拉，不漏）
  })

  it('对照：revision 未变（仍 r2）→ 正常回写内容 + treeRev 对齐本批', async () => {
    const { doc, tree } = await openCleanDoc()
    const finish = startSync(doc, tree)
    await finish()

    const entry = doc.get('d1')!
    expect(entry.content).toBe(NEW_CONTENT)
    expect(entry.treeRev).toBe('r2')
    expect(vi.mocked(getContent)).toHaveBeenLastCalledWith(BOOK, '写作/正文/d1.md')
  })
})

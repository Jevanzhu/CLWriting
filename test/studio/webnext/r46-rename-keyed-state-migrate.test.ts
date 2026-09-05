/**
 * R46-6（四十六轮）回归：书名改名的渲染层按书键控状态迁移——删除路径有完整清理链
 * （useShelf deleteBooks 五件），改名路径此前为零。migrateBookKeyedState 应把旧名键控
 * 的五族状态「清理旧名 + 值搬家到新名」：chat 章号记忆 / 失败草稿 / 机检误报灰显键族
 * （clw-fp:<书>:<文档>）/ 首启梗概 / 章节树首开标记。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { migrateBookKeyedState } from '../../../src/studio/web-next/src/composables/useShelf'
import { migrateFailedDrafts, getFailedDraft, rememberFailedDraft } from '../../../src/studio/web-next/src/composables/useChatComposer'
import { onboardPremiseKey, treeFirstOpenKey } from '../../../src/studio/web-next/src/shared/storage-keys'

/** node 环境无 localStorage——Map 桩顶上（check-store.test 同款形态，含 length/key）。 */
function stubLocalStorage(): void {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubLocalStorage()
})

describe('R46-6: migrateBookKeyedState 改名迁移五族按书键控状态', () => {
  it('五族状态旧名清理 + 新名值搬家（不丢作者既有状态）', () => {
    // ① chat 章号显式记忆
    const chat = useChatStore()
    chat.selectChatChapter('旧书', 7)
    // ② 失败草稿
    rememberFailedDraft('旧书', '未发出的草稿正文')
    // ③ 误报灰显键族（两文档）
    localStorage.setItem('clw-fp:旧书:doc-a', '1')
    localStorage.setItem('clw-fp:旧书:doc-b', '1')
    localStorage.setItem('clw-fp:别书:doc-a', '1') // 他书同文档名键不受牵连
    // ④⑤ 梗概 + 首开标记
    localStorage.setItem(onboardPremiseKey('旧书'), '梗概内容')
    localStorage.setItem(treeFirstOpenKey('旧书'), '1')

    migrateBookKeyedState('旧书', '新书')

    // 旧名全清
    expect(localStorage.getItem('clw-fp:旧书:doc-a')).toBeNull()
    expect(localStorage.getItem('clw-fp:旧书:doc-b')).toBeNull()
    expect(localStorage.getItem(onboardPremiseKey('旧书'))).toBeNull()
    expect(localStorage.getItem(treeFirstOpenKey('旧书'))).toBeNull()
    // 新名值在位
    expect(localStorage.getItem('clw-fp:新书:doc-a')).toBe('1')
    expect(localStorage.getItem('clw-fp:新书:doc-b')).toBe('1')
    expect(localStorage.getItem(onboardPremiseKey('新书'))).toBe('梗概内容')
    expect(localStorage.getItem(treeFirstOpenKey('新书'))).toBe('1')
    // 他书键不动
    expect(localStorage.getItem('clw-fp:别书:doc-a')).toBe('1')
    // 章号记忆搬家（新名可读回 7，旧名无记忆）
    expect(useChatStore().chatChapterMemoFor('旧书')).toBeUndefined()
    expect(useChatStore().chatChapterMemoFor('新书')).toBe(7)
    // 失败草稿搬家
    expect(getFailedDraft('旧书')).toBeUndefined()
    expect(getFailedDraft('新书')).toBe('未发出的草稿正文')
  })

  it('同名 no-op + 空状态幂等', () => {
    localStorage.setItem('clw-fp:书:doc', '1')
    migrateBookKeyedState('书', '书')
    expect(localStorage.getItem('clw-fp:书:doc')).toBe('1')
    migrateBookKeyedState('不存在', '别处') // 无任何状态：不抛不写
    expect(localStorage.length).toBe(1)
  })

  it('migrateFailedDrafts 单元面：值搬家 + 同名 no-op', () => {
    rememberFailedDraft('A', '草稿')
    migrateFailedDrafts('A', 'B')
    expect(getFailedDraft('A')).toBeUndefined()
    expect(getFailedDraft('B')).toBe('草稿')
    migrateFailedDrafts('B', 'B') // 同名 no-op 不丢
    expect(getFailedDraft('B')).toBe('草稿')
  })
})

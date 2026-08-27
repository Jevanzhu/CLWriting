// @vitest-environment happy-dom
/**
 * R65-52（十三轮批 E-4）回归：MetaFormPanel 表单随 content 原位变更重解析。
 * doc store 对 content 是原位变更（refresh/静默同步改 e.content、对象引用不换）——
 * 修复前 watch 源只有 entry 引用，AI 写回/refresh 后右侧表单停留在旧值。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import MetaFormPanel from '../../../src/studio/web-next/src/components/panels/MetaFormPanel.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const mocks = vi.hoisted(() => ({ updateDocMeta: vi.fn(), getConfig: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: mocks.updateDocMeta,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))

// happy-dom localStorage 缺 clear()，Map-backed 替身（照 prefs-store 范型；prefs 初始化要读）
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
vi.stubGlobal('localStorage', createLocalStorage())

function seedDoc(content: string): DocEntry {
  return {
    docId: 'd1',
    path: '大纲/章纲/0001-开篇.md',
    name: '开篇',
    role: 'chapter',
    mode: 'md',
    content,
    baselineRevision: `sha256:${'a'.repeat(64)}`,
    dirty: false,
    saving: false,
    savedAt: null,
    error: null,
    conflict: false,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.updateDocMeta.mockReset()
  mocks.getConfig.mockReset()
  mocks.getConfig.mockResolvedValue({})
})

describe('MetaFormPanel: content 原位变更重解析（R65-52）', () => {
  it('初始载入 → 按 fm 填表单字段', async () => {
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc('---\n钩子类型: 悬念钩\n字数目标: 3000\n---\n章纲正文'))
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()
    const hookInput = w.findAll('select').find((s) => s.element.value === '悬念钩')
    expect(hookInput).toBeDefined()
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('3000')
  })

  it('doc store 原位改 content（对象引用不变）→ 表单重解析到新值', async () => {
    const doc = useDocStore()
    const entry = seedDoc('---\n钩子类型: 危机钩\n---\n章纲正文')
    doc.docs.set('d1', entry)
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()
    // 模拟 refresh/静默同步：同一 entry 对象原位改 content（doc store 的实际写法——
    // 经 docs Map 的响应式代理改，对象引用不变）
    doc.get('d1')!.content = '---\n钩子类型: 悬念钩\n字数目标: 4500\n---\n章纲正文'
    await nextTick()
    // 修复前：watch 源只有 entry 引用 → 不触发，钩子停留在 危机钩、字数目标空
    const selects = w.findAll('select')
    expect(selects.some((s) => s.element.value === '悬念钩')).toBe(true)
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('4500')
  })
})

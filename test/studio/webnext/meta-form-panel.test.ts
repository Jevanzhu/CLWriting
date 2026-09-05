// @vitest-environment happy-dom
/**
 * R65-52（十三轮批 E-4）回归：MetaFormPanel 表单随 content 原位变更重解析。
 * doc store 对 content 是原位变更（refresh/静默同步改 e.content、对象引用不换）——
 * 修复前 watch 源只有 entry 引用，AI 写回/refresh 后右侧表单停留在旧值。
 * R49-30（四十九轮）：解析源换 useDebouncedFmFields 150ms 防抖（同族面板同款）——
 * content 变化不再即时重解析（键入后一拍内不与 CM6 输入争预算）；docId 切换仍
 * 即刻重算（防抖核 key-change flush）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

afterEach(() => {
  vi.useRealTimers() // R49-30 防抖用例的 fake timers 复位（未启用时 no-op）
})

describe('MetaFormPanel: content 原位变更重解析（R65-52 / R49-30 防抖）', () => {
  it('初始载入 → 按 fm 填表单字段（首屏即时，不等防抖窗）', async () => {
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc('---\n钩子类型: 悬念钩\n字数目标: 3000\n---\n章纲正文'))
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()
    const hookInput = w.findAll('select').find((s) => s.element.value === '悬念钩')
    expect(hookInput).toBeDefined()
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('3000')
  })

  it('doc store 原位改 content（对象引用不变）→ 防抖窗内不重解析，150ms 后重解析到新值', async () => {
    vi.useFakeTimers()
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
    // R49-30 修复点①：解析进 150ms 防抖窗——此拍不重解析（修复前即时重算）
    expect(w.findAll('select').some((s) => s.element.value === '悬念钩')).toBe(false)
    // 防抖窗走完 → 重解析落位（R65-52 回归点：原位变更仍能驱动表单）
    vi.advanceTimersByTime(150)
    await nextTick()
    const selects = w.findAll('select')
    expect(selects.some((s) => s.element.value === '悬念钩')).toBe(true)
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('4500')
  })
})

describe('MetaFormPanel: 编辑中脏键保护（R69-5）', () => {
  it('用户改过未保存的字段在异步 refresh（content 原位变更）时保留；干净键取服务端新值', async () => {
    vi.useFakeTimers()
    const doc = useDocStore()
    const entry = seedDoc('---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文')
    doc.docs.set('d1', entry)
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()
    // 用户编辑「字数目标」（脏键），「钩子类型」未动（干净键）
    const num = w.find('input[type="number"]')
    await num.setValue('5000')
    // 异步 refresh 迟到（如顶栏标题 blur 提交触发 doc.refresh）：content 原位变更
    doc.get('d1')!.content = '---\n钩子类型: 悬念钩\n字数目标: 3000\n---\n章纲正文'
    await nextTick()
    vi.advanceTimersByTime(150) // R49-30：重解析随防抖窗落位
    await nextTick()
    // 脏键保用户输入；干净键取服务端新值
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('5000')
    expect(w.findAll('select').some((s) => s.element.value === '悬念钩')).toBe(true)
  })

  it('切文档（entry 引用变化）→ 整体重灌且即刻（防抖核 key-change flush，不滞留旧文档值）', async () => {
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc('---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文'))
    doc.docs.set('d2', { ...seedDoc('---\n钩子类型: 悬念钩\n字数目标: 2000\n---\n另一章'), docId: 'd2' })
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()
    await w.find('input[type="number"]').setValue('5000')
    useWorkspaceStore().activeDocId = 'd2'
    await nextTick() // 无需推进防抖窗：docId 切换即刻重算
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('2000')
  })
})

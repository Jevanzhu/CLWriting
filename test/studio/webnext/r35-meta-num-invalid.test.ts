// @vitest-environment happy-dom
/**
 * R35-35（三十五轮批 E）回归：MetaFormPanel 数值字段非法输入在保存前置校验拦截。
 * 修复前：'1e999'（Number → Infinity）等非有限值在 PUT 循环里被静默 continue 丢弃、
 * 其余字段照存且 toast「已保存」——半截保存的静默谎言。修复后：保存前全量校验数值
 * 字段，非法即标错（field-input-err + field-err-msg）+ error toast + 不发任何 PUT；
 * 用户改正输入（@input）即清错，再保存正常。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import MetaFormPanel from '../../../src/studio/web-next/src/components/panels/MetaFormPanel.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const mocks = vi.hoisted(() => ({
  updateDocMeta: vi.fn(),
  getConfig: vi.fn(),
  getContent: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: mocks.updateDocMeta,
  getContent: mocks.getContent,
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))

// happy-dom localStorage 缺 clear()，Map-backed 替身（照 meta-form-panel.test.ts 范型）
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

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const doc = useDocStore()
  doc.docs.set('d1', seedDoc('---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文'))
  useWorkspaceStore().activeDocId = 'd1'
  const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
  await nextTick()
  return w
}

/** 章纲字段集里唯一的数值字段（字数目标） */
function numInput(w: ReturnType<typeof mount>) {
  return w.find('input[type="number"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({})
  mocks.getContent.mockResolvedValue('---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文')
})

describe('R35-35: MetaFormPanel 数值非法中止保存', () => {
  it("字数目标 '1e999'（Number=Infinity）→ 不发 PUT、error toast、字段标错", async () => {
    const w = await mountPanel()
    await numInput(w).setValue('1e999')
    await w.find('.save-btn').trigger('click')
    await flushPromises()

    // 修复点：非法数值不发任何 PUT（修复前静默丢该键、其余照存 + toast 已保存）
    expect(mocks.updateDocMeta).not.toHaveBeenCalled()
    const ui = useUiStore()
    const kinds = ui.toasts.map((t) => t.kind)
    expect(kinds).toContain('error')
    expect(kinds).not.toContain('success')
    // 字段级错误渲染：输入框标红 + 错误消息
    expect(numInput(w).classes()).toContain('field-input-err')
    expect(w.find('.field-err-msg').text()).toContain('须为数字')
  })

  it("改正为 '3000'（@input）→ 错误即时清除，再保存成功 PUT 数值", async () => {
    const w = await mountPanel()
    await numInput(w).setValue('1e999')
    await w.find('.save-btn').trigger('click')
    await flushPromises()
    expect(w.find('.field-err-msg').exists()).toBe(true)

    // 输入即清错（@input="delete numErrors[f.key]"），无需再点保存
    await numInput(w).setValue('3000')
    await nextTick()
    expect(w.find('.field-err-msg').exists()).toBe(false)
    expect(numInput(w).classes()).not.toContain('field-input-err')

    mocks.updateDocMeta.mockResolvedValue({})
    await w.find('.save-btn').trigger('click')
    await flushPromises()
    // 保存成功链末端的 doc.refresh 内含真实 WebCrypto digest——补一拍宏任务再断言 toast
    await new Promise((r) => setTimeout(r, 5))
    await flushPromises()

    expect(mocks.updateDocMeta).toHaveBeenCalledWith('书测', 'd1', expect.objectContaining({ 字数目标: 3000 }))
    expect(useUiStore().toasts.map((t) => t.kind)).toContain('success')
  })

  it('空值（清空字段）不触发校验拦截——照发 PUT（R75-E-P3f 清空合法）', async () => {
    const w = await mountPanel()
    await numInput(w).setValue('')
    mocks.updateDocMeta.mockResolvedValue({})
    await w.find('.save-btn').trigger('click')
    await flushPromises()

    expect(mocks.updateDocMeta).toHaveBeenCalledWith('书测', 'd1', expect.objectContaining({ 字数目标: '' }))
    expect(w.find('.field-err-msg').exists()).toBe(false)
  })
})

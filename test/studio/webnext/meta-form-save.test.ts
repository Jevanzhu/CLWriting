// @vitest-environment happy-dom
/**
 * MetaFormPanel 保存链两组守卫：数值前置校验与在途锁。
 *
 * R35-35（三十五轮批 E）：数值字段非法输入在保存前置校验拦截——修复前 '1e999'
 * （Number → Infinity）等非有限值在 PUT 循环里被静默 continue 丢弃、其余字段照存且
 * toast「已保存」——半截保存的静默谎言。修复后：保存前全量校验数值字段，非法即标错
 * （field-input-err + field-err-msg）+ error toast + 不发任何 PUT；用户改正输入
 * （@input）即清错，再保存正常。
 *
 * R61-G-1（P3）：MetaFormPanel.onSave 缺函数级在途锁——模板仅 :disabled="saving"
 * 拦鼠标主路径，且 saving 置位在数值校验之后——校验到置位之间的快速连点/重入（用例
 * 经函数直调连发两次 onSave，不等第一笔完成）会并发两笔 updateDocMeta。补函数首行
 * `if (saving.value) return`，对齐全域 OnboardView / WorkbenchView / HistoryPanel
 * 同款惯例。
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

async function mountPanel(content = '---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文'): Promise<ReturnType<typeof mount>> {
  const doc = useDocStore()
  doc.docs.set('d1', seedDoc(content))
  useWorkspaceStore().activeDocId = 'd1'
  const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
  await nextTick()
  return w
}

/** 章纲字段集里唯一的数值字段（字数目标） */
function numInput(w: ReturnType<typeof mount>) {
  return w.find('input[type="number"]')
}

/** 起一个手动放行的 Promise（模拟在途请求；save-double-submit-lock 同款） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockReset()
  mocks.getConfig.mockResolvedValue({})
  mocks.getContent.mockReset()
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
    // 保存成功链末端的 doc.refresh 内含真实 WebCrypto digest——泵一拍宏任务再断言 toast
    await new Promise((r) => setTimeout(r, 0))
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

describe('R61-G-1: MetaFormPanel.onSave 在途锁（保存中连点只发一笔）', () => {
  it('第一笔在途未落定时快速连调第二次 onSave → updateDocMeta 仅发一次（修复前并发两笔）', async () => {
    const req = pending<unknown>()
    mocks.updateDocMeta.mockReturnValue(req.promise)
    const w = await mountPanel()

    // 连点语义经函数直调：happy-dom/VTU 对 disabled 按钮的合成点击（trigger 与
    // raw dispatchEvent）均被压制，正需绕过模板 :disabled 检验函数级在途锁本体
    const vm = w.vm as unknown as { onSave: () => Promise<void> }
    const p1 = vm.onSave() // 第一笔（在途挂起；saving 在首个 await 前同步置位）
    const p2 = vm.onSave() // 连点第二笔（未等第一笔完成）
    // updateDocMeta 在各自首个 await 点同步发出：此刻计数即最终并发数
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(1) // 修复点：在途锁拦住第二笔（修复前=2）

    req.resolve({})
    await Promise.allSettled([p1, p2])
    await flushPromises()
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(1) // 放行后也不补发
    w.unmount()
  })

  it('对照：首笔完成后可再次保存（在途锁不误伤常规连续保存）', async () => {
    mocks.updateDocMeta.mockResolvedValue({})
    const w = await mountPanel('---\n钩子类型: 危机钩\n---\n章纲正文')

    await w.find('.save-btn').trigger('click')
    await flushPromises()
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(1)
    await w.find('.save-btn').trigger('click') // 首笔已落定（saving 复位）→ 放行
    await flushPromises()
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(2)
    w.unmount()
  })
})

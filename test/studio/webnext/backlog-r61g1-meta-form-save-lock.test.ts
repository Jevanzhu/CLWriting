// @vitest-environment happy-dom
/**
 * R61-G-1（P3）回归：MetaFormPanel.onSave 缺函数级在途锁。
 *
 * 模板仅 `:disabled="saving"` 拦鼠标主路径，且 saving 置位在数值校验之后——校验到
 * 置位之间的快速连点/重入（用例经函数直调连发两次 onSave，不等第一笔完成）会并发
 * 两笔 updateDocMeta。补函数首行 `if (saving.value) return`，对齐全域 OnboardView /
 * WorkbenchView / HistoryPanel 同款惯例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
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

/** 起一个手动放行的 Promise（模拟在途请求；r73-double-submit-guards 同款） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.updateDocMeta.mockReset()
  mocks.getConfig.mockReset()
  mocks.getConfig.mockResolvedValue({})
})

describe('R61-G-1: MetaFormPanel.onSave 在途锁（保存中连点只发一笔）', () => {
  it('第一笔在途未落定时快速连调第二次 onSave → updateDocMeta 仅发一次（修复前并发两笔）', async () => {
    const req = pending<unknown>()
    mocks.updateDocMeta.mockReturnValue(req.promise)
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc('---\n钩子类型: 危机钩\n字数目标: 3000\n---\n章纲正文'))
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()

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
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc('---\n钩子类型: 危机钩\n---\n章纲正文'))
    useWorkspaceStore().activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: '书测' } })
    await nextTick()

    await w.find('.save-btn').trigger('click')
    await flushPromises()
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(1)
    await w.find('.save-btn').trigger('click') // 首笔已落定（saving 复位）→ 放行
    await flushPromises()
    expect(mocks.updateDocMeta).toHaveBeenCalledTimes(2)
    w.unmount()
  })
})

// @vitest-environment happy-dom
/**
 * R35-9（三十五轮）回归：带未决冲突的脏文档存在时，改名前置拦截。
 * flushDirty 的过滤器（dirty && !saving && !conflict）不含冲突项——修复前改名只查
 * flushDirty 失败清单，conflict+dirty 文档既不落盘也不计入 failed，照常改名后 Z-8
 * 「留在本书」回退到已搬走的旧书目录（树/心跳/SSE/保存全 404）。修复后：存在冲突
 * 脏文档 → error toast 引导先解决冲突，改名中止（不调 renameBook）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBook from '../../../src/studio/web-next/src/components/ui/SettingsBook.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  renameBook: vi.fn(),
  routerReplace: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  renameBook: mocks.renameBook,
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ replace: mocks.routerReplace }) }))

function seedConflictDoc(conflict: boolean, dirty: boolean): DocEntry {
  return {
    docId: 'd1',
    path: '写作/正文/第一卷/0001-开篇.md',
    name: '开篇',
    role: 'chapter',
    mode: 'text',
    content: '正文',
    baselineRevision: `sha256:${'a'.repeat(64)}`,
    dirty,
    saving: false,
    savedAt: null,
    error: conflict ? '此文档已在其他地方修改' : null,
    conflict,
  }
}

async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '旧名'
  const wrapper = mount(SettingsBook, {
    global: {
      provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig },
      stubs: { SettingsBookWriting: true, SettingsBookAnalysis: true, SettingsBookRetention: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({ kind: 'long', book: { title: '旧名' } } satisfies BookConfig)
  mocks.renameBook.mockResolvedValue({ ok: true, renamed: true, name: '新名', path: '长篇/新名' })
})

describe('R35-9: 改名前置拦截冲突脏文档', () => {
  it('存在 conflict+dirty 文档 → error toast + 不调 renameBook + 不切路由', async () => {
    const doc = useDocStore()
    doc.docs.set('d1', seedConflictDoc(true, true))
    const ui = useUiStore()
    const wrapper = await mountOpen()

    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(ui.toasts.at(-1)?.kind).toBe('error')
    expect(ui.toasts.at(-1)?.msg).toContain('冲突')
    wrapper.unmount()
  })

  it('无冲突文档 → 守卫不误伤，改名照常发起', async () => {
    const doc = useDocStore()
    // clean 文档（无 conflict 无 dirty）：flushDirty 空转、conflictedDirtyDocs 为空，
    // 前置守卫不得拦截正常改名（不发任何保存 API）
    doc.docs.set('d1', seedConflictDoc(false, false))
    const wrapper = await mountOpen()

    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).toHaveBeenCalledWith('旧名', '新名')
    wrapper.unmount()
  })
})

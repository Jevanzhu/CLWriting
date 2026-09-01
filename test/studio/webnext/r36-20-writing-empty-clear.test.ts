// @vitest-environment happy-dom
/**
 * R36-20（三十六轮）：清空目标字数/每章字数输入写 0 而非清键。
 *
 * 原实现 `Number((e.target as HTMLInputElement).value)`——`Number('')===0` 穿过
 * `>= 0` 闸，清空输入被写成 `target_words: 0`，注释自称「空/非法 = 清键回跟随」与
 * 行为相反（R72-11 helper 全库唯一偏离点）。修复：接 parseNumericInput（空串 → null），
 * 空/非法 → 清键（写 undefined）；合法数字（含 0 = 显式未设语义）照常写值。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBookWriting from '../../../src/studio/web-next/src/components/ui/SettingsBookWriting.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))

async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '测试书'
  const wrapper = mount(SettingsBookWriting, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

function captureMutator(): (cfg: BookConfig) => void {
  let captured: ((c: BookConfig) => void) | undefined
  mocks.saveConfig.mockImplementation((mut: (c: BookConfig) => void) => {
    captured = mut
    return Promise.resolve()
  })
  return (cfg: BookConfig) => captured!(cfg)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 书级已设目标字数/每章字数（覆盖组点亮，子项可见）
  mocks.getConfig.mockResolvedValue({
    kind: 'long',
    book: { title: '测试书', target_words: 1_000_000, chapter_target_words: 3000 },
  } satisfies BookConfig)
})

describe('R36-20：目标字数/每章字数 空输入清键（接 R72-11 helper）', () => {
  it('目标字数清空输入 → 写 undefined 而非 0（清键回跟随全局）', async () => {
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="目标字数"]')
    expect((input.element as HTMLInputElement).value).toBe('1000000')

    const run = captureMutator()
    await input.setValue('') // 清空输入框
    const cfg = { book: { title: '测试书', target_words: 1_000_000, chapter_target_words: 3000 } } as BookConfig
    run(cfg)
    // 修复点：原实现 `Number('')===0` 写 0；现走 helper 空串→null→清键
    expect(cfg.book?.target_words).toBeUndefined()
    // 他键不受影响
    expect(cfg.book?.chapter_target_words).toBe(3000)
    wrapper.unmount()
  })

  it('目标字数合法输入 → 照常写值（含 0 = 显式未设语义保留）', async () => {
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="目标字数"]').setValue('250000')
    let cfg = { book: { title: '测试书' } } as BookConfig
    run(cfg)
    expect(cfg.book?.target_words).toBe(250000)

    // 显式输入 0：合法值，写 0（注释语义「0 = 显式未设、保留覆盖」不变）
    const run2 = captureMutator()
    await wrapper.find('input[aria-label="目标字数"]').setValue('0')
    cfg = { book: { title: '测试书' } } as BookConfig
    run2(cfg)
    expect(cfg.book?.target_words).toBe(0)
    wrapper.unmount()
  })

  it('目标字数非法输入（非数字）→ 清键（与空输入同口径）', async () => {
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="目标字数"]').setValue('abc')
    const cfg = { book: { title: '测试书', target_words: 1_000_000 } } as BookConfig
    run(cfg)
    expect(cfg.book?.target_words).toBeUndefined()
    wrapper.unmount()
  })

  it('每章字数清空输入 → 同样清键而非写 0', async () => {
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="每章字数"]').setValue('')
    const cfg = { book: { title: '测试书', target_words: 1_000_000, chapter_target_words: 3000 } } as BookConfig
    run(cfg)
    expect(cfg.book?.chapter_target_words).toBeUndefined()
    wrapper.unmount()
  })

  it('每卷章数空输入 → 维持原清键语义（未受影响路径不回归）', async () => {
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="每卷章数"]').setValue('')
    const cfg = { book: { title: '测试书' } } as BookConfig
    run(cfg)
    expect(cfg.book?.volume_size).toBeUndefined()
    wrapper.unmount()
  })
})
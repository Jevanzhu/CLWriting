/**
 * R72-22（二十轮 G-8）：useAiAssist composable 单测（对齐 useShelf 范式：mock store/api 层）。
 * 契约：无选区非续写 → toast 拦截不执行；续写无选区 → isAppend=true 落 append 通道
 *（空白页/卡壳时刻）；有选区 → 带选区执行；缺 activeDocId → 静默不执行；
 * 执行前必切右侧 review tab（产出落 rewrite 面板）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  editorGetSelection: vi.fn((): string | undefined => ''),
  activeDocId: 'doc_1' as string | null,
  rewriteRun: vi.fn(async () => {}),
  toast: vi.fn(),
  setRightTab: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get bookName() {
      return '测试书'
    },
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({
    get editorGetSelection() {
      return mocks.editorGetSelection
    },
    get activeDocId() {
      return mocks.activeDocId
    },
    setRightTab: mocks.setRightTab,
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.toast })),
}))
vi.mock('../../../src/studio/web-next/src/stores/rewrite', () => ({
  useRewriteStore: vi.fn(() => ({ run: mocks.rewriteRun })),
}))

import { useAiAssist } from '../../../src/studio/web-next/src/composables/useAiAssist'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.editorGetSelection.mockReturnValue('')
  mocks.activeDocId = 'doc_1'
})

describe('useAiAssist: 指令表', () => {
  it('四动作齐备：扩写/缩写/润色/续写，instruction 非空', () => {
    const { aiActions } = useAiAssist()
    expect(aiActions.map((a) => a.key)).toEqual(['expand', 'condense', 'polish', 'continue'])
    for (const a of aiActions) {
      expect(a.label.length).toBeGreaterThan(0)
      expect(a.instruction.length).toBeGreaterThan(0)
    }
  })
})

describe('useAiAssist: runAiAssist 执行契约', () => {
  it('有选区 → 带选区执行（isAppend=false）并切 review tab', async () => {
    mocks.editorGetSelection.mockReturnValue('被选中的段落')
    const { aiActions, runAiAssist } = useAiAssist()
    await runAiAssist(aiActions[0]!)
    expect(mocks.setRightTab).toHaveBeenCalledWith('review')
    expect(mocks.rewriteRun).toHaveBeenCalledWith('测试书', 'doc_1', aiActions[0]!.instruction, '被选中的段落', false)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('无选区非续写 → toast 拦截，不执行不切 tab', async () => {
    const { aiActions, runAiAssist } = useAiAssist()
    await runAiAssist(aiActions[1]!) // condense 需选区靶点
    expect(mocks.toast).toHaveBeenCalledWith('请先选中要操作的文字', 'info')
    expect(mocks.rewriteRun).not.toHaveBeenCalled()
    expect(mocks.setRightTab).not.toHaveBeenCalled()
  })

  it('无选区续写 → append 通道（isAppend=true，空白页/卡壳时刻）', async () => {
    const { aiActions, runAiAssist } = useAiAssist()
    await runAiAssist(aiActions[3]!) // continue
    expect(mocks.rewriteRun).toHaveBeenCalledWith('测试书', 'doc_1', aiActions[3]!.instruction, '', true)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('有选区续写 → 仍按选区改写（isAppend=false）', async () => {
    mocks.editorGetSelection.mockReturnValue('选段')
    const { aiActions, runAiAssist } = useAiAssist()
    await runAiAssist(aiActions[3]!)
    expect(mocks.rewriteRun).toHaveBeenCalledWith('测试书', 'doc_1', aiActions[3]!.instruction, '选段', false)
  })

  it('无 activeDocId → 静默不执行（含续写 append 通道）', async () => {
    mocks.activeDocId = null
    const { aiActions, runAiAssist } = useAiAssist()
    await runAiAssist(aiActions[3]!)
    expect(mocks.rewriteRun).not.toHaveBeenCalled()
    expect(mocks.setRightTab).not.toHaveBeenCalled()
  })
})

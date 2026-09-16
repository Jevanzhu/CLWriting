/**
 * web-next 前端测试装法：真实 Pinia store + mock api 层（R0916-6-P2-5，评审修复批）。
 *
 * 纪律（文件头即契约，新测试照此执行）：新测试不 mock 兄弟 store（stores/ui、
 * stores/workspace、stores/tree…）——整 store mock 把状态机一起假掉，测出的只是接线
 * 形状；需要隔离的是网络面（src/studio/web-next/src/api/**，仍应 vi.mock），副作用面
 * （toast/确认框/load 等动作）用本 helper 的 spy 装法替换，store 状态保持真件。
 *
 * 装法说明：createTestingPinia 未进依赖，手写 `setActivePinia(createPinia())` +
 * `vi.spyOn(store, action)`（dead-instance-guard 先例同口径，setup store 动作可 spy）。
 * spy 分两档：record（调用照常生效，toasts 状态可见，兼得调用断言）与 mute（动作整体
 * 置 no-op，供「不弹」断言或屏蔽定时器）。存量 mock 兄弟 store 的旧测试按此口径渐进
 * 迁移（先锋批 2026-09-16），余量登记台账收敛。
 */
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'
import { useTreeStore } from '../../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../../src/studio/web-next/src/stores/workspace'
import { useDocStore } from '../../../../src/studio/web-next/src/stores/doc'

/** 真 store 手：同一 pinia 实例，与被测组件/composable 内 useXxxStore() 取到同一份。 */
export interface RealStores {
  pinia: Pinia
  ui: ReturnType<typeof useUiStore>
  tree: ReturnType<typeof useTreeStore>
  ws: ReturnType<typeof useWorkspaceStore>
  doc: ReturnType<typeof useDocStore>
}

/** 建新 pinia 并激活，返回真 store 手。每用例（beforeEach）调一次，防跨用例串态。 */
export function setupRealStores(): RealStores {
  const pinia = createPinia()
  setActivePinia(pinia)
  return {
    pinia,
    ui: useUiStore(),
    tree: useTreeStore(),
    ws: useWorkspaceStore(),
    doc: useDocStore(),
  }
}

/** 录制 ui.toast（真件照常执行，ui.toasts 状态可见），返回 spy 供调用断言。 */
export function recordToasts(ui: RealStores['ui']) {
  return vi.spyOn(ui, 'toast')
}

/** 静默 ui.toast（不落 state、不起消失定时器），返回 spy 供 not-called 断言。 */
export function muteToasts(ui: RealStores['ui']) {
  return vi.spyOn(ui, 'toast').mockImplementation(() => {})
}

/** 自动确认 ui.ask（默认 true，等价旧 mock 的 `ask: async () => true`），返回 spy 供断言弹窗文案。 */
export function autoConfirm(ui: RealStores['ui'], v = true) {
  return vi.spyOn(ui, 'ask').mockResolvedValue(v)
}

// @vitest-environment happy-dom
/**
 * 四轮-E403 回归：事件流 self_heal_result 终局标签补 failed 分支。
 *
 * 机理（全量源码独立重评四轮 E403）：outcome 白名单（sse-guards.isHealResultEvent，
 * 与服务端 HEAL_OUTCOMES 一致）含 failed，WbAdvanced.evLabel 的标签表此前只有
 * pass/escalate/aborted——failed 落英文原文。修复补 `failed: '失败'`（对齐同表
 * 中文风格）。挂载形态：WbAdvanced 零 API 运行时依赖（trace-stats 仅 type import），
 * CollapseSection 内容 v-show 常驻 DOM，可独立挂载断言事件流文本。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WbAdvanced from '../../../src/studio/web-next/src/components/workbench/WbAdvanced.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

describe('四轮-E403: self_heal_result 终局标签', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('outcome=failed → 渲染「失败」，不再落英文原文；既有三终局标签不回归', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_result', outcome: 'pass' })
    wb.dispatch({ type: 'self_heal_result', outcome: 'escalate', reds: ['红A'] })
    wb.dispatch({ type: 'self_heal_result', outcome: 'aborted' })
    wb.dispatch({ type: 'self_heal_result', outcome: 'failed', error: 'boom' })

    const w = mount(WbAdvanced, { props: { ruleHits: [] } })
    const stream = w.get('.stream').text()
    expect(stream).toContain('自检结果：通过')
    expect(stream).toContain('自检结果：需人工确认')
    expect(stream).toContain('自检结果：已中断')
    expect(stream).toContain('自检结果：失败') // 修复点：failed 不再落英文原文
    expect(stream).not.toContain('自检结果：failed')
    w.unmount()
  })
})

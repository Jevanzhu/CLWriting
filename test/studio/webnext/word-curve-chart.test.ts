// @vitest-environment happy-dom
/**
 * M-P3-14（内存核查 2026-08-25）：字数曲线端点降采样。
 * 原实现每章一对 <circle>+<title>（2000 章 ≈ 4000 SVG 节点，仅视觉裁剪不减 DOM），
 * 而 X 轴标签已按 tickStep 降到 ~20 个 → circle 端点改按同一 tickStep 口径降采样
 * （仅每隔 step 章画点，title 悬浮语义保留在画出的点上；折线路径不动）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WordCurveChart from '../../../src/studio/web-next/src/components/overview/WordCurveChart.vue'
import type { RhythmLong } from '../../../src/studio/web-next/src/api/rhythm'

/** 千章 wordCurve（字数起伏即可，触发降采样的是章数） */
function rhythm(n: number): RhythmLong {
  return {
    kind: 'long',
    wordCurve: Array.from({ length: n }, (_, i) => ({
      章号: i + 1,
      标题: `第${i + 1}章标题`,
      字数: 2000 + ((i * 37) % 1500),
    })),
    avgWords: 2500,
    chapterDiff: [],
    written: {
      count: n,
      hookTypeDist: {},
      hookLevelDist: {},
      emotionDist: {},
      sceneDist: {},
      sceneEmotion: {},
    },
    planned: { count: n, hookTypeDist: {}, hookLevelDist: {}, emotionDist: {}, sceneDist: {}, targetWords: 2500 },
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  wrapper = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('M-P3-14: 字数曲线端点降采样（与 X 轴标签同 tickStep 口径）', () => {
  it('1000 章挂载：circle 数量 ≤ 标签数×2+2（≈每 tick 一点，非千节点全量）', () => {
    wrapper = mount(WordCurveChart, { props: { rhythmData: rhythm(1000) } })
    const svg = wrapper.element
    const circles = svg.querySelectorAll('circle.word-dot')
    const labels = svg.querySelectorAll('text.axis-label-x')
    // 1000 章 → tickStep=50 → 标签 20 个；circle 同口径也应 ~20（远小于旧全量 1000）
    expect(circles.length).toBe(labels.length)
    expect(circles.length).toBeLessThanOrEqual(labels.length * 2 + 2)
    // 画出的点保留 title 悬浮语义（章号/标题/字数仍在）
    const first = circles[0]!.querySelector('title')
    expect(first?.textContent).toContain('第1章')
    expect(first?.textContent).toContain('字')
    // 折线路径不动（每章一点的全量曲线仍完整）
    expect(svg.querySelectorAll('path.word-line')).toHaveLength(1)
  })

  it('短书（未触发降采样）：每章仍有点，不误伤常规规模', () => {
    wrapper = mount(WordCurveChart, { props: { rhythmData: rhythm(8) } })
    const svg = wrapper.element
    // 8 章 → tickStep=1 → 每章一个端点
    expect(svg.querySelectorAll('circle.word-dot').length).toBe(8)
    expect(svg.querySelectorAll('text.axis-label-x').length).toBe(8)
  })

  it('无数据：整节隐藏（回归护栏）', () => {
    wrapper = mount(WordCurveChart, { props: { rhythmData: null } })
    expect(wrapper.find('svg').exists()).toBe(false)
  })
})

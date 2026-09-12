// @vitest-environment happy-dom
/**
 * R0912-3 #22（2026-09-12 全量代码重评修复批）：节奏分布短篇模式行尾「n/0」规划占位。
 * 短篇无 planned（distGroups 恒 planned:{}），原模板无条件渲染「已写/规划」双数 →
 * 每行出现「2/0」假规划数据；修后行尾规划段仅长篇（kind==='long'）渲染。长篇照旧。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RhythmDistPanel from '../../../src/studio/web-next/src/components/overview/RhythmDistPanel.vue'
import type { RhythmLong, RhythmShort } from '../../../src/studio/web-next/src/api/rhythm'

function longData(): RhythmLong {
  return {
    kind: 'long',
    wordCurve: [],
    avgWords: 100,
    chapterDiff: [],
    written: {
      count: 3,
      hookTypeDist: { 危机钩: 2 },
      hookLevelDist: {},
      emotionDist: {},
      sceneDist: {},
      sceneEmotion: {},
    },
    planned: {
      count: 5,
      hookTypeDist: { 危机钩: 4 },
      hookLevelDist: {},
      emotionDist: {},
      sceneDist: {},
      targetWords: 0,
    },
  }
}

function shortData(): RhythmShort {
  return {
    kind: 'short',
    wordCurve: [],
    emotionDist: {},
    reversalGap: [],
    reversalUnrecognized: 0,
    reversals: [],
    written: {
      count: 2,
      hookTypeDist: { 危机钩: 2 },
      hookLevelDist: {},
      emotionDist: {},
      sceneDist: {},
    },
  }
}

describe('R0912-3 #22: RhythmDistPanel 行尾规划占位按模式渲染', () => {
  it('短篇：行尾只渲染已写数，不再出现「n/0」规划占位与规划标线', () => {
    const w = mount(RhythmDistPanel, { props: { rhythmData: shortData() } })
    const vals = w.findAll('.dist-val')
    expect(vals.length).toBeGreaterThan(0)
    for (const v of vals) expect(v.text()).not.toContain('/')
    expect(w.find('.dist-target').exists()).toBe(false)
    w.unmount()
  })

  it('长篇：行尾保留「已写/规划」双数（危机钩 2/4）', () => {
    const w = mount(RhythmDistPanel, { props: { rhythmData: longData() } })
    expect(w.find('.dist-val').text()).toBe('2/4')
    expect(w.find('.dist-target').exists()).toBe(true)
    w.unmount()
  })
})

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getAnalysisEnvelope, runAnalyze, type AnalysisKindFE, type EnvelopeFE } from '../api/analysis'

/**
 * 分析 store（M12 块4 B4.0）：按 kind 存信封 + stale 标志；触发重新分析（generateTool submit_<kind>）。
 * 生成与展示解耦：AI 不可达时存量照常展示，仅「重新分析」置灰（无开关、置灰不隐藏）。
 * B4.1 仅渲染 score；emotion/hooks/style 信封可落盘但前端渲染随 B4.2-B4.4 补。
 */
export interface KindSlot {
  envelope: EnvelopeFE | null
  stale: boolean
}

const EMPTY: KindSlot = { envelope: null, stale: false }

export const useAnalysisStore = defineStore('analysis', () => {
  const byKind = ref<Record<AnalysisKindFE, KindSlot>>({
    score: { ...EMPTY },
    emotion: { ...EMPTY },
    hooks: { ...EMPTY },
    style: { ...EMPTY },
  })
  const loading = ref<AnalysisKindFE | null>(null)
  const error = ref<string | null>(null)

  async function load(name: string, docId: string, kind: AnalysisKindFE): Promise<void> {
    const r = await getAnalysisEnvelope(name, docId, kind)
    byKind.value[kind] = r ? { envelope: r.envelope, stale: r.stale } : { ...EMPTY }
  }

  async function run(name: string, docId: string, kind: AnalysisKindFE): Promise<void> {
    loading.value = kind
    error.value = null
    try {
      const envelope = await runAnalyze(name, docId, kind)
      byKind.value[kind] = { envelope, stale: false }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = null
    }
  }

  function clear(): void {
    byKind.value = { score: { ...EMPTY }, emotion: { ...EMPTY }, hooks: { ...EMPTY }, style: { ...EMPTY } }
    error.value = null
  }

  return { byKind, loading, error, load, run, clear }
})

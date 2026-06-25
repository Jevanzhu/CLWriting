/** book.yaml 配置（对接 GET/PUT /api/books/:name/config） */

export interface BookConfig {
  book: { title: string; genre: string; target_words?: number }
  kind?: 'long' | 'short'
  leads: { enabled: string[] }
  budget: { calls_per_chapter: number }
  style: { injection: 'light' | 'heavy' }
  auto: { confirm_outline: boolean; batch_size: number }
  growth: { realm_span_max: number }
}

/** Studio 配置页编辑态：兼容 book.yaml 现有可选扩展字段。 */
export interface BookConfigLoose {
  spec_version: number
  kind?: 'long' | 'short'
  host?: 'cc' | 'codex'
  book: { title: string; genre: string; volume_size?: number; target_words?: number }
  leads: { enabled: string[]; thresholds?: Record<string, number> }
  budget: {
    calls_per_chapter: number
    input_per_chapter?: number
    summary_chapter_max?: number
    summary_volume_max?: number
  }
  style: { injection: 'light' | 'heavy' }
  auto: { confirm_outline: boolean; batch_size: number }
  growth: { realm_span_max?: number }
  [k: string]: unknown
}

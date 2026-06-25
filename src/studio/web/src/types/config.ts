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

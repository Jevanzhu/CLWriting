import { ref, watch, onUnmounted, toValue, type Ref, type WatchSource } from 'vue'
import { countWords, stripFrontmatter, parseFmFields } from '../shared/words'

/**
 * R46-4/R46-5（四十六轮）：字数统计与 fm 字段解析的 150ms 防抖共享 composable——
 * EditorView wordCount（R39-20）同款口径的推广。countWords（全文正则替换 + 码点展开）
 * 与 parseFmFields（split('
') + join 两趟全文大分配）每击键 O(n)，此前右栏「信息」
 * 面板 / 本章历史 / 专注条 / AI 分析 / 顶栏标题 watch / 工作台流式字数直连每事件重算
 * （长章连续键入或 IME 组合输入下与 CM6 输入处理争预算、抬高 GC 频率；流式生成期
 * 每 text 事件重算更是 O(N²/chunk) 累计）。显示/派生延迟一拍无感。
 *
 * key 源（docId）变化（切文档）即刻重算——R43-17 同款纪律：防抖窗不滞留旧文档值；
 * 卸载清定时器；初值取当拍（首屏/挂载即时）。关键时点（如退出专注汇报增量）消费方
 * 可先 flush() 同步取当拍内容重算，防 150ms 窗内低估。
 */

/** 防抖核：content 变化走 150ms 防抖，key 变化（切文档）即刻重算并作废在途定时器。 */
function debouncedDerived<T>(
  content: WatchSource<string | undefined>,
  key: WatchSource<unknown>,
  compute: (c: string | undefined) => T,
): { value: Readonly<Ref<T>>; flush: () => void } {
  // toValue：content 允许 getter 或 Ref 两种形态（WatchSource 全集）
  const out = ref(compute(toValue(content))) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    out.value = compute(toValue(content))
  }
  watch([content, key], ([c, k], old) => {
    if (old !== undefined && old[1] !== k) {
      flush()
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      out.value = compute(c as string | undefined)
    }, 150)
  })
  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })
  return { value: out, flush }
}

/** 防抖字数（缺省剥 front matter；opts.stripFm=false 对裸生成文本）。 */
export function useDebouncedWordCount(
  content: WatchSource<string | undefined>,
  key: WatchSource<unknown> = () => undefined,
  opts: { stripFm?: boolean } = {},
): { count: Readonly<Ref<number>>; flush: () => void } {
  const strip = opts.stripFm !== false
  const r = debouncedDerived<number>(content, key, (c) =>
    c === undefined ? 0 : countWords(strip ? stripFrontmatter(c) : c),
  )
  return { count: r.value, flush: r.flush }
}

/** 防抖 fm 字段表（消费面按需取键；空/未定义内容 → 空表）。 */
export function useDebouncedFmFields(
  content: WatchSource<string | undefined>,
  key: WatchSource<unknown> = () => undefined,
): { fields: Readonly<Ref<Record<string, string>>>; flush: () => void } {
  const r = debouncedDerived<Record<string, string>>(
    content,
    key,
    (c) => (c === undefined ? {} : parseFmFields(c)),
  )
  return { fields: r.value, flush: r.flush }
}

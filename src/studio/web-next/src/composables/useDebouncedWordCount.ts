import { ref, watch, onUnmounted, toValue, type Ref, type WatchSource } from 'vue'
import { countWords, stripFrontmatter, parseFmFields } from '../shared/words'

/**
 * 字数统计与 fm 字段解析的 150ms 防抖共享 composable——
 * EditorView wordCount同款口径的推广。countWords（全文正则替换 + 码点展开）
 * 与 parseFmFields（split('
') + join 两趟全文大分配）每击键 O(n)，此前右栏「信息」
 * 面板 / 本章历史 / 专注条 / AI 分析 / 顶栏标题 watch / 工作台流式字数直连每事件重算
 * （长章连续键入或 IME 组合输入下与 CM6 输入处理争预算、抬高 GC 频率；流式生成期
 * 每 text 事件重算更是 O(N²/chunk) 累计）。显示/派生延迟一拍无感。
 *
 * key 源（docId）变化（切文档）即刻重算——同款纪律：防抖窗不滞留旧文档值；
 * 卸载清定时器；初值取当拍（首屏/挂载即时）。关键时点（如退出专注汇报增量）消费方
 * 可先 flush 同步取当拍内容重算，防 150ms 窗内低估。
 *
 * 本件是字数防抖的唯一入口——EditorView 顶栏的手写副本已换装（
 * 原实现的「单折」），四方消费点（顶栏 / 专注条 / 信息面板 / 本章历史）共用下方单槽记忆。
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

/**
 * 字数派生单槽记忆——同一份正文（内容串相等）同口径下只算
 * 一次 countWords。此前 EditorView 顶栏 / FocusStatsBar / WritingInfoPanel / HistoryPanel
 * 四方各自防抖后各跑一遍全文码点展开（MB 级长章每个 150ms 窗口 4 趟 O(n)）；四方 watch
 * 同一 doc.content，同一拍携带同一个内容串，先到者计算、其余命中（见 EditorView 消费点
 * 头注：顶栏内容源已改 entry.content 对齐右栏）。
 *
 * 键只取「内容 + 口径」，docId 不入键：countWords 是内容的纯函数，内容相等结果必同，
 * docId 只决定内容来自哪份文档、不参与计算（的「防抖窗不滞留旧文档值」由键源
 * 变化即刻重算保证，与记忆无关）。刻意用单槽而非按 docId 建 Map——单槽只持有最近一次
 * 计算的内容串引用（该串本就是 doc store 的当前在编内容），按 docId 累积则每个开过的章
 * 都留一份 MB 级字符串、随会话增长不释放。两条不同内容交替（工作台草稿流 vs 编辑器正文）
 * 时各自照常计算，只损失命中率不损正确性。
 */
let wordsMemo: { content: string | undefined; strip: boolean; value: number } | null = null
function computeWords(content: string | undefined, strip: boolean): number {
  if (wordsMemo && wordsMemo.strip === strip && wordsMemo.content === content) return wordsMemo.value
  const value = content === undefined ? 0 : countWords(strip ? stripFrontmatter(content) : content)
  wordsMemo = { content, strip, value }
  return value
}

/** 防抖字数（缺省剥 front matter；opts.stripFm=false 对裸生成文本）。 */
export function useDebouncedWordCount(
  content: WatchSource<string | undefined>,
  key: WatchSource<unknown> = () => undefined,
  opts: { stripFm?: boolean } = {},
): { count: Readonly<Ref<number>>; flush: () => void } {
  const strip = opts.stripFm !== false
  const r = debouncedDerived<number>(content, key, (c) => computeWords(c, strip))
  return { count: r.value, flush: r.flush }
}

/** 防抖 fm 字段表（消费面按需取键；空/未定义内容 → 空表）。 */
export function useDebouncedFmFields(
  content: WatchSource<string | undefined>,
  key: WatchSource<unknown> = () => undefined,
): { fields: Readonly<Ref<Record<string, string>>>; flush: () => void } {
  const r = debouncedDerived<Record<string, string>>(content, key, (c) => (c === undefined ? {} : parseFmFields(c)))
  return { fields: r.value, flush: r.flush }
}

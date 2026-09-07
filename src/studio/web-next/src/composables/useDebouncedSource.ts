// R47-1/R47-3（四十七轮）：派生值源防抖组合式。
//
// 背景：右栏信息面板族（WritingInfoPanel/MetaFormPanel/AnalysisPanel/HistoryPanel/
// FocusStatsBar/WbDraftCard）的派生 computed（countWords/parseFmFields）直接吃全文
// entry.content——CM6 每击键 emit → doc.patch 原位改 content → 全部依赖重算，
// 单键 ≈10+ 次全文扫描 + ~7 个全文级行数组分配（splitFrontMatter 全文 split +
// countWords 两次全文物化），几十万字单文档线性放大成可感输入迟滞（144Hz 帧预算
// 6.9ms）。EditorView 自身 wordCount 已有 150ms 防抖先例（R39-20/R64-33）——本
// 组合式把同款口径推广到右栏面板族（显示延迟一拍无感；统计/表单回填无击键级精度
// 消费方）。
//
// 语义（对齐 R43-17 切文档即刻口径）：
// - key 变化（切文档/切任务）→ 立即取新值（取消在途定时器），不残留旧文档的一拍；
// - 同 key 源变化 → delayMs（默认 150）防抖，超时取源当前值；
// - 组件卸载清定时器。
import { ref, watch, onUnmounted, readonly, type Ref } from 'vue'

export function useDebouncedSource<T>(
  source: () => T,
  opts?: { delayMs?: number; key?: () => unknown },
): Readonly<Ref<T>> {
  const delay = opts?.delayMs ?? 150
  const keyGetter = opts?.key
  const out = ref(source()) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  watch(
    [source, () => (keyGetter ? keyGetter() : 0)],
    (_n, old) => {
      // key 变化 = 源身份切换（切文档等）：立即重算（沿 R43-17「切文档非高频路径，
      // 无防抖成本顾虑」）；首轮 old 为 undefined 不触发
      if (old !== undefined && _n[1] !== old[1]) {
        stop()
        out.value = source()
        return
      }
      stop()
      if (delay <= 0) {
        out.value = source()
        return
      }
      timer = setTimeout(() => {
        timer = null
        out.value = source()
      }, delay)
    },
  )
  onUnmounted(stop)
  // R48-1（四十八轮）：vue-tsc TS2322 收口——readonly(Ref<T>) 的精确型是
  // Readonly<Ref<DeepReadonly<T>>>，与签名 Readonly<Ref<T>> 在未解泛型下不可赋值。
  // 消费方面板族 T 恒为 string（DeepReadonly<string> === string，无运行时差异），
  // 按 ：24 行 `as Ref<T>` 同款断言口径收窄。
  return readonly(out) as Readonly<Ref<T>>
}

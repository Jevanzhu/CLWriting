<script setup lang="ts">
// 专注会话统计浮动条（左侧，与右侧 FocusFormatBar 呼应；更清晰——0.85 常驻/hover 全实，
// 排版条是 0.35）：本次 +N 字（进专注快照差，换章重置）/ 速度 字/分（首笔起算，不含
// 进专注后的纯构思时间）/ 本章目标进度（章级目标三级同语义：fm「字数目标」> 书级
// book.chapter_target_words > 全局默认，与 WritingInfoPanel 同链，0=未设隐藏该区）。
// 退出专注时若有增量 → 成果 toast。字数与编辑器/服务端同源（countWords：码点 + 剥标记）。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useDocStore } from '../../stores/doc'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig, type BookConfig } from '../../api/books'
import { useDebouncedWordCount, useDebouncedFmFields } from '../../composables/useDebouncedWordCount'

const ws = useWorkspaceStore()
const doc = useDocStore()
const ui = useUiStore()
const prefs = usePrefsStore()

// R70-29（十八轮）：页宽设置 ≥ 视口宽时侧位 ≤0，条会压在正文上——编辑内容优先，
// 侧位容不下（<140px：条宽下限 + 间距）时隐藏两浮动条（FocusFormatBar 同款）
const vw = ref(window.innerWidth)
const onVwResize = (): void => {
  vw.value = window.innerWidth
}
onMounted(() => window.addEventListener('resize', onVwResize))
onBeforeUnmount(() => window.removeEventListener('resize', onVwResize))
// 隐藏判据 = 页宽 ≥ 视口（侧位 ≤0，条必然压正文）；侧位紧张但 >0 时靠 R69-8 的
// clamp 收窄条宽保间隙，不隐藏（1280×800 笔记本默认页宽侧位 130px 仍可用）
const sideRoomTooSmall = computed(() => vw.value < prefs.effectivePageWidth)

const docId = computed(() => ws.activeDocId)
const entry = computed(() => (docId.value ? doc.get(docId.value) : undefined))
// R46-5（四十六轮）：字数与 fm 字段 150ms 防抖（EditorView R39-20 同款——专注条常驻，
// 此前每击键全文重算；首笔起钟 words watch 随防抖延一拍，会话计时精度无感）
const { count: words, flush: flushWords } = useDebouncedWordCount(() => entry.value?.content, () => docId.value)
const { fields: fmFields } = useDebouncedFmFields(() => entry.value?.content, () => docId.value)

// ── 会话快照（每章口径；重进专注各重开一段会话）──
/** 基线：文档到位时锁存当前字数（空章留 null——首笔从旧字数 0 锁，见 words watch） */
const baseline = ref<number | null>(null)
/** 首笔时刻：基线在场后字数第一次变化起算；null = 尚未动笔 */
let firstChangeAt: number | null = null
/** R34D-28（三十四轮）：会话重开瞬间的字数快照——words 跳变恰好落在该值上即为
 *  文档切换/迟到加载的置位跳变（非动笔），不起钟（见 words watch） */
let wordsAtReset: number | null = null
const now = ref(Date.now())
const delta = computed(() => (baseline.value === null ? 0 : words.value - baseline.value))
const speed = computed(() => {
  if (delta.value <= 0 || firstChangeAt === null) return null
  const minutes = (now.value - firstChangeAt) / 60000
  return minutes <= 0 ? null : Math.round(delta.value / minutes)
})

/** 重开一段会话：以当前字数为新基线（空章留 null 待首笔从 0 锁）。 */
function resetSession(): void {
  // R46-5：防抖下切章/重进先冲刷——基线必须锁「当拍」字数，防 150ms 窗内基线滞留
  // 旧文档字数（置位跳变被误判为动笔，速度起算提前）
  flushWords()
  baseline.value = words.value > 0 ? words.value : null
  firstChangeAt = null
  wordsAtReset = words.value
}
// R34D-28（三十四轮）：会话重开改盯 entry 对象身份——换章必伴随 entry 换对象
//（切到未加载章先变 undefined、加载完落新对象），作者打字只改 content 不换对象。
// 旧实现盯 docId：resetSession 先把基线锁到新章字数，紧随其后的 M→N words 跳变
//（换章本身）被误判为「首笔」起钟——速度从切章时刻起算被摊薄（起算提前）。
// immediate 覆盖挂载时已开好的文档（原 onMounted 锁基线逻辑并入此处）。
watch(entry, resetSession, { immediate: true })
watch(words, (w, old) => {
  // R34D-28：文档切换/迟到加载的置位跳变恰好落在 reset 快照上——非动笔，不起钟
  //（动笔首变必然偏离快照值：N→N±k，不会恰好等于 N）
  if (wordsAtReset !== null && w === wordsAtReset) {
    wordsAtReset = null
    return
  }
  wordsAtReset = null
  // R34D-28：空章首笔（基线 null 且文档在场，words 从 0 起）——基线按旧值 0 锁：
  // 首字计入 delta。旧实现把首字锁进基线（显示 +0 且钟不起，第二字才起算）
  if (baseline.value === null) baseline.value = old
  if (firstChangeAt === null) firstChangeAt = Date.now()
  now.value = Date.now()
})
onMounted(() => { now.value = Date.now() })
// 速度随时间流逝下降：5s 心跳刷新显示（无输入也有意义——均速在摊薄）
const ticker = setInterval(() => { now.value = Date.now() }, 5000)
onBeforeUnmount(() => clearInterval(ticker))

// ── 章目标（三级同语义，WritingInfoPanel 同链）──
const config = ref<BookConfig>({})
// R67-18（十五轮）：请求代守卫——快速切书时慢响应迟归会覆盖新书配置（A 书的
// chapter_target_words 串进 B 书目标区显示）；代数不符的迟归结果弃用
let configReqGen = 0
watch(
  () => ws.bookName,
  async (n) => {
    if (!n) return
    const gen = ++configReqGen
    try {
      const c = await getConfig(n)
      if (gen === configReqGen) config.value = c
    } catch { /* 读不到配置：目标区退到 fm/全局默认解析 */ }
  },
  { immediate: true },
)
const chapterTarget = computed(() => {
  if (entry.value) {
    const v = fmFields.value['字数目标']
    // R32-32（三十二轮）：isFinite 守卫同 WritingInfoPanel——脏 fm 手填不产 NaN 目标
    if (v && Number.isFinite(Number(v))) return Number(v)
  }
  return config.value.book?.chapter_target_words ?? prefs.defaultChapterTargetWords
})
const chapterProgress = computed(() =>
  chapterTarget.value ? Math.min(100, Math.round((words.value / chapterTarget.value) * 100)) : 0,
)

// ── 专注会话进出：重进重开基线；退出成果 toast（pre-flush watch 先于 v-if 卸载跑）──
watch(
  () => ws.focusMode,
  (v) => {
    if (v) {
      // 直挂场景（无 v-if 包裹）重进专注：重开会话；v-if 场景由 onMounted 兜底
      resetSession()
      return
    }
    // R46-5：退出汇报前冲刷在途字数防抖——退出落在 150ms 防抖窗内时本次增量不被低估
    flushWords()
    if (delta.value <= 0) return
    ui.toast(
      `专注结束：本次 +${delta.value} 字${speed.value !== null ? ` · 平均 ${speed.value} 字/分` : ''}`,
      'success',
    )
  },
)
</script>

<template>
  <aside v-if="!sideRoomTooSmall" class="focus-stats-bar" aria-label="专注统计">
    <div class="fsb-item">
      <span class="fsb-label">本次</span>
      <span class="fsb-main" :class="{ plus: delta > 0 }">{{ delta >= 0 ? '+' : '' }}{{ delta }} 字</span>
    </div>
    <div class="fsb-item">
      <span class="fsb-label">速度</span>
      <span class="fsb-main">{{ speed !== null ? `${speed} 字/分` : '—' }}</span>
    </div>
    <template v-if="chapterTarget">
      <div class="fsb-sep" />
      <div class="fsb-item">
        <span class="fsb-label">本章</span>
        <span class="fsb-main">{{ words.toLocaleString() }}<i class="fsb-sub">/{{ chapterTarget.toLocaleString() }}</i></span>
      </div>
      <div class="fsb-progress" role="progressbar" :aria-valuenow="chapterProgress" aria-valuemin="0" aria-valuemax="100">
        <i class="fsb-bar" :style="{ width: `${chapterProgress}%` }" />
      </div>
      <div class="fsb-pct">{{ chapterProgress }}%</div>
    </template>
  </aside>
</template>

<style scoped>
/* 左侧浮动条：与右侧 FocusFormatBar 同定位语义（纸张居中 → 50% - 半页宽 - 间距 - 条宽），
 * 但更清晰：0.85 常驻（排版条 0.35），hover 全实。
 * R69-8（十七轮）：窄窗侧位不足（边距 < 条宽 + 间距，如 1280 屏配默认页宽 1020 边距仅
 * 130px）时此前 max() 钳到左缘 x=8 而 150px 条宽照旧——条与纸张左缘重叠 28px，「条右缘
 * 落在纸张左缘左侧 0~40px」的设计意图失守；改 clamp 随侧位收窄条宽（下限 56px 保两行
 * label/value 可读），条右缘恒 = 纸张左缘 - 12px。宽窗（边距充足）条宽维持 150px 不变。 */
.focus-stats-bar {
  position: absolute;
  left: max(var(--size-4-2, 8px), calc(50% - var(--page-width, 1020px) / 2 - var(--size-4-3, 12px) - min(150px, calc(50% - var(--page-width, 1020px) / 2 - 20px))));
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: clamp(56px, calc(50% - var(--page-width, 1020px) / 2 - 20px), 150px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m, 8px);
  background: var(--background-secondary);
  box-shadow: var(--shadow-s), var(--shadow-l);
  opacity: 0.85;
  transition: opacity var(--dur-norm) var(--ease-out);
}
.focus-stats-bar:hover {
  opacity: 1;
}
.fsb-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fsb-label {
  font-size: var(--font-size-xxs, 10px);
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}
.fsb-main {
  font-size: var(--font-size-m, 14px);
  font-weight: 600;
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}
.fsb-main.plus {
  color: var(--text-accent, var(--interactive-accent));
}
.fsb-sub {
  font-style: normal;
  font-size: var(--font-size-xs, 12px);
  font-weight: 400;
  color: var(--text-faint);
}
.fsb-sep {
  height: 1px;
  background: var(--background-modifier-border);
}
.fsb-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--background-modifier-border);
  overflow: hidden;
}
.fsb-bar {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--interactive-accent);
  transition: width 0.3s var(--ease-out);
}
.fsb-pct {
  font-size: var(--font-size-xxs, 10px);
  color: var(--text-faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
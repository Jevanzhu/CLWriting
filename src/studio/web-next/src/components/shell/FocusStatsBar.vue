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
import { countWords, stripFrontmatter, parseFmFields } from '../../shared/words'

const ws = useWorkspaceStore()
const doc = useDocStore()
const ui = useUiStore()
const prefs = usePrefsStore()

const docId = computed(() => ws.activeDocId)
const entry = computed(() => (docId.value ? doc.get(docId.value) : undefined))
const words = computed(() => (entry.value ? countWords(stripFrontmatter(entry.value.content)) : 0))

// ── 会话快照（每章口径；重进专注各重开一段会话）──
/** 基线：每章首次非零字数时锁存（挂载时文档可能未加载完，content 空） */
const baseline = ref<number | null>(null)
/** 首笔时刻：基线在场后字数第一次变化起算；null = 尚未动笔 */
let firstChangeAt: number | null = null
const now = ref(Date.now())
const delta = computed(() => (baseline.value === null ? 0 : words.value - baseline.value))
const speed = computed(() => {
  if (delta.value <= 0 || firstChangeAt === null) return null
  const minutes = (now.value - firstChangeAt) / 60000
  return minutes <= 0 ? null : Math.round(delta.value / minutes)
})

/** 重开一段会话：以当前字数为新基线（文档未在场的下一次 words 变化再锁存） */
function resetSession(): void {
  baseline.value = words.value > 0 ? words.value : null
  firstChangeAt = null
}
// 换章重置（本章口径）；基线在首个非零字数时锁存——文档迟到加载不算动笔（hadBaseline 判定）
watch(docId, resetSession)
watch(words, (w, old) => {
  const hadBaseline = baseline.value !== null
  if (baseline.value === null && w > 0) baseline.value = w
  if (hadBaseline && old !== w && firstChangeAt === null) firstChangeAt = Date.now()
  if (firstChangeAt !== null) now.value = Date.now()
})
onMounted(() => {
  if (baseline.value === null && words.value > 0) baseline.value = words.value
  now.value = Date.now()
})
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
    const v = parseFmFields(entry.value.content)['字数目标']
    if (v) return Number(v)
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
    if (delta.value <= 0) return
    ui.toast(
      `专注结束：本次 +${delta.value} 字${speed.value !== null ? ` · 平均 ${speed.value} 字/分` : ''}`,
      'success',
    )
  },
)
</script>

<template>
  <aside class="focus-stats-bar" aria-label="专注统计">
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
 * 但更清晰：0.85 常驻（排版条 0.35），hover 全实。窄窗侧位不足时 max 回落左缘 */
.focus-stats-bar {
  position: absolute;
  left: max(var(--size-4-2, 8px), calc(50% - var(--page-width, 1020px) / 2 - var(--size-4-3, 12px) - 150px));
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 150px;
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
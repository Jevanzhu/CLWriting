<script setup lang="ts">
/**
 * 审计事件列表（R0911b-C2-P3-1：自 AuditView.vue 抽出，纯结构去重零行为变更）。
 * 对话审计 / 工作流链路两段事件列表模板原为近复制（行模板 + 空态 + 分页/渲染上限
 * 截断行），抽本组件两处以 props/事件消费；抽取前后渲染产物逐行对照一致（class 名、
 * v-if 分支、事件绑定）。
 *
 * 两段数据源差异以 props 区分：
 * - detailed：对话段专有列（遮蔽标记 / surfaceOp / 血缘引用 + 展开态血缘注记）；
 *   工作流链路段原模板无这些列，缺省 false 时这些分支恒不渲染（DOM 产物与原一致）。
 * - emptyText / capHintSuffix：空态文案与渲染上限截断提示尾注两段措辞不同。
 *
 * 既有特性原样保留：展开态（expanded Set）与翻页仍由父持有/触发（load/doClear 重置
 * 展开态、loadMore* 各自续页）；hasMore/capHit/renderCap 的计算同源在父；行渲染封顶
 * （content-visibility）随行模板同迁，见 .ev-row 注。
 *
 * R0912-FE-P3-11（mac 线，merge 2026-09-12 并入）：事件 data JSON 懒展开——原实现内联
 * 在 AuditView 两段行模板、状态在父侧；抽取骨架归本组件后随展开态 pre 渲染一并下沉
 * 到此（见下方「事件 data JSON 懒展开」注），父侧仅保留 load 换代复位语义的等价承接。
 */
import { reactive, watch } from 'vue'
import { ChevronRight, ChevronDown, EyeOff, GitBranch, MoreHorizontal } from 'lucide-vue-next'
import type { AuditEventFE } from '../../api/audit'

const props = defineProps<{
  /** 累积事件（跨页追加，父按 seq 去重） */
  events: AuditEventFE[]
  /** 事件总条数（分页「已显示 X / N」与截断提示用） */
  total: number
  /** 「加载更多」在途（按钮禁用 + 图标旋转） */
  loadingMore: boolean
  /** 是否还有可续页（父按 RENDER_CAP 与 total 计算） */
  hasMore: boolean
  /** 渲染上限截断提示（父计算：已到 RENDER_CAP 且 total 仍有余量） */
  capHit: boolean
  /** 渲染累积上限值（截断提示文案展示用） */
  renderCap: number
  /** 空态文案（两段不同） */
  emptyText: string
  /** 对话审计段：渲染遮蔽标记 / surfaceOp / 血缘引用列（工作流链路段无） */
  detailed?: boolean
  /** 渲染上限截断提示尾注（对话段专有） */
  capHintSuffix?: string
  /** 展开的 seq 集合（父持有：load/doClear 重置） */
  expanded: Set<number>
}>()

const emit = defineEmits<{
  /** 展开/收起某条事件（状态在父） */
  toggle: [seq: number]
  /** 加载下一页（父各自续页） */
  'load-more': []
}>()

/** 事件类型 → 展示标签（去前缀，如 assistant/message → assistant·message） */
function typeLabel(t: string): string {
  return t.replace('/', '·')
}

/** data 摘要（取几个常见字段，避免大对象撑爆列表） */
function dataSummary(e: AuditEventFE): string {
  const d = e.data
  if (typeof d['message'] === 'string') return String(d['message']).slice(0, 60)
  if (typeof d['task'] === 'string') return String(d['task'])
  if (typeof d['callId'] === 'string') return String(d['callId'])
  if (typeof d['chapter'] === 'number') return 'chapter ' + String(d['chapter'])
  // F5：goal/change（动词 + 标题 + 状态）+ todo/write（完成数/总数）
  if (typeof d['operation'] === 'string' && d['goal'] && typeof d['goal'] === 'object') {
    const g = d['goal'] as { title?: unknown; state?: unknown }
    return [d['operation'], typeof g.title === 'string' ? g.title : '', typeof g.state === 'string' ? '[' + g.state + ']' : ''].join(' ').trim().slice(0, 60)
  }
  if (Array.isArray(d['todos'])) {
    const ts = d['todos'] as { state?: unknown }[]
    const done = ts.filter((t) => t.state === 'completed').length
    return 'todos ' + done + '/' + ts.length
  }
  return ''
}

// ── R0912-FE-P3-11（2026-09-11 重评-0911b 修复批，mac 线；merge 2026-09-12 随抽取骨架下沉）：
// 事件 data JSON 懒展开。原模板内联 `{{ JSON.stringify(e.data, null, 2) }}`：①组件任意重
// 渲染都重新全量 stringify；②超大 payload（全文快照/批量事件）展开即把 MB 级 JSON 全量
// 灌进 DOM。改为：展开时 stringify 至多一次（按 e.data 对象身份 WeakMap 缓存，重渲染/截断
// 与全量切换复用）；超 4KB 只渲染截断摘要，「查看完整 JSON」点击后才放行全量（缓存复用，
// 不再 stringify）。WeakMap 缓存按 data 对象身份记账——load/loadMore 重取产生新对象自然
// 失效，无需手动重置；「放行全量」集合用 reactive Set（WeakSet 无响应性，点击后不触发
// 重渲染）。
const JSON_DETAIL_LIMIT = 4_096
const detailJsonCache = new WeakMap<object, string>()
/** 「查看完整 JSON」已放行集合（按 e.data 身份，响应式）。 */
const showFullJson = reactive(new Set<object>())

// 原实现（父侧 AuditView）在 load 整体重取时 showFullJson.clear()。父 load 换新数组、
// loadMore 原地 push——此处 watch 数组换代即复位，语义等价（放行集合按 data 身份记账，
// 换代后旧条目本已不可达，清除只为不滞留旧 payload 强引用）。
watch(
  () => props.events,
  () => {
    showFullJson.clear()
  },
)

function eventDetailJson(e: AuditEventFE): string {
  const key = e.data
  let s = detailJsonCache.get(key)
  if (s === undefined) {
    s = JSON.stringify(e.data, null, 2)
    detailJsonCache.set(key, s)
  }
  return s
}

/** 展开态渲染文本：超长且未放行全量时只出截断摘要（DOM 面恒有界）。 */
function detailText(e: AuditEventFE): string {
  const s = eventDetailJson(e)
  if (showFullJson.has(e.data) || s.length <= JSON_DETAIL_LIMIT) return s
  return s.slice(0, JSON_DETAIL_LIMIT) + `\n…（已截断，完整 JSON 共 ${s.length} 字符）`
}

function detailTruncated(e: AuditEventFE): boolean {
  return !showFullJson.has(e.data) && eventDetailJson(e).length > JSON_DETAIL_LIMIT
}
</script>

<template>
  <div class="ev-list">
    <div v-for="e in events" :key="e.seq" class="ev-row">
      <button class="ev-toggle" @click="emit('toggle', e.seq)">
        <ChevronRight v-if="!expanded.has(e.seq)" :size="13" />
        <ChevronDown v-else :size="13" />
      </button>
      <span class="ev-seq" :class="{ shadowed: detailed && e.shadowed }">#{{ e.seq }}</span>
      <span class="ev-type" :class="{ shadowed: detailed && e.shadowed }">{{ typeLabel(e.type) }}</span>
      <span v-if="detailed && e.surfaceOp" class="ev-op" :class="e.surfaceOp">{{ e.surfaceOp }}</span>
      <span class="ev-summary">{{ dataSummary(e) }}</span>
      <span v-if="detailed && e.shadowed" class="ev-shadow"><EyeOff :size="11" /> 遮蔽</span>
      <span v-if="detailed && e.sourceSeqs?.length" class="ev-lineage">
        <GitBranch :size="11" /> {{ e.sourceSeqs.join(',') }}
      </span>
      <div v-if="expanded.has(e.seq)" class="ev-detail">
        <!-- R0912-FE-P3-11：懒展开——截断摘要 +「查看完整 JSON」放行钮（原内联全量 stringify） -->
        <pre>{{ detailText(e) }}</pre>
        <button v-if="detailTruncated(e)" class="ev-full-btn" @click="showFullJson.add(e.data)">
          查看完整 JSON
        </button>
        <p v-if="detailed && e.sourceSeqs?.length" class="lineage-note">
          血缘引用（sourceSeqs）指向事件：#{{ e.sourceSeqs.join(' #') }} —— 每个引用都可在上方事件流定位。
        </p>
      </div>
    </div>
    <div v-if="events.length === 0" class="empty">{{ emptyText }}</div>
  </div>
  <!-- AA-P2-1：截断提示 + 续页入口（长书 >500 条可见「已显示 X / N」并可翻到底） -->
  <div v-if="hasMore" class="pager">
    <span class="pager-hint">已显示 {{ events.length }} / {{ total }} 条，更多最早事件待加载</span>
    <button class="load-more" :disabled="loadingMore" @click="emit('load-more')">
      <MoreHorizontal :size="14" :class="{ spin: loadingMore }" />
      {{ loadingMore ? '加载中…' : '加载更多' }}
    </button>
  </div>
  <!-- ii-2：渲染上限截断提示（防长书 DOM 无界膨胀） -->
  <div v-else-if="capHit" class="pager">
    <span class="pager-hint">已达渲染上限 {{ renderCap }} 条（共 {{ total }}，为防卡顿截断）{{ capHintSuffix }}</span>
  </div>
</template>

<style scoped>
/* 样式自 AuditView.vue 随模板同迁（R0911b-C2-P3-1 纯搬家）；变量纪律只引 tokens.css
 * 既有 token，字号档映射口径见 AuditView style 头注。 */
/* AA-P2-1：分页续页 */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-3);
  margin-top: var(--size-4-3);
  flex-wrap: wrap;
}
.pager-hint {
  color: var(--text-muted);
  font-size: var(--font-size-s);
}
.load-more {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  font-size: var(--font-size-s);
}
.load-more:disabled { opacity: 0.55; cursor: default; }
.spin { animation: clw-spin 0.8s linear infinite; }

.ev-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ev-seq {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 2.4em;
}
.ev-row {
  border: 1px solid var(--background-modifier-border);
  border-radius: 7px;
  background: var(--background-secondary);
  padding: 4px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-s);
  flex-wrap: wrap;
  /* 列表渲染上限（起步方案）：「加载更多」跨页累积无上限，长书几千行全量布局会卡；
   * content-visibility 让视口外行跳过渲染，进视口按需恢复。30px ≈ 未展开行的
   * 量得高度（13px 字 × 1.5 行距 + 8px 内边距 + 2px 边框），作首渲染前占位；
   * auto 前缀让浏览器记住实际渲染高度（展开 ev-detail 后不受占位束缚）。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
}
.ev-toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  display: inline-flex;
  padding: 0;
}
.ev-seq.shadowed { color: var(--text-error); }
.ev-type {
  font-family: var(--font-monospace);
  color: var(--text-accent);
  font-size: var(--font-size-xs);
}
.ev-type.shadowed { color: var(--text-muted); text-decoration: line-through; }
.ev-op {
  font-size: var(--font-size-xs);
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--background-modifier-border);
}
.ev-op.replace { color: var(--text-error); border-color: var(--text-error); }
.ev-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.ev-shadow, .ev-lineage {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ev-shadow { color: var(--text-error); }
.ev-detail {
  flex-basis: 100%;
  padding: 6px 0 4px;
}
.ev-detail pre {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  font-size: var(--font-size-xs);
  background: var(--background-primary);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.lineage-note { font-size: var(--font-size-xs); color: var(--text-muted); margin: 4px 0 0; }
/* R0912-FE-P3-11：「查看完整 JSON」放行钮（次级小按钮，紧贴截断摘要下方；自 AuditView 随逻辑同迁） */
.ev-full-btn {
  margin-top: 4px;
  padding: 2px 10px;
  font-size: var(--font-size-xs);
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
}
.ev-full-btn:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
.empty { color: var(--text-muted); font-size: var(--font-size-s); padding: 8px; }
</style>

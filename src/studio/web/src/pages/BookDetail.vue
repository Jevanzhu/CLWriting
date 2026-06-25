<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EChart from '../components/EChart.vue'
import type { EChartsOption } from 'echarts'

interface Overview {
  identity: {
    name: string
    kind: 'long' | 'short'
    path: string
    created_at?: string
    title: string
    genre: string
    host: string
  }
  progress: { chapters: number; words: number; targetWords?: number; percent?: number }
  state: { state: number; name: string; detail: unknown }
  volumes: { name: string; path: string }[]
  timeline: { date: string; count: number }[]
}

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const data = ref<Overview | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/overview`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    data.value = (await r.json()) as Overview
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') load(n)
  },
  { immediate: true },
)

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}

function hostLabel(host: string): string {
  return host === 'codex' ? 'Codex' : 'Claude Code (cc)'
}

/** 字数 → 万字（保留 1 位） */
function fmtWords(n: number): string {
  if (n <= 0) return '0'
  if (n < 10000) return `${n}`
  return `${(n / 10000).toFixed(1)} 万`
}

/** 状态机细节 → 人话提示（按态取关键字段） */
function stateHint(s: Overview['state']): string {
  const d = (s.detail ?? {}) as Record<string, unknown>
  switch (s.state) {
    case 7: {
      const next = d['nextChapter']
      return typeof next === 'number' ? `下一步起草第 ${next} 章` : '准备起草新章'
    }
    case 8:
      return '有章节待批量审稿'
    case 5:
      return '当前卷已写完,待开新卷'
    case 6:
      return '体检周期到期,建议先体检'
    case 4:
      return '工作区有未完成的内容'
    case 3: {
      const h = d['handEdits']
      return Array.isArray(h) ? `有 ${h.length} 处手改未入账(建议 finalize)` : '有手改未入账'
    }
    case 2:
      return '源文件解析有错,需修复'
    case 1: {
      const issues = d['issues']
      return Array.isArray(issues) && issues.length
        ? `git 健康检查发现 ${issues.length} 个问题`
        : 'git 仓库需要检查'
    }
    default:
      return ''
  }
}

/** 是否可继续写作(态 7 起草;态 5/8 也算可推进) */
function canWrite(s: Overview['state']): boolean {
  return s.state === 7 || s.state === 5 || s.state === 8
}

/** 继续写作 → 临时跳编辑 tab(工作台 AI 起草在 Step 2 上线) */
function onWrite(): void {
  router.push(`/books/${encodeURIComponent(name.value)}/edit`)
}

/** 写作热力(7.2)：定稿时间线日历热力图(GitHub 贡献图风格) */
const heatOption = computed<EChartsOption | null>(() => {
  const tl = data.value?.timeline ?? []
  if (tl.length === 0) return null
  const year = new Date().getFullYear()
  const max = Math.max(...tl.map((t) => t.count), 1)
  const unit = data.value?.identity.kind === 'short' ? '篇' : '章'
  return {
    tooltip: {
      formatter: (params) => {
        const d = (params as { data?: [string, number] }).data
        return d ? `${d[0]}：${d[1]} ${unit}` : ''
      },
    },
    visualMap: { show: false, min: 0, max, inRange: { color: ['var(--border)', 'var(--active-bg)', 'var(--ink-cyan)'] } },
    calendar: {
      range: String(year),
      cellSize: ['auto', 13],
      left: 30,
      right: 20,
      itemStyle: { borderWidth: 2, borderColor: 'var(--panel)' },
      yearLabel: { show: false },
      dayLabel: { firstDay: 1, nameMap: 'ZH' },
      monthLabel: { nameMap: 'ZH' },
    },
    series: [
      { type: 'heatmap', coordinateSystem: 'calendar', data: tl.map((t) => [t.date, t.count] as [string, number]) },
    ],
  }
})
</script>

<template>
  <section class="book-detail">
    <p v-if="loading" class="panel-pad hint">加载中…</p>
    <p v-else-if="error" class="panel-pad hint error">加载失败：{{ error }}</p>
    <template v-else-if="data">
      <div class="panel-pad">
        <button class="btn" style="margin-bottom:18px" @click="router.push('/')">← 返回书架</button>

        <div class="panel-title">{{ data.identity.title }}</div>
        <div class="panel-sub">
          {{ data.identity.genre || '未分类' }} · {{ data.identity.kind === 'short' ? '短篇集' : '长篇' }}
          · 宿主 {{ hostLabel(data.identity.host) }} · 创建 {{ fmtDate(data.identity.created_at) }}
        </div>

        <!-- 关键指标 -->
        <div class="card-row">
          <div class="stat-card">
            <div class="n">{{ fmtWords(data.progress.words) }}</div>
            <div class="l">总字数</div>
          </div>
          <div class="stat-card">
            <div class="n">{{ data.progress.chapters }}</div>
            <div class="l">{{ data.identity.kind === 'short' ? '篇数' : '章数' }}</div>
          </div>
          <div class="stat-card">
            <div class="n">{{ data.progress.percent ?? '—' }}<span v-if="data.progress.percent !== undefined">%</span></div>
            <div class="l">完成度</div>
          </div>
          <div class="stat-card">
            <div class="n" style="font-size:15px;line-height:1.3">{{ data.state.name }}</div>
            <div class="l">写作位置</div>
          </div>
        </div>

        <!-- 写作位置 + 完成度（协作/进度核心）-->
        <div class="list-row" style="background:var(--panel);align-items:center">
          <div
            class="ring on-panel"
            :style="`background:conic-gradient(var(--ink-cyan) 0 ${(data.progress.percent ?? 0)}%,var(--border) ${(data.progress.percent ?? 0)}% 100%)`"
          >
            <span class="ring-txt">{{ data.progress.percent ?? '—' }}<span v-if="data.progress.percent !== undefined">%</span></span>
          </div>
          <div style="flex:1;margin-left:14px;min-width:0">
            <div style="font-weight:600;margin-bottom:6px">写作位置 · {{ data.state.name }}</div>
            <div style="color:var(--text-2);font-size:12px;line-height:1.7">{{ stateHint(data.state) || '状态就绪' }}</div>
            <div v-if="data.progress.percent !== undefined" class="progress" style="margin-top:10px">
              <div :style="{ width: `${data.progress.percent}%` }"></div>
            </div>
            <div style="color:var(--text-3);font-size:11px;margin-top:6px">
              目标 {{ fmtWords(data.progress.targetWords ?? 0) }} 字
            </div>
            <div class="btn-row">
              <button class="btn primary" :disabled="!canWrite(data.state)" @click="onWrite">
                {{ canWrite(data.state) ? '继续写作 →' : '工作台 Step 2 上线' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 目录 -->
        <div class="card">
          <div class="card-title">目录路径</div>
          <div class="kv"><span class="k">书库目录</span><span class="v" style="font-family:ui-monospace,monospace;font-size:11px">{{ data.identity.path }}</span></div>
        </div>

        <!-- 卷结构（长篇）-->
        <div v-if="data.identity.kind === 'long'" class="card">
          <div class="card-title">卷结构</div>
          <ul v-if="data.volumes.length" class="vol-list">
            <li v-for="v in data.volumes" :key="v.path">{{ v.name }}</li>
          </ul>
          <p v-else class="hint">暂无卷纲（在「编辑」中维护 大纲/卷纲/*.md）</p>
        </div>

        <!-- 写作热力 -->
        <div v-if="heatOption" class="card">
          <div class="card-title">写作热力 · {{ new Date().getFullYear() }} 年定稿</div>
          <EChart :option="heatOption" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.book-detail {
  margin: 0 auto;
}
.book-detail .vol-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.book-detail .vol-list li {
  padding: 8px 12px;
  background: var(--paper);
  border-radius: 6px;
  font-size: 13px;
}
.book-detail :deep(.echart) {
  height: 160px;
}
.book-detail .hint {
  color: var(--text-2);
  padding-top: 24px;
}
.book-detail .hint.error {
  color: var(--cinnabar);
}
</style>

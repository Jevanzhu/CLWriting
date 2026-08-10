<script setup lang="ts">
// 设置 · 版本历史 tab：版本保留规则（天数/数量）+ 定稿版本统计。
import { ref, computed, watch, inject } from 'vue'
import { History, BookOpen, Trash2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { getConfig } from '../../api/books'
import { getVersionStats, pruneVersions, type VersionStats } from '../../api/snapshots'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

const hasBook = computed(() => !!ws.bookName)

const SNAPSHOT_DEFAULTS = { maxDays: 14, maxCount: 30 }
const snapDays = ref(SNAPSHOT_DEFAULTS.maxDays)
const snapCount = ref(SNAPSHOT_DEFAULTS.maxCount)
const bookKind = ref<'long' | 'short'>('long')
const versionStats = ref<VersionStats | null>(null)
const pruning = ref(false)

/** 清理过期编辑快照（按保留策略；pinned 定稿版本永久保留） */
async function onPrune(): Promise<void> {
  const name = ws.bookName
  if (!name || pruning.value) return
  pruning.value = true
  try {
    const removed = await pruneVersions(name)
    ui.toast(removed > 0 ? `已清理 ${removed} 个过期版本` : '没有需要清理的版本', 'success')
    await loadVersionStats()
  } catch (e) {
    ui.toast(`清理失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    pruning.value = false
  }
}

/** 字节数人性化（预览：2.3 MB / 480 KB）。 */
function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

async function loadVersionStats(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  try {
    versionStats.value = await getVersionStats(name)
  } catch {
    versionStats.value = null
  }
}

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open || !name) return
    try {
      const cfg = await getConfig(name)
      bookKind.value = cfg.kind ?? 'long'
      snapDays.value = cfg.snapshots?.max_days ?? SNAPSHOT_DEFAULTS.maxDays
      snapCount.value = cfg.snapshots?.max_count ?? SNAPSHOT_DEFAULTS.maxCount
      void loadVersionStats()
    } catch {
      /* 读不到就用默认值展示 */
    }
  },
  { immediate: true },
)

function onSnapInput(which: 'days' | 'count', e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  if (which === 'days') snapDays.value = Math.min(365, Math.max(1, Math.round(raw)))
  else snapCount.value = Math.min(200, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    c.snapshots = { max_days: snapDays.value, max_count: snapCount.value }
  })
}
</script>

<template>
  <div v-if="!hasBook" class="empty-tab">
    <History :size="28" />
    <p>请先打开一本书</p>
  </div>
  <template v-else>
    <div class="book-banner">
      <BookOpen :size="16" />
      <span>{{ ws.bookName }}</span>
    </div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">版本保留</div>
          <div class="setting-item-desc">每章历史版本的保留规则</div>
        </div>
        <div class="setting-item-control">
          <span class="backup-summary">{{ snapDays }} 天 · {{ snapCount }} 个</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">保留天数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="365" :value="snapDays" @change="onSnapInput('days', $event)" />
          <span class="val-suffix">天</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">保留数量</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="200" :value="snapCount" @change="onSnapInput('count', $event)" />
          <span class="val-suffix">个</span>
        </div>
      </div>
    </section>

    <div class="cfg-card-head">定稿版本</div>
    <section class="cfg-card">
      <template v-if="versionStats">
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">已定稿章节</div>
            <div class="setting-item-desc">文档清单中有定稿基线的章节</div>
          </div>
          <div class="setting-item-control">
            <span class="backup-summary">{{ versionStats.finalizedDocs }} 章</span>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">定稿版本总数</div>
            <div class="setting-item-desc">永久保留，不自动清理</div>
          </div>
          <div class="setting-item-control">
            <span class="backup-summary">{{ versionStats.pinnedCount }} 个</span>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">当前快照占用</div>
            <div class="setting-item-desc">编辑快照（非定稿）占用的磁盘空间</div>
          </div>
          <div class="setting-item-control">
            <span class="backup-summary">{{ formatBytes(versionStats.snapshotBytes) }} · {{ versionStats.snapshotCount }} 个</span>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">清理过期快照</div>
            <div class="setting-item-desc">按保留规则删除超期/超量的编辑快照（定稿版本永久保留）</div>
          </div>
          <div class="setting-item-control">
            <button class="link-btn danger" :disabled="pruning" @click="onPrune">
              <Trash2 :size="12" />
              {{ pruning ? '清理中…' : '立即清理' }}
            </button>
          </div>
        </div>
      </template>
      <div v-else class="stats-hint">统计数据加载中…</div>
    </section>
  </template>
</template>

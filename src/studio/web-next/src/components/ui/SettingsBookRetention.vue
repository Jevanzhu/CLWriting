<script setup lang="ts">
// 「本书」页 · 版本保留覆盖组 + 定稿版本统计（IA 重组前是 SettingsHistory 的本书部分）。
// 生效链：book.yaml snapshots → global.json（prefs store）→ 硬编码 14 天 / 30 个，服务端 prune 同链；
// 全局默认在「版本保留」页。父组件（本书页）已用 v-if="hasBook" 保证有书打开；本组件独立拉 config。
import { ref, computed, watch, inject } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig } from '../../api/books'
import { getVersionStats, pruneVersions, type VersionStats } from '../../api/snapshots'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

// ── 本书覆盖（book.yaml snapshots 段；null = 未设置 = 跟随全局）──
const bookDays = ref<number | null>(null)
const bookCount = ref<number | null>(null)

// 当前生效值（本书覆盖 ?? 全局默认）：本书开关 desc 与覆盖初始化用
const effDays = computed(() => bookDays.value ?? prefs.snapDays)
const effCount = computed(() => bookCount.value ?? prefs.snapCount)
const bookOverride = computed(() => bookDays.value !== null || bookCount.value !== null)

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
    if (!open) return
    // 无书打开：覆盖复位 + 统计清空（父组件此时整页空态，复位只为切书不留旧值）
    if (!name) {
      bookDays.value = null
      bookCount.value = null
      versionStats.value = null
      return
    }
    try {
      const cfg = await getConfig(name)
      bookDays.value = cfg.snapshots?.max_days ?? null
      bookCount.value = cfg.snapshots?.max_count ?? null
      void loadVersionStats()
    } catch {
      /* 读不到按跟随全局展示 */
    }
  },
  { immediate: true },
)

/** 「本书使用独立设定」开关：off = 跟随全局（删 book.yaml 的 snapshots 段）；
 *  on = 用当前生效值初始化覆盖（防呆：从生效值起步，切换本身不改变行为）。 */
function onOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookDays.value = effDays.value
    bookCount.value = effCount.value
    void saveConfig((c) => {
      c.snapshots = { max_days: effDays.value, max_count: effCount.value }
    })
  } else {
    bookDays.value = null
    bookCount.value = null
    void saveConfig((c) => {
      delete c.snapshots
    })
  }
}

/** 本书覆盖数值输入（clamp 后写 book.yaml，两天/数量同段成对写入） */
function onBookSnapInput(which: 'days' | 'count', e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  if (which === 'days') bookDays.value = Math.min(365, Math.max(1, Math.round(raw)))
  else bookCount.value = Math.min(200, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    c.snapshots = { max_days: bookDays.value ?? effDays.value, max_count: bookCount.value ?? effCount.value }
  })
}
</script>

<template>
  <div class="cfg-card-head">版本保留</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">本书使用独立设定</div>
        <div class="setting-item-desc">
          当前生效 {{ effDays }} 天 · {{ effCount }} 个{{ bookOverride ? '' : '（跟随全局默认）' }}
        </div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="本书使用独立设定" :checked="bookOverride" @change="onOverrideToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <template v-if="bookOverride">
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">保留天数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="365" :value="bookDays ?? effDays" @change="onBookSnapInput('days', $event)" />
          <span class="val-suffix">天</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">保留数量</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="200" :value="bookCount ?? effCount" @change="onBookSnapInput('count', $event)" />
          <span class="val-suffix">个</span>
        </div>
      </div>
    </template>
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

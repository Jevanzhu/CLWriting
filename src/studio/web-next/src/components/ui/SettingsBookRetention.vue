<script setup lang="ts">
// 「本书」页 · 定稿版本统计（IA 重组前是 SettingsHistory 的本书部分）。
// 版本保留策略 2026-08-19 起砍掉书级覆盖——保留天数/数量只走全局（「版本保留」页），
// 本书页仅保留定稿版本统计与「立即清理」（清理按全局策略执行，同服务端 prune 链）。
import { ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { getVersionStats, pruneVersions, type VersionStats } from '../../api/snapshots'

const ui = useUiStore()
const ws = useWorkspaceStore()

const versionStats = ref<VersionStats | null>(null)
const pruning = ref(false)

/** 清理过期编辑快照（按全局保留策略；pinned 定稿版本永久保留） */
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

let statsGen = 0
async function loadVersionStats(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  // L-F6（第八轮）：代守卫——慢响应在途切书后旧书版本统计覆盖 B 书「本书」页展示
  const gen = ++statsGen
  try {
    const r = await getVersionStats(name)
    if (gen === statsGen) versionStats.value = r
  } catch {
    if (gen === statsGen) versionStats.value = null
  }
}

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    // 无书打开：统计清空（父组件此时整页空态，复位只为切书不留旧值）
    if (!name) {
      versionStats.value = null
      return
    }
    void loadVersionStats()
  },
  { immediate: true },
)
</script>

<template>
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
          <div class="setting-item-desc">按全局保留规则删除超期/超量的编辑快照（定稿版本永久保留）</div>
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

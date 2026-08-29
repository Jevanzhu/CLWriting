<script setup lang="ts">
// 伏笔追踪面板（右栏信息 tab 折叠分区）：
// 全书伏笔列表（未回收/已回收/废弃分组）+ 统计 + 当前章节联动高亮 + 点击编辑 + 新建。
import { ref, computed, watch } from 'vue'
import { Plus, CircleAlert, Check, ChevronDown, BookMarked } from 'lucide-vue-next'
import { getForeshadows, type Foreshadow } from '../../api/foreshadows'
import { createDoc } from '../../api/documents'
import { useDocStore } from '../../stores/doc'
import { useTreeStore } from '../../stores/tree'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { parseChapterFileName } from '../../shared/words'
import { friendlyError } from '../../shared/error'

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

const list = ref<Foreshadow[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const showResolved = ref(false)

/** 当前编辑正文章节的章号（用于联动高亮） */
const currentChapNo = computed<number | null>(() => {
  if (!ws.activeDocId) return null
  const entry = doc.get(ws.activeDocId)
  if (!entry || !entry.path.startsWith('写作/正文/')) return null
  // entry.path 是完整相对路径（写作/正文/N-标题.md）→ 章号从文件名尾段提取
  const name = entry.path.split('/').pop() ?? ''
  return parseChapterFileName(name)?.章号 ?? null
})

function importanceRank(s: string): number {
  return s === '高' ? 0 : s === '中' ? 1 : 2
}

function riskRank(r?: string): number {
  return r === '红' ? 0 : r === '黄' ? 1 : 2
}
const pending = computed(() =>
  list.value
    .filter((f) => f.状态 === '未回收')
    .sort((a, b) => {
      const dr = riskRank(a.足迹?.risk) - riskRank(b.足迹?.risk)
      if (dr !== 0) return dr
      return importanceRank(a.重要性) - importanceRank(b.重要性) || (a.埋设章号 ?? 9999) - (b.埋设章号 ?? 9999)
    }),
)
const resolved = computed(() => list.value.filter((f) => f.状态 === '已回收'))
const abandoned = computed(() => list.value.filter((f) => f.状态 === '已废弃'))

/** 本章埋设的未回收伏笔（当前章节联动提醒） */
const currentPlanted = computed(() => pending.value.filter((f) => f.埋设章号 === currentChapNo.value))

// M-11：加载代守卫（words store reqGen 同款）——快速切书 A→B 时 A 的慢响应不覆盖
// B 的伏笔列表（create 后的 load 同享守卫）
let loadGen = 0
async function load(): Promise<void> {
  const gen = ++loadGen
  if (!props.bookName) return
  loading.value = true
  error.value = null
  try {
    const r = await getForeshadows(props.bookName)
    if (gen !== loadGen) return
    list.value = r
  } catch (e) {
    if (gen !== loadGen) return
    error.value = friendlyError(e)
  } finally {
    if (gen === loadGen) loading.value = false
  }
}

async function openFile(file: string): Promise<void> {
  const node = tree.byPath.get(file)
  if (node?.docId) {
    // 低级项（第六轮）：打开失败不再裸抛——模板点击处理器不接 async 错，
    // 未捕获 rejection 且无任何提示（对齐 EditorView 的打开编排）
    try {
      await doc.open(node)
      ws.openTab(node.docId)
    } catch (err) {
      ui.toast(friendlyError(err), 'error')
    }
  }
}

// R75-E-P3d：新建在途锁（TrashPanel restore 的 restoring 锁同款）——按钮无 disabled，
// 双击第二笔与第一笔并发 createDoc 同路径 → 服务端 409/重名冲突 toast 误导作者
const creating = ref(false)
async function create(): Promise<void> {
  if (creating.value) return // 在途锁：双击第二笔直接忽略
  const existing = new Set(list.value.map((f) => f.标题))
  let name = '新伏笔'
  let i = 2
  while (existing.has(name)) name = `新伏笔${i++}`
  // 低-4（第十轮）：入口捕获 + await 后活源复检（FE-3 类收敛）——createDoc 在途切书后，
  // 旧书续体继续 tree.load/openTab 会顶开 B 书工作台正开的伏笔标签（共享 store 被写入）。
  // 本面板经 SidebarRight 常驻外壳挂载（非 keyed），props.bookName 即路由活书名（无滞后），
  // 再比 doc store 内 live bookName 兜底（对齐 Book.vue 切书编排的权威书名）
  const book = props.bookName
  creating.value = true
  try {
    const r = await createDoc(book, { relPath: `设定/伏笔/${name}.md` })
    if (props.bookName !== book || doc.bookName !== book) return // 已切书：放弃后续写操作
    await tree.load(props.bookName)
    await load()
    const fresh = tree.byPath.get(r.path)
    if (fresh?.docId) {
      await doc.open(fresh)
      ws.openTab(fresh.docId)
    }
  } catch (e) {
    // R75-E-P3c：catch 侧补同款书名复检——成功路径有门（上方），catch 漏配：
    // createDoc await 窗口切书后，A 书的失败错误会 toast 在 B 书界面上（R70-10 同族）
    if (props.bookName !== book || doc.bookName !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    creating.value = false
  }
}

watch(() => props.bookName, load, { immediate: true })
</script>

<template>
  <div class="fs-panel">
    <!-- 当前章节联动提醒 -->
    <div v-if="currentPlanted.length" class="fs-current-hint">
      本章埋设 {{ currentPlanted.length }} 个未回收伏笔
    </div>

    <!-- 统计行 -->
    <div v-if="list.length" class="fs-stats">
      <span v-if="pending.length" class="stat stat-pending">未回收 {{ pending.length }}</span>
      <span v-if="resolved.length" class="stat stat-resolved">已回收 {{ resolved.length }}</span>
      <span v-if="abandoned.length" class="stat stat-abandoned">废弃 {{ abandoned.length }}</span>
    </div>

    <div v-if="loading" class="hint">加载中…</div>
    <div v-else-if="error" class="hint err">{{ error }}</div>
    <div v-else-if="!list.length" class="fs-empty">
      <BookMarked :size="24" class="empty-icon" />
      <p>暂无伏笔记录</p>
      <p class="sub">埋下的线索在这里追踪，写作时提醒回收</p>
    </div>

    <div v-else class="fs-list">
      <!-- 未回收 -->
      <div
        v-for="f in pending"
        :key="f.file"
        class="fs-item pending"
        :class="{ current: currentChapNo !== null && f.埋设章号 === currentChapNo }"
        @click="openFile(f.file)"
      >
        <CircleAlert :size="14" class="fs-icon" :class="'risk-' + (f.足迹?.risk ?? '绿')" />
        <div class="fs-body">
          <span class="fs-title">{{ f.标题 }}</span>
          <span v-if="f.足迹 && f.足迹.staleSpan > 0" class="fs-trail" :class="'risk-' + f.足迹.risk">
            悬{{ f.足迹.staleSpan }}章<span v-if="f.足迹.lastHit"> · 末次提及第{{ f.足迹.lastHit }}章</span>
          </span>
          <span v-else-if="f.埋设章号" class="fs-chap">第{{ f.埋设章号 }}章埋设</span>
        </div>
        <span class="fs-pri" :class="'p-' + f.重要性">{{ f.重要性 }}</span>
      </div>

      <!-- 已回收（折叠） -->
      <div v-if="resolved.length" class="fs-toggle" @click="showResolved = !showResolved">
        <Check :size="12" /> 已回收 {{ resolved.length }}
        <ChevronDown :size="12" class="toggle-caret" :class="{ closed: !showResolved }" />
      </div>
      <template v-if="showResolved">
        <div v-for="f in resolved" :key="f.file" class="fs-item resolved" @click="openFile(f.file)">
          <Check :size="14" class="fs-icon" />
          <span class="fs-title">{{ f.标题 }}</span>
          <span class="fs-meta resolved-meta">
            第{{ f.埋设章号 ?? '?' }}章→第{{ f.回收章号 ?? '?' }}章
          </span>
        </div>
      </template>
    </div>

    <button class="fs-add" @click="create">
      <Plus :size="13" /> 新建伏笔
    </button>
  </div>
</template>

<style scoped>
.fs-panel {
  padding: 0 2px;
}
.fs-current-hint {
  font-size: var(--font-size-xs);
  color: var(--text-warning);
  padding: 4px 8px;
  margin-bottom: 6px;
  background: color-mix(in srgb, var(--text-warning) 10%, transparent);
  border-radius: var(--radius-s);
}
.fs-stats {
  display: flex;
  gap: 10px;
  padding: 0 4px 8px;
  font-size: var(--font-size-xs);
}
.stat-pending { color: var(--text-error); }
.stat-resolved { color: var(--dv-good); }
.stat-abandoned { color: var(--text-faint); }

.hint {
  padding: 8px;
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.hint.err { color: var(--text-error); }

.fs-empty {
  text-align: center;
  padding: 20px 8px;
  color: var(--text-faint);
  font-size: var(--font-size-s);
}
.empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}
.sub {
  font-size: var(--font-size-xs);
  margin-top: 4px;
}

.fs-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.fs-item:hover {
  background: var(--background-modifier-hover);
}
.fs-item.current {
  background: color-mix(in srgb, var(--text-warning) 12%, transparent);
}
.fs-icon {
  flex-shrink: 0;
}
.pending .fs-icon {
  color: var(--text-error);
}
.fs-icon.risk-黄 {
  color: var(--text-warning);
}
.fs-icon.risk-绿 {
  color: var(--dv-good);
}
.fs-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fs-trail {
  font-size: var(--font-size-xxs);
}
.fs-trail.risk-红 { color: var(--text-error); }
.fs-trail.risk-黄 { color: var(--text-warning); }
.fs-trail.risk-绿 { color: var(--text-faint); }
.resolved {
  opacity: 0.55;
}
.resolved .fs-icon {
  color: var(--dv-good);
}
.fs-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.fs-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fs-pri {
  font-size: var(--font-size-xxs);
  padding: 1px 4px;
  border-radius: var(--radius-s);
}
.p-高 { color: var(--text-error); background: color-mix(in srgb, var(--text-error) 10%, transparent); }
.p-中 { color: var(--text-warning); background: color-mix(in srgb, var(--text-warning) 10%, transparent); }
.p-低 { color: var(--text-faint); background: var(--background-modifier-hover); }
.fs-chap {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.resolved-meta {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}

.fs-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 3px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  cursor: pointer;
  user-select: none;
}
.toggle-caret {
  transition: transform var(--dur-fast) var(--ease-out);
}
.toggle-caret.closed {
  transform: rotate(-90deg);
}

.fs-add {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 8px;
  margin-top: 6px;
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.fs-add:hover {
  border-color: var(--interactive-accent);
  color: var(--text-accent);
}
</style>

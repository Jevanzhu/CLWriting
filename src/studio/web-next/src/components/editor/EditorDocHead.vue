<script setup lang="ts">
// 编辑器顶栏卡（巨石批 7b 拆分自 EditorView）：单行路径式——左（类型 pill · 面包屑 →
// 可编辑标题），右（字数 · 章节状态 · 冲突双出路 · AI 辅助组 · 定稿 · 保存）。
// 标题编辑 v-model 双向父层（父层 page-title 同步展示）；bookKind/wordCount 父层算好传入。
import { computed, ref } from 'vue'
import { Loader2, Save, Check, Lock } from 'lucide-vue-next'
import { useDocStore } from '../../stores/doc'
import { useTreeStore } from '../../stores/tree'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { useRewriteStore } from '../../stores/rewrite'
import { updateChapterMetaDoc } from '../../api/documents'
import { parseFmFields, formKindOf, isBodyKind } from '../../shared/words'
import { useAiAssist } from '../../composables/useAiAssist'
import { friendlyError } from '../../shared/error'

const props = defineProps<{
  docId: string | null
  bookKind: 'long' | 'short' | null
  wordCount: number
}>()
const title = defineModel<string>('title', { required: true })
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
const rewrite = useRewriteStore()

const entry = computed(() => (props.docId ? doc.get(props.docId) : undefined))

const aiOff = computed(() => ui.aiAvailable === false)
const isReviewable = computed(() => {
  if (!entry.value) return false
  if (formKindOf(entry.value.path) !== null) return true
  return isBodyKind(entry.value.path)
})
const isChapter = computed(() => isBodyKind(entry.value?.path ?? ''))

// 面包屑：文档路径到父目录（末级=文件名=标题，不重复）
const crumbs = computed(() => {
  const p = entry.value?.path ?? ''
  return p.replace(/\.md$/, '').split('/').slice(0, -1).filter(Boolean)
})

// 章节正文状态（TreeNode.status → 中文标签）
const STATUS_LABEL: Record<string, string> = {
  idea: '构想', draft: '草稿', revision: '修订',
  final: '定稿', published: '已发布', archived: '已归档',
}
const chapterStatus = computed(() => {
  if (!props.docId) return null
  const node = tree.byDocId.get(props.docId)
  const s = node?.status
  return s ? STATUS_LABEL[s] ?? null : null
})
// 状态色（和章节树六态对齐）：final·published 绿 / revision 红 / draft 黄 / 其余灰
const statusCls = computed(() => {
  if (!props.docId) return ''
  const s = tree.byDocId.get(props.docId)?.status
  switch (s) {
    case 'final':
    case 'published':
      return 'st-good'
    case 'revision':
      return 'st-bad'
    case 'draft':
      return 'st-warn'
    default:
      return 'st-faint'
  }
})

const saveStatus = computed<{ text: string; cls: string }>(() => {
  const e = entry.value
  if (!e) return { text: '', cls: '' }
  if (e.saving) return { text: '保存中', cls: 'saving' }
  if (e.error) return { text: '保存失败', cls: 'err' }
  if (e.dirty) return { text: '未保存', cls: 'dirty' }
  if (e.savedAt) return { text: '已保存', cls: 'saved' }
  return { text: '', cls: '' }
})

/** 保存按钮标签（dirty→保存 / saved→已保存 / err→重试）。 */
const saveBtnLabel = computed(() => {
  const e = entry.value
  if (!e) return '保存'
  if (e.saving) return '保存中'
  if (e.error) return '重试'
  return e.dirty ? '保存' : '已保存'
})

/** 手动保存（按钮；⌘S/Ctrl+S 在父层挂）。 */
function onSave(): void {
  const e = entry.value
  if (!e || e.saving || (!e.dirty && !e.error)) return
  void doc.save(e.docId, 'manual')
}

// 定稿确认：正文区 draft（从未定稿）可首次定稿、revision（定稿后改动）可重新定稿；
// final 已定稿不显（草稿区/待定稿在 工作区/ 非正文区，由 path 前缀排除）。
const isFinalizable = computed(() => {
  if (!props.docId) return false
  const node = tree.byDocId.get(props.docId)
  if (!node || node.isDirectory) return false
  if (!node.path.startsWith('写作/正文/')) return false // 仅正文章节可定稿（草稿/设定/大纲不参与）
  return node.status === 'draft' || node.status === 'revision'
})
const finalizing = ref(false)
async function onFinalize(): Promise<void> {
  if (!props.docId || finalizing.value) return
  finalizing.value = true
  try {
    await doc.finalize(props.docId)
  } finally {
    finalizing.value = false
  }
}

const { aiActions, runAiAssist } = useAiAssist()

const titleSaving = ref(false)
async function onTitleCommit(): Promise<void> {
  const e = entry.value
  if (!e || !ws.activeDocId || titleSaving.value) return
  // dd-P2：入口捕获 docId——await（updateChapterMetaDoc + tree.load 大书较慢）期间
  // 切 tab 后 ws.activeDocId 已指向新文档，届时取 fresh 回填会把新文档的 path/name
  // 写进旧文档缓存条目（标题栏错乱）并对错误文档 refresh
  const id = ws.activeDocId
  const newTitle = title.value.trim() || '未命名'
  const current = parseFmFields(e.content).标题 ?? e.name
  if (newTitle === current) return
  titleSaving.value = true
  try {
    // 短篇传 章号（占位沿用现有值，仅改标题）；后端按 piece-body 落 fm + 章纲目录 rename
    // P2：fm 缺章号时从文件名提取（防 fallback 1 覆盖真实章号）
    // P2-FE-5：`||` 替代 `??`——NaN/undefined/0 均 fallback 到路径提取或 1（fm 损坏时防 NaN 传入 API）
    const pieceNum = e.role === 'piece-body'
      ? Number(parseFmFields(e.content).章号 || e.path.match(/(\d+)-[^/]*\.md$/)?.[1] || 1)
      : undefined
    await updateChapterMetaDoc(doc.bookName!, id, {
      标题: newTitle,
      ...(e.role === 'piece-body' && pieceNum !== undefined ? { 章号: pieceNum } : {}),
    })
    await tree.load(doc.bookName!)
    if (ws.activeDocId !== id) return // 已切文档：fm 已落盘，树已全量刷新，放弃对旧条目的回填
    const fresh = tree.byDocId.get(id)
    if (fresh) {
      e.path = fresh.path
      e.name = fresh.name
    }
    // CC-P2-15：refresh 自带本地正文保护（dirty 时只取服务端 fm、正文保留本地）
    await doc.refresh(id)
    // P2-FE-3：标题提交已成功 → 清除可能因 autosave 竞态残留的 conflict 标记。
    // Q-10（第十五轮）：仅正文干净时清——dirty 时 refresh 保留本地正文，若一并清
    // conflict，后续 autosave 会以本地正文静默覆盖外部修改，绕过「重载/覆盖」决断
    //（外部版本仅存 .版本 快照可找回）。
    const refreshed = doc.get(id)
    if (refreshed && !refreshed.dirty) refreshed.conflict = false
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  } finally {
    titleSaving.value = false
  }
}
</script>

<template>
  <!-- 顶栏 wrapper：和 doc-body 共享左右 padding，保证卡片宽度同步 -->
  <div class="doc-head-slot">
    <header class="doc-head">
      <div class="doc-bar">
        <!-- 左：类型 pill · 面包屑 → 标题（完整路径） -->
        <div class="bar-left">
          <span v-if="bookKind" class="book-kind" :class="bookKind">{{ bookKind === 'long' ? '长篇' : '短篇' }}</span>
          <span v-if="bookKind" class="bar-split" />
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i > 0" class="bar-sep">›</span>
            <span class="bar-crumb">{{ c }}</span>
          </template>
          <span v-if="crumbs.length" class="bar-sep">›</span>
          <input
            v-if="isChapter"
            v-model="title"
            class="bar-title editable"
            placeholder="未命名"
            @blur="onTitleCommit"
            @keydown.enter.prevent="onTitleCommit"
          />
          <span v-else class="bar-title">{{ entry?.name }}</span>
        </div>
        <!-- 右：字数 · 状态 · 冲突 · AI · 保存（最右） -->
        <div class="bar-right">
          <span class="word-count">{{ wordCount.toLocaleString() }} 字</span>
          <span v-if="chapterStatus" class="doc-status" :class="statusCls">{{ chapterStatus }}</span>
          <template v-if="entry?.conflict">
            <button class="conflict-btn" @click="doc.reloadFromRemote(entry.docId)">重载</button>
            <button class="conflict-btn danger" @click="doc.overwriteRemote(entry.docId)">覆盖</button>
          </template>
          <div v-if="isReviewable" class="ai-group">
            <button
              v-for="a in aiActions"
              :key="a.key"
              class="ai-btn"
              :disabled="aiOff || rewrite.loading"
              :data-tip="aiOff ? 'AI 暂不可用' : 'Beta · ' + a.label"
              data-tip-dir="bottom"
              @click="runAiAssist(a)"
            >
              {{ a.label }}
            </button>
            <Loader2 v-if="rewrite.loading" :size="12" class="ai-btn-spin" />
          </div>
          <button
            v-if="isFinalizable"
            class="finalize-btn"
            :disabled="finalizing || entry?.saving"
            data-tip="定稿（锁定当前版本，git 提交）"
            data-tip-dir="bottom"
            @click="onFinalize"
          >
            <Loader2 v-if="finalizing" :size="12" class="save-btn-spin" />
            <Lock v-else :size="12" />
            <span>{{ finalizing ? '定稿中…' : '定稿' }}</span>
          </button>
          <div class="save-group">
            <button
              class="save-btn"
              :class="saveStatus.cls"
              :disabled="entry?.saving || (!entry?.dirty && !entry?.error)"
              data-tip="保存（⌘S）"
              data-tip-dir="bottom"
              @click="onSave"
            >
              <Loader2 v-if="entry?.saving" :size="12" class="save-btn-spin" />
              <Check v-else-if="entry?.savedAt && !entry?.dirty" :size="12" />
              <Save v-else :size="12" />
              <span>{{ saveBtnLabel }}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  </div>
</template>

<style scoped>
/* ===== 独立顶栏（白底卡片，和正文纸张同风格） ===== */
.doc-head-slot {
  flex-shrink: 0;
  padding: 0 var(--doc-pad-x);
}
.doc-head {
  max-width: var(--page-width, 1020px);
  width: 100%;
  margin: var(--size-4-3) auto 0;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-s);
  padding: var(--size-4-2) var(--size-4-3);
}
.doc-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-3);
  min-height: 30px;
}

/* 左：类型 pill · 面包屑 → 标题 */
.bar-left {
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
/* 长篇/短篇 类型 pill（蓝/橙，与状态色绿红黄区分） */
.book-kind {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  font-weight: 600;
  white-space: nowrap;
}
.book-kind.long {
  color: var(--cat-4);
  background: color-mix(in srgb, var(--cat-4) 14%, transparent);
}
.book-kind.short {
  color: var(--cat-2);
  background: color-mix(in srgb, var(--cat-2) 14%, transparent);
}
/* pill 与面包屑间的短分隔线（与 AI 区隔风格统一） */
.bar-split {
  align-self: center;
  flex-shrink: 0;
  width: 1px;
  height: 14px;
  margin-left: 6px;
  margin-right: 6px;
  background: var(--background-modifier-border);
}
.bar-crumb {
  white-space: nowrap;
}
.bar-sep {
  opacity: 0.35;
}
.bar-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--prose-font);
}
.bar-title.editable {
  border-radius: var(--radius-s);
  padding: 1px 6px;
  margin: -1px -6px;
  cursor: text;
  transition: background var(--dur-fast) var(--ease-out);
}
.bar-title.editable:hover,
.bar-title.editable:focus {
  background: var(--background-modifier-hover);
}

/* 右：状态 + AI */
.bar-right {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  flex-shrink: 0;
}
.word-count {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: var(--radius-s);
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.doc-status {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: var(--radius-s);
}
.doc-status.st-good {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.doc-status.st-bad {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 12%, transparent);
}
.doc-status.st-warn {
  color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 12%, transparent);
}
.doc-status.st-faint {
  color: var(--text-faint);
  background: var(--background-modifier-hover);
}
/* 保存按钮：与 AI 按钮同款 pill（同 padding/字号/圆角），置于最右；所有状态都有
   底色框（idle 灰 / dirty 实色翠绿 / saving·saved 绿软底 / err 红软底），
   padding/高度/框样式跨状态一致 → 形状规格统一。 */
.save-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
/* 定稿按钮：revision 态提示色，与「保存」（写文件）对偶——定稿=锁定版本 */
.finalize-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  margin-right: 4px;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.finalize-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.finalize-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* dirty：实色翠绿——主操作态，与 AI 实色 pill 同形态、换绿色相 */
.save-btn.dirty {
  background: var(--dv-good);
  color: var(--text-on-accent);
}
.save-btn.dirty:hover {
  background: color-mix(in srgb, var(--dv-good) 88%, white);
}
/* saving：翠绿软底 + 转圈（进行中，保持操作色相） */
.save-btn.saving {
  background: color-mix(in srgb, var(--dv-good) 22%, transparent);
  color: var(--dv-good);
}
/* saved：淡翠绿软底 + ✓（完成态；保留框，与其他状态边缘对齐） */
.save-btn.saved {
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
  color: var(--dv-good);
}
/* err：红软底——可点重试 */
.save-btn.err {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 14%, transparent);
}
.save-btn.err:hover {
  background: color-mix(in srgb, var(--text-error) 22%, transparent);
}
.save-btn:hover:not(:disabled):not(.dirty):not(.err) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.save-btn:disabled {
  cursor: default;
}
.save-btn-spin {
  animation: clw-spin 0.9s linear infinite;
}
.conflict-btn {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.conflict-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.conflict-btn.danger:hover { color: var(--text-error); }

/* AI 按钮 */
.ai-group {
  display: flex;
  align-items: center;
  gap: var(--size-4-1);
  padding-left: var(--size-4-3);
  border-left: 1px solid var(--background-modifier-border);
}
/* 保存按钮组：与 ai-group 对称（border-left + 同款 padding-left），分隔线两侧间距一致 */
.save-group {
  display: flex;
  align-items: center;
  padding-left: var(--size-4-3);
  border-left: 1px solid var(--background-modifier-border);
}
.ai-btn {
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ai-btn:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.ai-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ai-btn-spin {
  color: var(--text-accent);
  margin: 0 4px;
  animation: clw-spin 0.9s linear infinite;
}

</style>

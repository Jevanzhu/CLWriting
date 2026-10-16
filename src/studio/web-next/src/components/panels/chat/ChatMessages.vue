<script setup lang="ts">
/**
 * 对话消息流（hh §八-16 自 ChatPanel.vue 拆出；本轮再按「列表容器 + 消息项 + 工具卡」
 * 三层收窄：单条消息在 chat/ChatMessageItem.vue，工具卡与参数摘要单算在
 * chat/ChatToolCard.vue，本件只留列表容器面）。
 *
 * 容器面：滚动跟随（rAF 节流）/ 空态与历史尾窗截断提示 / 错误与原文回显 / 入队提示 /
 * 变体组定位（依赖 store 的 branches，逐消息单趟预处理后按 seq 区间取首个命中）/
 * 工具确认单飞（按 callId 集合，同卡防重、跨卡并行）。输入区留在 ChatPanel（dock 拆分
 * 场景只挂本件时由 hideComposer 控制）。章号语境直读 chat store 单一事实源（原经
 * ChatPanel 的 composer 实例 props 传入，dock 双实例下与用户实际选择分裂）。
 */
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { MessageSquareText, AlertCircle, Info } from 'lucide-vue-next'
import { useChatStore, type ChatMessage } from '../../../stores/chat'
import { useTreeStore } from '../../../stores/tree'
import { type ChapterNameLookup } from '../../../../../../shared/contract/tool-meta'
import { parseChapterFileName } from '../../../shared/words'
import { confirmTool, type ChatBranchInfo } from '../../../api/chat'
import { CHAT_HISTORY_LIMIT } from '../../../shared/chat-history'
import { ApiError } from '../../../api/client'
import { useUiStore } from '../../../stores/ui'
import { useScopedAction } from '../../../composables/useScopedAction'
import ChatMessageItem from './ChatMessageItem.vue'

const props = defineProps<{
  bookName: string
}>()

const chat = useChatStore()
const ui = useUiStore()
const tree = useTreeStore()
// 切书守卫单源（stillIn）——工具确认在途切书后，迟到的失败提示/终态不落新书界面。
const scoped = useScopedAction(() => props.bookName)

/** 尾窗截断提示文案。total 未知（旧后端缺字段）= 只说窗口上限；已知则附总量——
 * 截断态 total 是骨架事件行数（非投影消息数），故冠「约」。 */
const truncatedHint = computed(() => {
  const base = `仅显示最近 ${CHAT_HISTORY_LIMIT} 条对话`
  const total = chat.historyTotal
  return total === null ? `${base}，更早内容见审计视图` : `${base}（共约 ${total} 条记录），更早内容见审计视图`
})

// ── 滚动（rAF 节流：流式 chat_text 每帧可能触发多次，同帧只滚一次）──

const scrollRef = ref<HTMLElement | null>(null)
let scrollRaf = 0
// 用户上滚离开底部的距离阈值（px）——流式输出自动滚动只在距底阈值内跟随，
// 上滚读历史时不再被 SSE 流式内容拽回去
const AUTO_FOLLOW_THRESHOLD = 64
/** 距底是否在阈值内（rAF 复用：onScroll 高频，同帧只读一次）允许自动跟随 */
let nearBottom = true
function onScroll(): void {
  const el = scrollRef.value
  if (!el) return
  nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_FOLLOW_THRESHOLD
}
/** 滚底。force=false（流式默认）只在用户距底阈值内才滚——上滚读历史不打扰；
 *  force=true（发送后/显式调用）无条件滚底。 */
function scrollToBottom(force = false): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    if (!scrollRef.value) return
    if (force || nearBottom) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  })
}

// 卸载时取消未完成的 rAF，防回调访问已销毁组件
onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})

// ── 消息流滚动跟随 ──────────────────────────────

watch(
  // notice 变化同样触发滚底（入队提示在流尾部，不跟随则不可见）
  [() => chat.messages.length, () => chat.messages.at(-1)?.content, () => chat.notice],
  () => void nextTick(scrollToBottom),
)

// 发送后滚底由 ChatPanel 经 ref 调用（useChatComposer 的 onPushed 回调）
defineExpose({ scrollToBottom })

// ──轻量档：失败回合作者原文复制重发 ──────────

const echoCopied = ref(false)
let echoCopiedTimer = 0
/** 复制失败回合作者原文（chat_error echo 字段）——原文须原样往返（服务端不过
 *  redactSecret，复制即重发可用）；2s 后按钮文案复位。 */
async function copyEcho(): Promise<void> {
  const text = chat.errorEcho
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    echoCopied.value = true
    if (echoCopiedTimer) window.clearTimeout(echoCopiedTimer)
    echoCopiedTimer = window.setTimeout(() => {
      echoCopied.value = false
      echoCopiedTimer = 0
    }, 2000)
  } catch {
    // 剪贴板不可用（权限/焦点缺失）——原文仍可手动框选复制（.echo-text 可选中）
  }
}
onBeforeUnmount(() => {
  if (echoCopiedTimer) window.clearTimeout(echoCopiedTimer)
})

// ── 工具确认 ────────────────────────────────────

// 确认在途按 callId 记集合（Vue 3 对 Set.add/delete 本身就有响应式插桩，
// add/delete 直接触发依赖更新——SampleCandidateList 的 expandedGroups 即直接依赖；
// 此处逐次重赋新 Set 属防御性惯例而非响应性必需）。原 confirmingCallId 单值把所有
// 待确认卡串行化：多张待确认卡并存时，第二张的点击被入口静默忽略（按钮虽未禁但
// 毫无反应）；改为同卡防重、跨卡并行。
const confirmingCallIds = ref<Set<string>>(new Set())

async function handleConfirm(callId: string, ok: boolean): Promise<void> {
  if (confirmingCallIds.value.has(callId)) return // 防重复点击（仅同卡；跨卡不受阻）
  confirmingCallIds.value = new Set(confirmingCallIds.value).add(callId)
  // 入口捕获书名——await 窗口切书后，迟到的失败 toast/工具终态
  // 落在新书界面（与 doc.finalize catch 同族守卫）
  const book = props.bookName
  try {
    await confirmTool(book, { callId, ok })
  } catch (e) {
    if (!scoped.stillIn(book)) return
    if (e instanceof ApiError && e.status === 404) {
      // 404 = 工具调用已超时失效——修复前静默 return，卡面停留 pending、
      // 确认按钮可反复点但服务端早已丢弃，作者无任何反馈。置失败终态给可见交代
      chat.updateTool(callId, { status: 'failed', summary: '确认已超时：该工具调用已失效' })
      return
    }
    ui.toast('确认请求失败，请重试', 'error')
  } finally {
    const rest = new Set(confirmingCallIds.value)
    rest.delete(callId)
    confirmingCallIds.value = rest
  }
}

// ── 工具卡片展示（中文名与参数摘要单源 src/shared/contract/tool-meta.ts，消费面在
//    chat/ChatToolCard.vue）────

/** 章号 → 作者可见章名（章节树解析；解析不到回 null，摘要层回落「第 N 章」）。
 *  建一次查表：摘要在渲染期按卡片逐张求值，而树只在增删改章时变——逐次全树扫描
 *  是 O(卡片 × 节点) 的每帧开销（流式输出期间按帧重算）。同名章号取先入者（与
 *  原先按 byPath 迭代序取首个命中同口径）。 */
const chapterNames = computed(() => {
  const m = new Map<number, string>()
  for (const node of tree.byPath.values()) {
    if (node.isDirectory) continue
    const parsed = parseChapterFileName(node.name)
    if (parsed && !m.has(parsed.章号)) m.set(parsed.章号, `第 ${parsed.章号} 章 ${parsed.标题}`)
  }
  return m
})
const chapterNameOf: ChapterNameLookup = (chapter) => chapterNames.value.get(chapter) ?? null

// ── 重新生成 + 变体切换 ─────────────────────

/** 最后一条已完成的 assistant 气泡（「重新生成」按钮的挂载点；!running 才可点） */
const lastDoneAssistant = computed(() => {
  const last = chat.messages[chat.messages.length - 1]
  return last && last.role === 'assistant' && last.done ? last : null
})

/** 重新生成最后一条回复（服务端以新 branchId 落库，SSE 回流新变体）。
 * 章号语境直读 chat store（与 dock/工作台输入区的章节选择同一份） */
function handleRegenerate(): void {
  void chat.regenerate(props.bookName, chat.selectedChapter)
}

/**
 * 变体组信息（供切换器渲染与 switchVariant 定位下一变体）。
 */
interface VariantGroupInfo {
  index: number
  total: number
  label: string
  branchIds: string[]
}

/**
 * 各助手消息的变体组定位（msgId → 当前序号/总数/同组分支 id 列表）。
 * 命中条件：消息 seq 落在某分支组区间（rootSeq ≤ seq ≤ lastSeq）且
 * 同 parentSeq 的变体组数 > 1（按 rootSeq 升序稳定排序）。
 * 原实现对每条消息各做一次
 * branches.find（区间扫描）+ 同组 filter/sort——同组过滤/排序逐消息重复（区间扫描本身
 * 仍线性，不构建区间索引）；改为循环前单趟预处理（同 parentSeq 组信息/已排序变体各算
 * 一次），消息循环查表 + 区间线性扫描。渲染输出逐项不变：组内仍 rootSeq 升序、变体
 * 归属/区间判定/无命中 group 即 continue 的 fallback 全部保留——区间扫描沿 branches
 * 原数组序（即服务端 listBranches 的 lastSeq 降序，branch-tree.ts）取首个命中，与原
 * find 同口径；重叠区间极端场景（跨分支交错续写）归组不因本批改写漂移。
 */
const variantGroups = computed(() => {
  const map = new Map<string, VariantGroupInfo>()
  const branches = chat.branches
  if (branches.length === 0) return map
  // 预处理①：parentSeq → 同组已排序变体；branchId → 组信息（仅多变体组且位次合法时登记）
  const variantsByParent = new Map<number | null, ChatBranchInfo[]>()
  const groupByBranchId = new Map<string, VariantGroupInfo>()
  for (const b of branches) {
    let variants = variantsByParent.get(b.parentSeq)
    if (!variants) {
      variants = branches.filter((x) => x.parentSeq === b.parentSeq).sort((x, y) => x.rootSeq - y.rootSeq)
      variantsByParent.set(b.parentSeq, variants)
    }
    const index = variants.findIndex((v) => v.branchId === b.branchId)
    if (index < 0 || variants.length <= 1) continue
    groupByBranchId.set(b.branchId, {
      index,
      total: variants.length,
      label: `${index + 1}/${variants.length}`,
      branchIds: variants.map((v) => v.branchId),
    })
  }
  // 预处理②：消息 seq 的区间查找沿 branches 原数组序取首个命中（原 find 同口径，见上注）
  for (const msg of chat.messages) {
    if (msg.role !== 'assistant' || msg.seq === undefined) continue
    const seq = msg.seq
    let group: ChatBranchInfo | undefined
    for (const b of branches) {
      if (seq >= b.rootSeq && seq <= b.lastSeq) {
        group = b
        break
      }
    }
    if (!group) continue
    const info = groupByBranchId.get(group.branchId)
    if (info) map.set(msg.id, info)
  }
  return map
})

/** 切到相邻变体组（首尾循环；运行中禁用） */
function switchVariant(msg: ChatMessage, dir: -1 | 1): void {
  if (chat.running) return
  const g = variantGroups.value.get(msg.id)
  if (!g) return
  const total = g.branchIds.length
  const next = g.branchIds[(g.index + dir + total) % total]
  if (next) void chat.switchBranch(props.bookName, next)
}
</script>

<template>
  <!-- 消息区：无气泡感，用户消息浅卡片右对齐，AI 消息纯文本全宽 -->
  <div ref="scrollRef" class="chat-messages" @scroll="onScroll">
    <!-- 历史尾窗截断提示——L- 起
         fetchChatHistory 尾窗上限生效时旧消息不进种子化，此前 truncated 全前端
         零消费、旧内容静默消失无提示（设计意图即提示作者：更早在事件库/审计视图可查）。
         truncated 取 store 最近一次视图加载（seedHistory/switchBranch）的权威口径；
 条数走 shared/chat-history 单源（#10，原硬编码 200）。 -->
    <div v-if="chat.historyTruncated" class="chat-truncated-hint">{{ truncatedHint }}</div>
    <div v-if="!chat.hasMessages && !chat.running" class="chat-empty">
      <MessageSquareText :size="32" class="chat-empty-icon" />
      <p class="chat-empty-title">和 AI 聊聊你的故事</p>
      <p class="chat-empty-sub">提问剧情走向、让 AI 机检章节，或直接写下一章</p>
    </div>

    <!-- 单条消息（含工具卡与变体切换）在 ChatMessageItem；组定位与确认单飞在本容器 -->
    <ChatMessageItem
      v-for="msg in chat.messages"
      :key="msg.id"
      :msg="msg"
      :running="chat.running"
      :variant-label="variantGroups.get(msg.id)?.label ?? null"
      :show-regen="lastDoneAssistant !== null && msg.id === lastDoneAssistant.id"
      :chapter-name-of="chapterNameOf"
      :confirming-call-ids="confirmingCallIds"
      @switch-variant="(dir) => switchVariant(msg, dir)"
      @regenerate="handleRegenerate"
      @confirm="handleConfirm"
    />

    <!-- 错误 -->
    <div v-if="chat.error" class="chat-error-msg">
      <AlertCircle :size="14" />
      <span>{{ chat.error }}</span>
    </div>

    <!--（轻量档）：失败回合作者原文回显——服务端已回滚/遮蔽该消息
         （防连续 user 400 语义不变），原文仅随 chat_error 的 echo 字段存在（不落事件库），
         此处提供「复制重发」，免瞬态失败（429 耗尽/断网）后整段重打。 -->
    <div v-if="chat.error && chat.errorEcho" class="chat-error-echo">
      <div class="echo-text">{{ chat.errorEcho }}</div>
      <button type="button" class="echo-copy-btn" @click="copyEcho">
        {{ echoCopied ? '已复制' : '复制原文' }}
      </button>
    </div>

    <!-- 非错误提示（E1a steer 入队确认队列超容丢弃等
         chat.notice）——此前全前端无渲染点：发送即清空输入框、运行中追加零反馈，
         作者无法得知「已入队」。消息流内联展示（对齐 error 区样式，中性色）。 -->
    <div v-if="chat.notice" class="chat-notice-msg">
      <Info :size="14" />
      <span>{{ chat.notice }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ── 消息区 ── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-4-3) var(--size-4-5);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  min-height: 0;
}
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-1);
  color: var(--text-faint);
  text-align: center;
  padding: var(--size-4-6);
}
.chat-empty-icon {
  opacity: 0.45;
  margin-bottom: var(--size-4-1);
}
.chat-empty-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-muted);
}
.chat-empty-sub {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  line-height: 1.5;
}

/* ── 错误 ── */
.chat-error-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dv-bad);
  font-size: var(--font-size-s);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--dv-bad) 8%, transparent);
}

/* ──（轻量档）：失败回合作者原文回显（跟随错误横幅，中性弱化） ── */
.chat-error-echo {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-faint) 8%, transparent);
}
.chat-error-echo .echo-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow-y: auto;
  user-select: text;
}
.echo-copy-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.echo-copy-btn:hover {
  color: var(--text-normal);
  border-color: var(--text-faint);
}

/* ── 非错误提示（notice，中性色对齐 error 区布局） ── */
.chat-notice-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}

/* ── 历史尾窗截断提示（列表顶部 muted 一行，轻量无底色） ── */
.chat-truncated-hint {
  align-self: center;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  padding: var(--size-4-1) 0;
}
</style>

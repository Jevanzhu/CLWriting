<script setup lang="ts">
// 工作台写作模式：状态卡（人话）+ 生成/中断 + 正文预览（默认主区）+ 存草稿并编辑。
// 事件流 / 阶段任务 / CLI 报告收「高级」折叠区（M4 去机器味：作者看文章，调试功能全保留）。
// 巨石批 7a 拆分：高级折叠区 → workbench/WbAdvanced、自愈进度卡 → WbHealCard、
// 生成正文卡 → WbDraftCard；本文件留状态卡 / 触发生成 / 数据加载编排。
import { ref, watch, computed, onMounted } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { useWorkbenchStore } from '../stores/workbench'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import {
  getState,
  spawnRole,
  interrupt,
  saveDraft,
  autoWrite,
  getDraftPrompt,
  generateOutline,
  generateLeadUpdates,
  type BookState,
} from '../api/stream'
import { useUiStore } from '../stores/ui'
import { usePrefsStore } from '../stores/prefs'
import { useProviderStore } from '../stores/provider'
import { getConfig } from '../api/books'
import { getTraceStats, type RuleHitEntry } from '../api/trace-stats'
import ChatPanel from '../components/panels/ChatPanel.vue'
import WbStateCard from '../components/workbench/WbStateCard.vue'
import WbAdvanced from '../components/workbench/WbAdvanced.vue'
import WbHealCard from '../components/workbench/WbHealCard.vue'
import WbDraftCard from '../components/workbench/WbDraftCard.vue'
import WbUsageCard from '../components/workbench/WbUsageCard.vue'
import { friendlyError } from '../shared/error'
import { isImeComposing } from '../shared/ime'

const props = defineProps<{ bookName: string }>()
const wb = useWorkbenchStore()
const ui = useUiStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const prefs = usePrefsStore()

/** 工作台 tab：写作 / 对话（对话 tab 仅 chatEnabled 时可见） */
const activeTab = ref<'write' | 'chat'>('write')

const state = ref<BookState | null>(null)
const prompt = ref('')
const err = ref<string | null>(null)

// 任务档位信息（只读显示，配置在「设置 · 服务提供方」页）
// 阶段 14 §6.3：读统一 provider store（与设置页/对话档共享一份，不再独立 getProviders）
const pstore = useProviderStore()
const tierCreative = computed(() => pstore.tiers?.creative ?? null)

// B3：规则命中统计（高频违规，供作者自查常见问题）
const ruleHits = ref<RuleHitEntry[]>([])
// M-11：规则命中代守卫（stateGen 同文件先例）——快速切书 A→B 时 A 的慢响应不覆盖 B 统计
let ruleHitsGen = 0
async function loadRuleHits(): Promise<void> {
  const gen = ++ruleHitsGen
  try {
    const data = await getTraceStats(props.bookName)
    if (gen !== ruleHitsGen) return
    ruleHits.value = data.ruleHits ?? []
  } catch {
    if (gen !== ruleHitsGen) return
    ruleHits.value = []
  }
}

const draftSaved = ref<{ path?: string; words: number } | null>(null)

const chapter = computed(() => state.value?.nextChapter ?? 1)

// RB-FE-P2-4：状态卡请求代守卫——快速切书 A→B 时 A 的慢响应不覆盖 B 状态（对齐本文件 kindReqId 风格）
let stateGen = 0
async function refreshState(): Promise<void> {
  const gen = ++stateGen
  try {
    const s = await getState(props.bookName)
    if (gen !== stateGen) return
    state.value = s
  } catch (e) {
    if (gen !== stateGen) return
    err.value = friendlyError(e)
  }
}
watch(
  () => props.bookName,
  () => {
    // RB-FE-P2-4：切书清残留——旧书的 prompt 输入与 draftSaved 提示不带进新书
    prompt.value = ''
    draftSaved.value = null
    void refreshState()
  },
  { immediate: true },
)
// Y-P2-3：切书重载规则命中（原仅 onMounted 拉一次，切书后残留旧书统计；初载仍走 onMounted）
watch(() => props.bookName, () => void loadRuleHits())
onMounted(() => {
  // 档位走统一 store（静默——档位显示不阻断主流程；设置页/ChatDock 已拉过则零请求）
  void pstore.refresh()
  void loadRuleHits()
})
// 生成结束（running false 跳变）刷新状态卡
watch(
  () => wb.running,
  (r, prev) => {
    if (prev && !r) void refreshState()
  },
)
// P1-1：全自动写章收工 → 草稿已由 self-heal 落盘，凭 healResult.docId 自动转编辑器。
// tool_use 模式下无逐字流，正文区恒空白，收工跳转是作者看到成品的唯一通道。
watch(
  () => wb.healResult,
  async (r) => {
    if (!r || (r.outcome !== 'pass' && r.outcome !== 'escalate')) return
    if (!r.docId) return
    // Z-24（第五十八轮）：书名入口捕获 + await 后守卫——tree.load 窗口内切书时，
    // A 书的 openTab/toast 不得落 B 书界面（同文件 onSpawn/onAutoWrite 同款纪律）
    const book = props.bookName
    try {
      await tree.load(book)
      if (props.bookName !== book) return
      ws.openTab(r.docId)
      ui.toast(r.outcome === 'pass' ? '已写完，已转到编辑器' : '已写完（剩红项待你定夺），已转到编辑器', 'success')
    } catch {
      /* 树刷新/打开失败不阻断（草稿已落盘，作者可从文章树手动找） */
    }
  },
)

// B-3：max_tokens 截断等非致命警告 → toast 提示
watch(
  () => wb.warning,
  (msg) => {
    if (!msg) return
    ui.toast(msg, 'error')
    wb.warning = null
  },
)

function onPromptEnter(e: KeyboardEvent): void {
  // R61-17（第六十一轮）：原 @keyup.enter 在 IME compositionend 之后触发（isComposing
  // 已 false），确认候选词的 Enter 会直接起一轮 AI 生成——改 keydown + 组合期守卫
  if (isImeComposing(e)) return
  if (!wb.running) void onSpawn()
}

async function onSpawn(): Promise<void> {
  err.value = null
  // FE-9（第七轮）：书名入口捕获（M-8 类收敛）——拉写稿上下文的 await 期间切书后，
  // 生成请求不能再发到切换后的书（A 书上下文的生成发进 B 书）
  const book = props.bookName
  try {
    // P0-3：先拉写稿上下文（细纲 + 备料 + 设定注入），再拼输入框内容——
    // 原来仅发输入框文本（常为空串 → 只有 system prompt，产出与本书无关）
    const { prompt: ctx, files } = await getDraftPrompt(book, chapter.value)
    const userText = prompt.value.trim()
    const final = userText ? `${ctx}\n\n## 作者补充要求\n${userText}` : ctx
    if (props.bookName !== book) return
    // Q-5：注入源清单随 prompt 回传——服务端登记进 llm/call promptMeta.files（可见⟺已记录）
    await spawnRole(book, { role: 'writer', prompt: final, ...(files?.length ? { files } : {}) })
    ui.toast('已开始生成', 'info')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}
async function onInterrupt(): Promise<void> {
  try {
    await interrupt(props.bookName)
    ui.toast('已中断', 'info')
  } catch (e) {
    err.value = friendlyError(e)
  }
}

// 全自动写章：AI 写稿→机检→红则自动重写→全绿或触顶交作者。进度经 SSE self_heal_* 事件回流。
// P2-3：批量连写——章数取配置 auto.batch_size（>1 时后端连写多章，进度经 self_heal_batch* 事件回流）。
async function onAutoWrite(): Promise<void> {
  err.value = null
  // FE-9（第七轮）：书名入口捕获（同 onSpawn）——getConfig await 期间切书后中止
  const book = props.bookName
  try {
    const cfg = await getConfig(book)
    // 书级未设回落全局默认（prefs.aiBatchSize 初值即硬编码回落 8；服务端合并同链）
    const batchSize = Math.max(1, Math.min(20, Math.floor(cfg.auto?.batch_size ?? prefs.aiBatchSize)))
    if (props.bookName !== book) return
    const r = await autoWrite(book, chapter.value, batchSize)
    const msg = (r.batchSize ?? 1) > 1 ? `第 ${chapter.value} 章起连写 ${r.batchSize} 章已开始` : `第 ${chapter.value} 章已开始全自动写稿`
    ui.toast(msg, 'info')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// P1-3：AI 生成本章细纲（工作区/细纲.md）——全自动写章的语境来源，原来端点完整但 UI 不可达
async function onOutline(): Promise<void> {
  err.value = null
  // R63-10（十一轮）：书名入口捕获 + await 后复检（FE-9/L-F1 惯例，兄弟函数均已有）——
  // 生成期间切书后 toast 会落到切换后的书，误导作者
  const book = props.bookName
  try {
    await generateOutline(book, chapter.value)
    if (props.bookName !== book) return
    ui.toast(`第 ${chapter.value} 章细纲已生成`, 'success')
  } catch (e) {
    if (props.bookName !== book) return
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// W-P1-3：AI 草拟本章账本推进（工作区/账本推进.md）——作者确认/修改后定稿时回写布线履历
async function onLeadUpdates(): Promise<void> {
  err.value = null
  // R63-10：书名入口捕获 + await 后复检（同 onOutline）
  const book = props.bookName
  try {
    const r = await generateLeadUpdates(book, chapter.value)
    if (props.bookName !== book) return
    ui.toast(r.count > 0 ? `已生成 ${r.count} 条账本推进，请确认` : '本章无账本推进', 'success')
  } catch (e) {
    if (props.bookName !== book) return
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// 存草稿并编辑（M3）：done 后把生成正文 textOut 存为当前章草稿 → 刷树 → 直接落进编辑器
async function onSaveDraft(): Promise<void> {
  if (!wb.textOut.trim()) {
    ui.toast('无正文可存', 'error')
    return
  }
  // F4（五十九轮）：不完整水印期间阻止直接保存残文——按钮已禁，此处兜底（键盘/后续
  // 新入口），断连窗口丢失的 text 事件无法从 textOut 重建，残文落盘会覆盖完整草稿
  if (wb.textIncomplete) {
    ui.toast('重连同步中，生成正文可能不完整，暂不能存为草稿', 'error')
    return
  }
  // L-F1（第八轮）：await 前捕获书名——存草稿在途切书后 tree.load/openTab/toast 会
  // 落到 B 书界面（legacy docId 可撞 B 书同路径），确认后守卫中止
  const book = props.bookName
  try {
    const r = await saveDraft(book, chapter.value, wb.textOut)
    // 低-2（第十轮）：draftSaved 赋值移到切书守卫之后——原先守卫前就写徽标，存草稿
    // 在途切书时 watch(bookName) 已清残留，晚到的赋值又把 A 书「已存 N 字」徽标
    // 留在 B 书工作台（L-F1 同点收尾）
    if (props.bookName !== book) return // 已切书：草稿已落 A 书盘，不再动 B 界面
    draftSaved.value = { words: wb.textOut.length }
    // 树重拉后新草稿在「写作」组；openTab 切编辑器视图 + 激活文档
    await tree.load(book)
    ws.openTab(r.docId)
    ui.toast(`第 ${chapter.value} 章草稿已存，转到编辑`, 'success')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}
</script>

<template>
  <div class="workbench">
    <!-- 对话 tab 切换（仅 chatEnabled 时显示） -->
    <div v-if="prefs.chatEnabled" class="wb-tabs">
      <button
        class="wb-tab"
        :class="{ active: activeTab === 'write' }"
        @click="activeTab = 'write'"
      >写作</button>
      <button
        class="wb-tab"
        :class="{ active: activeTab === 'chat' }"
        @click="activeTab = 'chat'"
      >对话</button>
    </div>

    <!-- 对话 tab -->
    <div v-if="prefs.chatEnabled && activeTab === 'chat'" class="wb-chat-wrap">
      <ChatPanel :book-name="bookName" :current-chapter="chapter" />
    </div>

    <!-- 写作 tab（默认） -->
    <template v-else>
    <!-- G4：AI 不可达置灰提示 -->
    <div v-if="ui.aiAvailable === false" class="ai-warn">
      AI 服务暂不可用（未配置或连接失败），请在「设置 · 服务提供方」页添加并启用提供方。
    </div>
    <!-- 任务档位（只读显示，配置在「设置 · 服务提供方」页） -->
    <section v-if="tierCreative" class="card model-bar">
      <span class="model-label">创作档</span>
      <span class="tier-model">{{ tierCreative.model || '未配置' }}</span>
      <span v-if="tierCreative.model" class="tier-meta">
        Effort {{ tierCreative.effort }}
      </span>
    </section>
    <!-- 状态卡（导航灯：当前在哪 + 该做什么 + 一键操作） -->
    <WbStateCard :state="state" @spawn="onSpawn" />

    <!-- D1（批 4）：AI 用量卡片（trace-stats byTask 渲染 + D2 金额口径） -->
    <WbUsageCard :book-name="bookName" />

    <!-- 高级（流程可见：事件流 + 规则命中） -->
    <WbAdvanced :rule-hits="ruleHits" />

    <!-- 触发生成 -->
    <section class="card">
      <div class="spawn-row">
        <input
          v-model="prompt"
          class="prompt-input"
          placeholder="写作提示（可选，留空用角色默认）"
          :disabled="wb.running"
          @keydown.enter="onPromptEnter"
        />
        <button v-if="!wb.running" class="btn primary" :disabled="ui.aiAvailable === false" @click="onSpawn">生成</button>
        <button v-else class="btn danger" @click="onInterrupt">中断</button>
        <button
          class="btn"
          :disabled="wb.running || ui.aiAvailable === false"
          title="AI 生成本章细纲（写稿前的语境准备，全自动写章可读）"
          @click="onOutline"
        >
          生成细纲
        </button>
        <button
          v-if="!wb.running"
          class="btn"
          :disabled="ui.aiAvailable === false"
          title="W-P1-3：AI 草拟本章账本推进（工作区/账本推进.md），定稿时确认回写布线履历"
          @click="onLeadUpdates"
        >
          生成账本推进
        </button>
        <button
          v-if="!wb.running"
          class="btn auto"
          :disabled="ui.aiAvailable === false"
          title="AI 写稿后自动机检，报红自动重写，全绿才交给你确认"
          @click="onAutoWrite"
        >
          <Sparkles :size="14" />
          全自动写章
        </button>
      </div>
    </section>

    <!-- 全自动写章：进度 + 终局（红项只在重试触顶后才流到作者） -->
    <WbHealCard />

    <!-- 生成正文（M4 默认主区：作者看到的是文章，不是事件日志） -->
    <WbDraftCard :draft-saved="draftSaved" @save="onSaveDraft" />

    <div v-if="err" class="err-msg">{{ err }}</div>
    </template>
  </div>
</template>

<style scoped>
.workbench {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 820px;
  margin: 0 auto;
}
.wb-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}
.wb-tab {
  padding: 4px 12px;
  font-size: var(--font-size-m);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: var(--dur-fast) var(--ease-out);
}
.wb-tab:hover {
  color: var(--text-normal);
}
.wb-tab.active {
  color: var(--text-normal);
  border-bottom-color: var(--interactive-accent);
}
.wb-chat-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.card {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
  box-shadow: var(--shadow-s);
}
.model-bar {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-2) var(--size-4-3);
}
.model-label {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  white-space: nowrap;
}
.tier-model {
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.tier-meta {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.spawn-row {
  display: flex;
  gap: var(--size-4-2);
}
.prompt-input {
  flex: 1;
  height: 32px;
  font-size: var(--font-size-m);
  padding: 0 var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
}
.prompt-input:focus {
  border-color: var(--interactive-accent);
}
.btn {
  padding: 0 16px;
  height: 32px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover {
  background: var(--interactive-accent-hover);
}
.btn.danger {
  color: var(--text-error);
  border-color: var(--text-error);
}
/* 全自动写章：与「生成」同排的次级强调（accent 描边不抢主按钮） */
.btn.auto {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--interactive-accent);
  border-color: var(--interactive-accent);
}
.btn.auto:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}
.btn.auto:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.err-msg {
  font-size: var(--font-size-s);
  color: var(--text-error);
}
.ai-warn {
  padding: 8px 12px;
  margin-bottom: var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-warning);
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
}
</style>

<script setup lang="ts">
// 工作台写作模式：状态卡（人话）+ 生成/中断 + 正文预览（默认主区）+ 存草稿并编辑。
// 事件流 / 阶段任务 / CLI 报告收「高级」折叠区（M4 去机器味：作者看文章，调试功能全保留）。
import { ref, watch, computed, onMounted } from 'vue'
import { Activity, CircleCheck, Sparkles, TriangleAlert } from 'lucide-vue-next'
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
import EmptyState from '../components/ui/EmptyState.vue'
import BetaBadge from '../components/ui/BetaBadge.vue'
import CollapseSection from '../components/ui/CollapseSection.vue'
import ChatPanel from '../components/panels/ChatPanel.vue'
import { friendlyError } from '../shared/error'

/** 规则 ID → 中文标签（与后端 RULE_LABEL 一致） */
const RULE_LABEL: Record<string, string> = {
  'ai-cliche': 'AI高频套话',
  'ai-flavor-words': 'AI味词',
  'style-consistency': '文风偏离',
  'setting-consistency': '设定偏离',
  'plot-consistency': '情节偏离',
}

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
async function loadRuleHits(): Promise<void> {
  try {
    const data = await getTraceStats(props.bookName)
    ruleHits.value = data.ruleHits ?? []
  } catch {
    ruleHits.value = []
  }
}

// 态机 action → 可执行操作（每个建议动作都有 UI 按钮）。
// CLI 确定性步骤（hand/rebook/health/review-batch/enter）随 CLI 退场：对应 action 不再有按钮，
// 状态卡只展示 humanMsg；写章统一走「自动写章」或编辑器。
const ACTION_RUNS: Record<string, { label: string; run: () => void | Promise<void> }> = {
  'write-new-chapter':      { label: '开写新章', run: onSpawn },
  'volume-review':          { label: '卷复盘', run: onSpawn },
}
const draftSaved = ref<{ path?: string; words: number } | null>(null)

const chapter = computed(() => state.value?.nextChapter ?? 1)
const draftWords = computed(() => wb.textOut.length)
// 当前建议操作（resume 续写；post-commit-residue 幂等清理无按钮，靠 humanMsg 提示）
const currentAction = computed<{ label: string; run: () => void | Promise<void> } | null>(() => {
  const a = state.value?.action
  if (!a) return null
  if (a === 'resume') {
    return { label: '续写', run: onSpawn }
  }
  // repair 无确定性操作（humanMsg 已含错误列表，作者手修格式）
  if (a === 'repair') return null
  return ACTION_RUNS[a] ?? null
})

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
    try {
      await tree.load(props.bookName)
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

async function onSpawn(): Promise<void> {
  err.value = null
  try {
    // P0-3：先拉写稿上下文（细纲 + 备料 + 设定注入），再拼输入框内容——
    // 原来仅发输入框文本（常为空串 → 只有 system prompt，产出与本书无关）
    const { prompt: ctx } = await getDraftPrompt(props.bookName, chapter.value)
    const userText = prompt.value.trim()
    const final = userText ? `${ctx}\n\n## 作者补充要求\n${userText}` : ctx
    await spawnRole(props.bookName, { role: 'writer', prompt: final })
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
  try {
    const cfg = await getConfig(props.bookName)
    // 书级未设回落全局默认（prefs.aiBatchSize 初值即硬编码回落 8；服务端合并同链）
    const batchSize = Math.max(1, Math.min(20, Math.floor(cfg.auto?.batch_size ?? prefs.aiBatchSize)))
    const r = await autoWrite(props.bookName, chapter.value, batchSize)
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
  try {
    await generateOutline(props.bookName, chapter.value)
    ui.toast(`第 ${chapter.value} 章细纲已生成`, 'success')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// W-P1-3：AI 草拟本章账本推进（工作区/账本推进.md）——作者确认/修改后定稿时回写布线履历
async function onLeadUpdates(): Promise<void> {
  err.value = null
  try {
    const r = await generateLeadUpdates(props.bookName, chapter.value)
    ui.toast(r.count > 0 ? `已生成 ${r.count} 条账本推进，请确认` : '本章无账本推进', 'success')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// 自愈进度人话（阶段 + 第 N/M 次重写 + 剩余红项数）
// P2-3：批量连写时优先展示「第 X/Y 章」总进度（chapter_start/done + batch_progress）
const healText = computed(() => {
  const p = wb.healProgress
  const bp = wb.batchProgress
  if (wb.healPhase === 'chapter_start' && bp) return `批量连写：第 ${bp.done + 1}/${bp.total} 章开始`
  if (wb.healPhase === 'chapter_done' && bp) return `批量连写：第 ${bp.done}/${bp.total} 章完成`
  if (bp && bp.stoppedAt !== null) return `批量连写停在第 ${bp.stoppedAt} 章（已完成 ${bp.done}/${bp.total}）`
  if (wb.healPhase === 'rewriting' && p) {
    return `第 ${p.attempt}/${p.maxAttempts} 次重写（剩余 ${p.remaining.length} 条待修）`
  }
  if (wb.healPhase === 'drafting') return '正在写稿…'
  if (wb.healPhase === 'checking') return '校对中…'
  if (wb.healPhase === 'rewriting') return '正在重写…'
  return ''
})
const healDone = computed(() => wb.healResult)

// 存草稿并编辑（M3）：done 后把生成正文 textOut 存为当前章草稿 → 刷树 → 直接落进编辑器
async function onSaveDraft(): Promise<void> {
  if (!wb.textOut.trim()) {
    ui.toast('无正文可存', 'error')
    return
  }
  try {
    const r = await saveDraft(props.bookName, chapter.value, wb.textOut)
    draftSaved.value = { words: wb.textOut.length }
    // 树重拉后新草稿在「写作」组；openTab 切编辑器视图 + 激活文档
    await tree.load(props.bookName)
    ws.openTab(r.docId)
    ui.toast(`第 ${chapter.value} 章草稿已存，转到编辑`, 'success')
  } catch (e) {
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  }
}

// 事件流渲染：按 type 归类显示
function evLabel(ev: { type: string; [k: string]: unknown }): string {
  switch (ev.type) {
    case 'text':
      return String(ev.text ?? '')
    case 'tool_use':
      return `调用工具 ${ev.tool}${ev.role ? `（${ev.role}）` : ''}`
    case 'role_spawn':
      return `子角色 ${ev.role} 开始工作`
    case 'usage':
      return `用量：${ev.tokens} tokens${ev.cost ? `（${ev.cost}）` : ''}`
    case 'review-progress':
      return `审稿：${ev.label}${ev.phase ? `（${ev.phase}）` : ''}`
    case 'self_heal_phase':
      return ev.phase === 'chapter_start' ? `开始写第 ${ev.chapter} 章（${ev.done}/${ev.total}）`
        : ev.phase === 'chapter_done' ? `第 ${ev.chapter} 章完成（${ev.done}/${ev.total}）`
        : `自检进入「${ev.phase}」阶段`
    case 'self_heal_batch':
      return `批量连写 ${ev.total} 章`
    case 'self_heal_batch_progress':
      return `批量连写中断：已完成 ${ev.done}/${ev.total}，停在第 ${ev.stoppedAt} 章`
    case 'self_heal_reset':
      return '重新写稿（清空上一次草稿）'
    case 'text_reset':
      return '重试写稿（清空上一次草稿）'
    case 'warning':
      return `提示：${ev.message}`
    case 'self_heal_progress':
      return `第 ${ev.attempt}/${ev.maxAttempts} 次重写，剩余 ${(ev.remaining as string[] | undefined)?.length ?? 0} 条待修`
    case 'self_heal_result': {
      const m: Record<string, string> = { pass: '通过', escalate: '需人工确认', aborted: '已中断' }
      return `自检结果：${m[ev.outcome as string] ?? ev.outcome}`
    }
    case 'done':
      return '完成'
    case 'error':
      return `错误：${ev.message}`
    case 'interrupted':
      return `已中断${ev.reason ? `（${ev.reason}）` : ''}`
    case 'init':
      return '准备就绪'
    default:
      return ev.type
  }
}
function evKind(ev: { type: string }): 'text' | 'meta' | 'done' | 'error' {
  if (ev.type === 'text') return 'text'
  if (ev.type === 'error' || ev.type === 'interrupted') return 'error'
  if (ev.type === 'done') return 'done'
  return 'meta'
}
const recent = computed(() => wb.log.slice(-200))
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
    <section class="card">
      <div class="card-head">
        <span class="state-tag">{{ state?.stateName ?? '未知' }}</span>
        <span class="conn" :class="{ on: wb.connected }">
          {{ wb.connected ? '已连接' : '连接中' }}
        </span>
      </div>
      <p class="human-msg">{{ state?.humanMsg ?? '读取状态中…' }}</p>
      <div v-if="currentAction" class="action-row">
        <span class="action-hint">建议下一步</span>
        <button
          class="btn mini primary"
          :disabled="wb.running"
          @click="currentAction.run"
        >{{ currentAction.label }}</button>
      </div>
    </section>

    <!-- 高级（流程可见：事件流 + 规则命中） -->
    <section class="card">
      <CollapseSection title="高级" :default-open="false">
        <div class="adv-block">
          <div class="adv-head"><span>事件流</span><span class="muted">{{ wb.log.length }} 条</span></div>
          <div class="stream">
            <EmptyState v-if="!recent.length" :icon="Activity" text="无事件，点「生成」开始" size="compact" />
            <div
              v-for="(ev, i) in recent"
              :key="i"
              class="ev"
              :class="evKind(ev)"
            >
              <span class="ev-ts">{{ ev._ts }}</span>
              <span class="ev-text">{{ evLabel(ev) }}</span>
            </div>
          </div>
        </div>
        <div class="adv-block">
          <div class="adv-head"><span>规则命中</span><span class="muted">{{ ruleHits.length }} 条</span></div>
          <div v-if="!ruleHits.length" class="muted">暂无规则命中（自动写章重写时统计）</div>
          <div v-for="h in ruleHits" :key="h.ruleId" class="hit">
            <div class="hit-head">
              <span class="hit-id">{{ RULE_LABEL[h.ruleId] ?? h.ruleId }}</span>
              <span class="hit-count">{{ h.hits }} 次</span>
            </div>
            <div v-if="h.recentMessages[0]" class="hit-msg">{{ h.recentMessages[0] }}</div>
          </div>
        </div>
      </CollapseSection>
    </section>

    <!-- 触发生成 -->
    <section class="card">
      <div class="spawn-row">
        <input
          v-model="prompt"
          class="prompt-input"
          placeholder="写作提示（可选，留空用角色默认）"
          :disabled="wb.running"
          @keyup.enter="!wb.running && onSpawn()"
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
    <section v-if="healText || healDone" class="card heal-card">
      <div v-if="healText" class="heal-row running">
        <span class="heal-dot" />
        <span>{{ healText }}</span>
      </div>
      <template v-if="healDone">
        <!-- W1 终局黄项复查：yellows 空 = 文风已收敛；非空 = 仍剩黄项（建议手改，不 gate） -->
        <div v-if="healDone.outcome === 'pass'" class="heal-row ok">
          <CircleCheck :size="16" />
          <div class="heal-detail">
            <div>{{ healDone.yellows?.length ? `校对通过，仍剩 ${healDone.yellows.length} 处黄项（建议手改）` : '校对通过，文风已收敛' }}</div>
            <ul v-if="healDone.yellows?.length" class="heal-reds">
              <li v-for="(y, i) in healDone.yellows" :key="i">{{ y }}</li>
            </ul>
          </div>
        </div>
        <div v-else-if="healDone.outcome === 'escalate'" class="heal-row warn">
          <TriangleAlert :size="16" />
          <div class="heal-detail">
            <div>AI 已重试到上限仍有待修问题，需要你来定夺</div>
            <ul class="heal-reds">
              <li v-for="(r, i) in healDone.reds ?? []" :key="i">{{ r }}</li>
            </ul>
          </div>
        </div>
        <div v-else-if="healDone.outcome === 'aborted'" class="heal-row">
          <span>已中断，草稿保留最后一次产出</span>
        </div>
        <div v-else class="heal-row warn">
          <TriangleAlert :size="16" />
          <span>{{ healDone.error ?? '写稿失败' }}</span>
        </div>
      </template>
    </section>

    <!-- 生成正文（M4 默认主区：作者看到的是文章，不是事件日志） -->
    <section class="card draft-card">
      <div class="card-head">
        <span>生成正文 <BetaBadge /></span>
        <span class="muted">{{ draftWords }} 字</span>
      </div>
      <pre class="draft-preview">{{ wb.textOut || '（无正文，点「生成」开始）' }}</pre>
      <div class="draft-actions">
        <button class="btn primary" :disabled="!wb.textOut.trim()" @click="onSaveDraft">
          存草稿并编辑
        </button>
        <span v-if="draftSaved" class="muted"><CircleCheck :size="12" /> {{ draftSaved.words }} 字已存</span>
      </div>
    </section>

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
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.state-tag {
  color: var(--text-accent);
}
.conn {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.conn.on {
  color: var(--dv-good);
}
.human-msg {
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.7;
  white-space: pre-wrap;
}
.action-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
}
.action-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.btn.mini {
  height: 28px;
  padding: 0 12px;
  font-size: var(--font-size-s);
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
.model-select {
  flex: 1;
  height: 30px;
  font-size: var(--font-size-s);
  padding: 0 var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
  font-family: var(--font-monospace);
}
.model-select:focus {
  border-color: var(--interactive-accent);
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
.heal-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.heal-row {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.heal-row.ok {
  color: var(--text-accent);
}
.heal-row.warn {
  color: var(--text-error);
}
.heal-row.running {
  color: var(--text-muted);
}
.heal-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--interactive-accent);
  animation: heal-pulse 1.4s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes heal-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.heal-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.heal-reds {
  margin: 0;
  padding-left: 18px;
  color: var(--text-muted);
}
.heal-reds li {
  margin: 2px 0;
}
.muted {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
}
.adv-block {
  margin-bottom: var(--size-4-3);
}
.adv-block:last-child {
  margin-bottom: 0;
}
.adv-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-2);
}
.stream {
  max-height: 240px;
  overflow: auto;
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
}
.ev {
  padding: 2px 0;
  color: var(--text-muted);
  line-height: 1.6;
}
.ev.text {
  color: var(--text-normal);
  white-space: pre-wrap;
}
.ev.done {
  color: var(--dv-good);
}
.ev.error {
  color: var(--text-error);
}
.ev-ts {
  color: var(--text-faint);
  margin-right: var(--size-4-2);
}
.ev-text {
  word-break: break-all;
}
.hit {
  padding: 6px 0;
  border-top: 1px solid var(--background-modifier-border);
  font-size: var(--font-size-s);
}
.hit:first-of-type {
  border-top: none;
}
.hit-head {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
}
.hit-id {
  font-weight: 600;
  color: var(--text-normal);
}
.hit-count {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.hit-msg {
  margin-top: 2px;
  color: var(--text-muted);
  line-height: 1.5;
  word-break: break-all;
}
.err-msg {
  font-size: var(--font-size-s);
  color: var(--text-error);
}
.draft-card {
  flex: 1;
  min-height: 240px;
  display: flex;
  flex-direction: column;
}
.draft-preview {
  flex: 1;
  min-height: 120px;
  margin: var(--size-4-2) 0;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  overflow: auto;
}
.draft-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
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

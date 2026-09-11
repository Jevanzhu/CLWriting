<script setup lang="ts">
// 工作台状态卡（巨石批 7a 拆分）：导航灯——当前在哪（stateName）+ 该做什么（humanMsg +
// kk-P1-4 连写暂停提示）+ 一键操作（建议动作按钮）。动作执行（写稿上下文拼装）在父层。
import { computed } from 'vue'
import { useWorkbenchStore } from '../../stores/workbench'
import type { BookState } from '../../api/stream'

const props = defineProps<{ state: BookState | null }>()
// R0912-FE-P2-3（2026-09-11 重评-0911b 修复批）：崩溃 pending「忽略此提醒」按钮上抛
// ——确认调用（acknowledgeJournalPending）与刷新状态归父层（书名捕获/切书守卫/刷新
// 编排都在 WorkbenchView，卡片保持纯展示 + 事件出口的既有分工）。
const emit = defineEmits<{ spawn: []; acknowledge: [] }>()
const wb = useWorkbenchStore()

// 态机 action → 可执行操作（每个建议动作都有 UI 按钮）。
// CLI 确定性步骤（hand/rebook/health/review-batch/enter）随 CLI 退场：对应 action 不再有按钮，
// 状态卡只展示 humanMsg；写章统一走「自动写章」或编辑器。
// 卡内动作（开写新章 / 续写）全部归结为父层 onSpawn 一个出口。
// R0912-FE-P2-2：state 5 的 action='volume-review' 原样映射「卷复盘」按钮——点下去
// 实际走 writer 链写下一章（emit spawn），按钮叫「卷复盘」是语义错位。产品语义待拍板
// 不动（仍 emit spawn），文案对齐实际行为：改「继续写作（下一章）」+ title 注明规划中。
interface ActionDef {
  label: string
  /** 悬停说明（语义对齐注记；无则不渲染 title）。 */
  title?: string
}
const ACTION_RUNS: Record<string, ActionDef> = {
  'write-new-chapter': { label: '开写新章' },
  'volume-review': { label: '继续写作（下一章）', title: '卷复盘功能规划中，当前直接开写下一章' },
}
// kk-P1-4：连写暂停提示（M6 #34）——上次批量连写中途停且未再开批时，状态卡提示从哪章续起
const REASON_LABELS: Record<string, string> = {
  escalate: 'AI 卡住上交裁决',
  failed: '写稿失败',
  aborted: '手动中止',
}
const batchPauseMsg = computed<string | null>(() => {
  const p = props.state?.batchPause
  if (!p) return null
  const why = REASON_LABELS[p.reason] ?? p.reason
  return `上次批量连写在第 ${p.atChapter} 章暂停（${why}），可从该章续写。${p.detail ? `详情：${p.detail}` : ''}`
})
// 当前建议操作（resume 续写；post-commit-residue 幂等清理无按钮，靠 humanMsg 提示）
const currentAction = computed<ActionDef | null>(() => {
  const a = props.state?.action
  if (!a) return null
  if (a === 'resume') {
    return { label: '续写' }
  }
  // repair 无确定性操作（humanMsg 已含错误列表，作者手修格式）
  if (a === 'repair') return null
  return ACTION_RUNS[a] ?? null
})
// R0912-FE-P2-2：humanMsg 呈现侧兜底对齐——服务端态 5 humanMsg 仍写「建议做卷复盘」
// （不属前端清单），卡片下方补一行次级说明，避免 humanMsg 与按钮文案自相矛盾。
const volumeReviewHint = computed(() =>
  props.state?.action === 'volume-review' ? '卷复盘功能规划中——当前按钮直接开写下一章。' : null,
)
// R0912-FE-P2-3：态 1 崩溃 pending（crashedWrite）的「忽略此提醒」按钮渲染条件。
// 服务端 /state 现未透出逐条 opId（R0912-1b 服务端批只落了端点，payload 透出待后续批
// 对齐 BookState.crashedPendingOpIds 契约），字段缺省/空时按钮不渲染、接线不报错。
// 常态单条 pending 恰即「每条提醒一个按钮」；多条时一次全部确认——端点幂等（重复
// 调用 acknowledged:false），且报红逐条罗列时作者点「忽略」的意图即不再提醒。
const crashedPendingOpIds = computed<string[]>(() =>
  props.state?.state === 1 ? (props.state.crashedPendingOpIds ?? []) : [],
)
</script>

<template>
  <section class="card">
    <div class="card-head">
      <span class="state-tag">{{ state?.stateName ?? '未知' }}</span>
      <span class="conn" :class="{ on: wb.connected }">
        {{ wb.connected ? '已连接' : '连接中' }}
      </span>
    </div>
    <p class="human-msg">{{ state?.humanMsg ?? '读取状态中…' }}</p>
    <p v-if="batchPauseMsg" class="pause-msg">{{ batchPauseMsg }}</p>
    <!-- R0912-FE-P2-3：崩溃 pending 人工确认（本动作不删数据，直接调用 + toast 口径） -->
    <div v-if="crashedPendingOpIds.length > 0" class="ack-row">
      <button class="btn mini" data-testid="ack-crashed" @click="emit('acknowledge')">忽略此提醒</button>
      <span class="ack-hint">确认接受该次未完成保存的现状后，进门体检不再重复提醒</span>
    </div>
    <p v-if="volumeReviewHint" class="pause-msg">{{ volumeReviewHint }}</p>
    <div v-if="currentAction" class="action-row">
      <span class="action-hint">建议下一步</span>
      <button
        class="btn mini primary"
        :disabled="wb.running"
        :title="currentAction.title"
        @click="emit('spawn')"
      >{{ currentAction.label }}</button>
    </div>
  </section>
</template>

<style scoped>
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
/* kk-P1-4：连写暂停提示——弱于 humanMsg 的次级信息行 */
.pause-msg {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  line-height: 1.6;
  /* R33-80（三十三轮）：--border-color 全库无定义（computed-value 无效回落 none），
     连写暂停提示的左强调条此前静默消失；改用实际存在的边框 token */
  border-left: 2px solid var(--background-modifier-border);
  padding-left: 8px;
}
/* R0912-FE-P2-3：崩溃 pending 忽略行（小按钮 + 次级说明） */
.ack-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
  flex-wrap: wrap;
}
.ack-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  line-height: 1.6;
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
.btn.mini {
  height: 28px;
  padding: 0 12px;
  font-size: var(--font-size-s);
}
</style>

<script setup lang="ts">
// 工作台状态卡（巨石批 7a 拆分）：导航灯——当前在哪（stateName）+ 该做什么（humanMsg +
// kk-P1-4 连写暂停提示）+ 一键操作（建议动作按钮）。动作执行（写稿上下文拼装）在父层。
import { computed } from 'vue'
import { useWorkbenchStore } from '../../stores/workbench'
import type { BookState } from '../../api/stream'

const props = defineProps<{ state: BookState | null }>()
const emit = defineEmits<{ spawn: [] }>()
const wb = useWorkbenchStore()

// 态机 action → 可执行操作（每个建议动作都有 UI 按钮）。
// CLI 确定性步骤（hand/rebook/health/review-batch/enter）随 CLI 退场：对应 action 不再有按钮，
// 状态卡只展示 humanMsg；写章统一走「自动写章」或编辑器。
// 卡内动作（开写新章 / 卷复盘 / 续写）全部归结为父层 onSpawn 一个出口。
const ACTION_RUNS: Record<string, { label: string }> = {
  'write-new-chapter': { label: '开写新章' },
  'volume-review':     { label: '卷复盘' },
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
const currentAction = computed<{ label: string } | null>(() => {
  const a = props.state?.action
  if (!a) return null
  if (a === 'resume') {
    return { label: '续写' }
  }
  // repair 无确定性操作（humanMsg 已含错误列表，作者手修格式）
  if (a === 'repair') return null
  return ACTION_RUNS[a] ?? null
})
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
    <div v-if="currentAction" class="action-row">
      <span class="action-hint">建议下一步</span>
      <button
        class="btn mini primary"
        :disabled="wb.running"
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

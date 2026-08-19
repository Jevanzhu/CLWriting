<script setup lang="ts">
/**
 * 审计 · 当前状态面板（F5 goal/todo 重放快照；hh §八-16 自 AuditView.vue 拆出，纯搬家）。
 * 工作流链路 tab 顶部：当前目标（goal 状态机）+ 任务清单（todo 整表快照）。
 */
import type { GoalFE, TodoFE } from '../../api/audit'

defineProps<{
  goals: GoalFE[]
  todos: TodoFE[]
}>()

/** F5：goal 状态 → 中文标签 */
function goalStateLabel(s: string): string {
  return s === 'active' ? '进行中' : s === 'paused' ? '已暂停' : s === 'blocked' ? '被阻断' : s === 'complete' ? '已完成' : s
}
</script>

<template>
  <section v-if="goals.length > 0 || todos.length > 0" class="sec">
    <h2 class="sec-title">当前状态（goal / todo）</h2>
    <div class="goal-list">
      <div v-for="g in goals" :key="g.id" class="goal-row">
        <span class="goal-state" :data-state="g.state">{{ goalStateLabel(g.state) }}</span>
        <span class="goal-title">{{ g.title }}</span>
        <span class="goal-meta">
          轮次 {{ g.roundsStarted }}{{ g.maxGoalRounds !== undefined ? '/' + g.maxGoalRounds : '' }}
          <template v-if="g.blockedReason"> · {{ g.blockedReason }}</template>
        </span>
      </div>
    </div>
    <div v-if="todos.length > 0" class="todo-list">
      <span v-for="(t, i) in todos" :key="i" class="todo-item" :data-state="t.state">
        {{ t.state === 'completed' ? '✓' : t.state === 'in_progress' ? '◐' : '○' }} {{ t.text }}
      </span>
    </div>
  </section>
</template>

<style scoped>
/* 区段基础（与 AuditView 同式） */
.sec { margin-bottom: var(--size-4-5); }
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  font-size: 1rem;
  margin: 0 0 var(--size-4-3);
  flex-wrap: wrap;
}

/* F5：当前 goal/todo 面板 */
.goal-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--size-4-3);
}
.goal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  font-size: 0.82rem;
  flex-wrap: wrap;
}
.goal-state {
  font-size: 0.72rem;
  padding: 1px 8px;
  border-radius: 9px;
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  white-space: nowrap;
}
.goal-state[data-state='active'] { color: var(--text-accent); border-color: var(--text-accent); }
.goal-state[data-state='blocked'] { color: var(--text-error); border-color: var(--text-error); }
.goal-state[data-state='complete'] { color: var(--dv-good); border-color: var(--dv-good); }
.goal-title { font-weight: 600; }
.goal-meta { color: var(--text-muted); font-size: 0.75rem; }
.todo-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.todo-item {
  font-size: 0.78rem;
  padding: 3px 10px;
  border-radius: 7px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
}
.todo-item[data-state='completed'] { color: var(--text-muted); }
.todo-item[data-state='in_progress'] { border-color: var(--text-accent); }
</style>

<script setup lang="ts">
// 工作台「高级」折叠区（巨石批 7a 拆分）：事件流（SSE 事件按 type 归类渲染）+ 规则命中统计。
// 事件流读 workbench store；规则命中由父层拉取后经 props 传入（切 tab 重挂不重拉，行为与拆分前一致）。
import { computed } from 'vue'
import { Activity } from 'lucide-vue-next'
import { useWorkbenchStore } from '../../stores/workbench'
import type { RuleHitEntry } from '../../api/trace-stats'
import EmptyState from '../ui/EmptyState.vue'
import CollapseSection from '../ui/CollapseSection.vue'

/** 规则 ID → 中文标签（与后端 RULE_LABEL 一致） */
const RULE_LABEL: Record<string, string> = {
  'ai-cliche': 'AI高频套话',
  'ai-flavor-words': 'AI味词',
  'style-consistency': '文风偏离',
  'setting-consistency': '设定偏离',
  'plot-consistency': '情节偏离',
}

defineProps<{ ruleHits: RuleHitEntry[] }>() // R37-30（三十七轮批E）：props 绑定零消费改裸调用
const wb = useWorkbenchStore()

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
  <section class="card">
    <CollapseSection title="高级" :default-open="false">
      <div class="adv-block">
        <div class="adv-head"><span>事件流</span><span class="muted">{{ wb.log.length }} 条</span></div>
        <div class="stream">
          <EmptyState v-if="!recent.length" :icon="Activity" text="无事件，点「生成」开始" size="compact" />
          <div
            v-for="ev in recent"
            :key="ev._seq"
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
</template>

<style scoped>
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
.muted {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
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
</style>

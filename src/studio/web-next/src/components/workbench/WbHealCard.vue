<script setup lang="ts">
// 工作台全自动写章卡（巨石批 7a 拆分）：进度人话（阶段 + 第 N/M 次重写 + 批量连写总进度）
// + 终局四态（pass / escalate / aborted / 失败）。全部状态读 workbench store，无本地态。
import { computed } from 'vue'
import { CircleCheck, TriangleAlert } from 'lucide-vue-next'
import { useWorkbenchStore } from '../../stores/workbench'

const wb = useWorkbenchStore()

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
</script>

<template>
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
</template>

<style scoped>
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
  /* N-14（第十二轮）：局部 heal-pulse 收编全局家族 clw-pulse（reduced-motion 由
     base.css 全局兜底统一裁剪，不另设局部覆盖） */
  animation: clw-pulse 1.4s ease-in-out infinite;
  flex-shrink: 0;
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
</style>

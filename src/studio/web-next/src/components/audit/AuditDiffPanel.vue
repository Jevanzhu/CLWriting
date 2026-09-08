<script setup lang="ts">
/**
 * 审计 · 遮蔽差异面板（hh §八-16 自 AuditView.vue 拆出，纯搬家）。
 * 「模型可见 vs 人类可见（含遮蔽）」对照——F1-P5 审计核心：展示遮蔽口径的差异面。
 */
import { ref, computed } from 'vue'
import { Eye, EyeOff, User, Bot } from 'lucide-vue-next'
import type { AuditConversationFE, AuditNodeFE } from '../../api/audit'

const props = defineProps<{
  conversation: AuditConversationFE | null
}>()

/** 差异视图模式：'model' | 'human' */
const diffMode = ref<'model' | 'human'>('model')

/** 差异节点角色图标 */
function roleIcon(n: AuditNodeFE): string {
  return n.role === 'user' ? 'user' : 'assistant'
}

/** 差异列表：当前模式下的节点（model = 未遮蔽；human = 全量） */
const diffNodes = computed<AuditNodeFE[]>(() => {
  const c = props.conversation
  if (!c) return []
  return diffMode.value === 'model' ? c.modelVisible : c.humanVisible
})

// 重评-P3-16（2026-09-09 全量代码重评）：节点列表渲染无上限——长会话全量挂 DOM。
// 对齐 CommandPalette RENDER_CAP=100 域内惯例：数据面不动，只裁渲染面前 100 条 +
// 尾部省略提示行（与 RewritePanel 同批同口径）。
const RENDER_CAP = 100
const shownNodes = computed(() => diffNodes.value.slice(0, RENDER_CAP))
const omittedNodes = computed(() => Math.max(0, diffNodes.value.length - RENDER_CAP))
</script>

<template>
  <section class="sec">
    <h2 class="sec-title">
      遮蔽差异
      <span class="audit-seg">
        <button :class="{ on: diffMode === 'model' }" @click="diffMode = 'model'">
          <Eye :size="13" /> 模型可见
        </button>
        <button :class="{ on: diffMode === 'human' }" @click="diffMode = 'human'">
          <EyeOff :size="13" /> 人类可见（含遮蔽）
        </button>
      </span>
    </h2>
    <div class="diff-list">
      <div
        v-for="n in shownNodes"
        :key="n.seq"
        class="diff-row"
        :class="{ shadowed: n.shadowed }"
      >
        <span class="seq">#{{ n.seq }}</span>
        <span class="role" :class="n.role">
          <User v-if="roleIcon(n) === 'user'" :size="12" />
          <Bot v-else :size="12" />
          {{ n.role }}
        </span>
        <span class="kind">{{ n.kind }}</span>
        <span class="preview">{{ n.preview || '（空）' }}</span>
        <span v-if="n.shadowed" class="shadowed-mark"><EyeOff :size="12" /> 被遮蔽</span>
      </div>
      <div v-if="omittedNodes > 0" class="cap-hint">已省略 {{ omittedNodes }} 条</div>
      <div v-if="diffNodes.length === 0" class="empty">无可视消息</div>
    </div>
  </section>
</template>

<style scoped>
/* R48-89（四十八轮）：字号随母视图 R42-27 迁 token（--font-size-*，映射见 AuditView 注）——拆分子组件时未随迁的硬编码 rem 不再跟随全局字号档。 */
/* 区段基础（与 AuditView 同式） */
.sec { margin-bottom: var(--size-4-5); }
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  font-size: var(--font-size-m);
  margin: 0 0 var(--size-4-3);
  flex-wrap: wrap;
}
.empty { color: var(--text-muted); font-size: var(--font-size-s); padding: 8px; }
/* P3-16：渲染上限省略提示行（对齐 CommandPalette pg-more 口径） */
.cap-hint { color: var(--text-faint); font-size: var(--font-size-xs); padding: 2px 8px; font-style: italic; }

/* 与 settings-shared 全局 .seg 药丸同名异形，改名隔离防全局规则渗入 */
.audit-seg {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.audit-seg button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-size-xs);
}
.audit-seg button.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: transparent;
}

.diff-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.diff-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  font-size: var(--font-size-s);
}
.diff-row.shadowed {
  opacity: 0.55;
  background: var(--background-primary);
}
.seq {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 2.4em;
}
.role {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  text-transform: capitalize;
  font-size: var(--font-size-xs);
}
.kind { color: var(--text-muted); font-size: var(--font-size-xs); }
.preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shadowed-mark {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-error);
  font-size: var(--font-size-xs);
}
</style>

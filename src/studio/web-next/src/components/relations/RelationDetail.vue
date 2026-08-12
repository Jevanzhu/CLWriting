<script setup lang="ts">
// 关系图右侧详情卡（RelationsView 拆分 P2-5）：跟随选中节点展示身份/目标/关系列表，
// 支持点击关系项跳转选中 + 打开角色卡。状态来自 useRelationGraph provide 注入。
import { ArrowUpRight, Users } from 'lucide-vue-next'
import { useRelationGraphInjected } from '../../composables/useRelationGraph'

const g = useRelationGraphInjected()
</script>

<template>
  <aside class="rel-detail">
    <template v-if="g.selectedNode.value">
      <div class="dc-head">
        <h3 class="dc-name">{{ g.selectedNode.value.id }}</h3>
        <span class="dc-degree">{{ g.selectedRelations.value.length }} 条关联</span>
      </div>
      <template v-if="g.selectedCard.value">
        <div class="dc-tags">
          <span v-if="g.selectedCard.value.境界" class="dc-tag"><span class="dc-tag-k">境界</span>{{ g.selectedCard.value.境界 }}</span>
          <span v-if="g.selectedCard.value.身份" class="dc-tag"><span class="dc-tag-k">身份</span>{{ g.selectedCard.value.身份 }}</span>
        </div>
        <p v-if="g.selectedCard.value.目标" class="dc-goal">{{ g.selectedCard.value.目标 }}</p>
      </template>
      <div v-else class="dc-nocard">该角色仅被提及，暂无角色卡。</div>

      <div v-if="g.selectedRelations.value.length" class="dc-sec">
        <h4 class="dc-sec-h">关系</h4>
        <ul class="dc-rel">
          <li
            v-for="(r, i) in g.selectedRelations.value" :key="i"
            :class="{ debt: r.kind === 'debt' }"
            @click="g.selectNode(r.other)"
          >
            <div class="dc-rel-row">
              <span class="dc-rel-name">{{ r.other }}</span>
              <span class="dc-rel-type" :style="{ color: g.relColor(r) }">{{ r.type }}</span>
            </div>
            <span v-if="r.note" class="dc-rel-note">{{ r.note }}</span>
          </li>
        </ul>
      </div>

      <button v-if="g.selectedNode.value.hasCard && g.selectedNode.value.file" class="dc-open" @click="g.openCharacter(g.selectedNode.value)">
        打开角色卡 <ArrowUpRight :size="13" />
      </button>
    </template>
    <div v-else class="dc-empty">
      <Users :size="28" />
      <p>点选角色节点查看详情</p>
    </div>
  </aside>
</template>

<style scoped>
/* ── 右侧详情卡 ── */
.rel-detail {
  position: sticky;
  top: var(--size-4-5);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  box-shadow: var(--shadow-s);
}
.dc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  padding: var(--size-4-10) 0;
  color: var(--text-faint);
}
.dc-empty p {
  margin: 0;
  font-size: var(--font-size-s);
}
.dc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--size-4-3);
}
.dc-name {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--text-normal);
}
.dc-degree {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
}
.dc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-3);
}
.dc-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  color: var(--text-normal);
}
.dc-tag-k {
  color: var(--text-faint);
}
.dc-goal {
  margin: 0 0 var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.6;
  color: var(--text-muted);
}
.dc-nocard {
  padding: var(--size-4-2) 0 var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.dc-sec {
  margin-top: var(--size-4-3);
  padding-top: var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
}
.dc-sec-h {
  margin: 0 0 var(--size-4-2);
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.dc-rel {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dc-rel li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.dc-rel-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dc-rel-note {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  line-height: 1.4;
}
.dc-rel li:hover {
  background: var(--background-modifier-hover);
}
.dc-rel li.debt .dc-rel-name::before {
  content: '◈ ';
  color: var(--cat-1);
}
.dc-rel-name {
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
}
.dc-rel-type {
  font-size: var(--font-size-xs);
}
.dc-open {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  margin-top: var(--size-4-4);
  padding: 8px;
  border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  color: var(--text-accent);
  font-size: var(--font-size-s);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.dc-open:hover {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
</style>

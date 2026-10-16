<script setup lang="ts">
// 角色关系图（RelationsView 拆分编排壳）：顶栏工具 + 图/详情双栏布局。
// 图状态与交互逻辑在 useRelationGraph composable（三组 provide 注入），
// 渲染拆到 RelationGraph / RelationDetail 两个子组件——本文件只留编排。
// 解构的是 handle 外层（普通对象，三组引用恒定）：组内字段不可解构，会脱离响应性。
import { Search, Crosshair, Sparkles } from 'lucide-vue-next'
import RelationGraph from '../components/relations/RelationGraph.vue'
import RelationDetail from '../components/relations/RelationDetail.vue'
import BetaBadge from '../components/ui/BetaBadge.vue'
import { useRelationGraph } from '../composables/useRelationGraph'

const props = defineProps<{ bookName: string }>()
const { state, render, ops } = useRelationGraph(props.bookName)
</script>

<template>
  <div class="rel-scroll">
    <div v-if="state.loading" class="state-block">载入关系图…</div>
    <div v-else-if="state.err" class="state-block err">
      关系图载入失败：{{ state.err }}
      <button class="btn" @click="ops.load">重试</button>
    </div>
    <div v-else-if="!render.nodeCount" class="state-block">无角色数据。先在「设定 / 角色」建角色卡。</div>
    <div v-else class="rel">
      <!-- 顶部工具栏 -->
      <header class="rel-bar">
        <div class="rel-bar-left">
          <h2 class="rel-title">关系网络 <BetaBadge /></h2>
          <span class="rel-count">
            <span class="kc">{{ state.visibleNodes.length }}</span
            ><template v-if="state.hiddenCount > 0 || state.capHidden > 0">/{{ render.nodeCount }}</template> 角色
            <span class="sep">·</span>
            <span class="kc">{{ render.edgeCount }}</span> 关系
            <template v-if="render.debtCount"
              ><span class="sep">·</span><span class="kc">{{ render.debtCount }}</span> 债务</template
            >
            <button v-if="state.hiddenCount > 0" class="show-all-btn" @click="state.showOrphans = !state.showOrphans">
              {{ state.showOrphans ? '收起' : `+${state.hiddenCount}无关系` }}
            </button>
            <!-- RENDER_CAP 截断口径：帽值单源 shared/render-cap，取义与出路见 useRelationGraph.cappedNodes -->
            <span v-if="state.capHidden > 0" class="cap-hint">
              画面已省略 {{ state.capHidden }} 个节点（按关系数保留，可搜索定位）
            </span>
          </span>
        </div>
        <div class="rel-bar-right">
          <div class="search-box">
            <Search :size="13" />
            <input v-model="state.searchQuery" placeholder="搜索角色" />
          </div>
          <button class="tool-btn" data-tip="重置视图" @click="ops.resetView">
            <Crosshair :size="14" /><span>复位</span>
          </button>
          <button class="tool-btn mine" :disabled="ops.mining" @click="ops.onMine">
            <Sparkles :size="14" /><span>{{ ops.mining ? '梳理中…' : 'AI 梳理' }}</span>
          </button>
        </div>
      </header>

      <!-- 主体：主图 7 : 详情 3 -->
      <div class="rel-body">
        <RelationGraph />
        <RelationDetail />
      </div>
    </div>
  </div>
</template>

<style scoped>
.rel-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-5) var(--size-4-6);
}
.rel {
  max-width: 1120px;
  margin: 0 auto;
}

/* ── 顶栏 ── */
.rel-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--size-4-3);
  flex-wrap: wrap;
  margin-bottom: var(--size-4-4);
}
.rel-bar-left {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.rel-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--text-normal);
}
.rel-count {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.rel-count .kc {
  font-weight: 600;
  color: var(--text-normal);
}
.rel-count .sep {
  margin: 0 4px;
  color: var(--text-faint);
}
/* 渲染上限省略提示（纯展示不可点；弱化色与 TrashPanel/ForeshadowPanel cap-hint 同式） */
.cap-hint {
  margin-left: var(--size-4-2);
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-style: italic;
  cursor: default;
}
.show-all-btn {
  margin-left: var(--size-4-2);
  padding: 1px 7px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: var(--font-size-xxs);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.show-all-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.rel-bar-right {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--interactive-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  color: var(--text-faint);
}
.search-box input {
  border: none;
  background: none;
  outline: none;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  width: 96px;
}
.search-box input::placeholder {
  color: var(--text-faint);
}
.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.tool-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--background-modifier-border-hover);
}
/* AI 梳理按钮：强调色，区别于普通工具按钮 */
.tool-btn.mine {
  color: var(--text-accent);
}
.tool-btn.mine:hover {
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  border-color: var(--interactive-accent);
  color: var(--text-accent);
}
.tool-btn.mine:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── 主体双栏 ── */
.rel-body {
  display: grid;
  grid-template-columns: 7fr 3fr;
  gap: var(--size-4-4);
  align-items: start;
}

/* ── 状态块 ── */
.state-block {
  padding: var(--size-4-10);
  text-align: center;
  color: var(--text-faint);
  font-size: var(--font-size-m);
}
.state-block.err {
  color: var(--text-error);
}
/* border/color/cursor 基三条已收 btn-shared.css（本块留差异声明） */
.btn {
  margin-left: var(--size-4-2);
  padding: 4px 12px;
  font-size: var(--font-size-s);
  border-radius: var(--radius-s);
  background: var(--background-primary);
}
</style>

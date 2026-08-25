<script setup lang="ts">
// 命令面板（细案 T2.4）：⌘P 弹出。跳章（当前树叶子）+ 动作（主题/栏/专注/设置/书架）。
// 模糊搜索 + ↑↓ 选 / 回车执行 / Esc 关。
import { ref, computed, watch, nextTick } from 'vue'
import { CornerDownLeft } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useAppActions } from '../../composables/useAppActions'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { isImeComposing } from '../../shared/ime'
import type { TreeNode } from '../../types/tree'

const ui = useUiStore()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const { actions: appActions } = useAppActions()
const paletteRef = ref<HTMLElement | null>(null)
useFocusTrap(paletteRef)

interface Cmd {
  id: string
  label: string
  no?: string
  group: 'chapter' | 'action'
  run: () => void
}
const cmds = computed<Cmd[]>(() => {
  const list: Cmd[] = []
  for (const [, node] of tree.byDocId) {
    if (!node.isDirectory) {
      // 章节 name 形如「0001-北境之雪」→ 拆编号（弱化）+ 标题（为主）
      const m = node.name.match(/^(\d+)-(.+)/)
      list.push({
        id: 'doc:' + node.docId,
        no: m ? m[1] : undefined,
        label: m ? (m[2] ?? node.name) : node.name,
        group: 'chapter',
        run: () => openDoc(node),
      })
    }
  }
  // 应用动作复用 useAppActions 单源（与系统菜单同源）
  for (const a of appActions) {
    list.push({ id: 'act:' + a.id, label: a.label, group: 'action', run: a.run })
  }
  return list
})

const q = ref('')
const sel = ref(0)
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return k ? cmds.value.filter((c) => c.label.toLowerCase().includes(k)) : cmds.value
})
// 内存核查（2026-08-25 M-P3-13）：渲染上限——空查询时全书每章一条全量渲染为 DOM
// （千章级千行节点，原仅靠 max-height 视觉滚动裁剪不减节点）；cmds 数据生成不动，
// 只裁每节渲染条数（≤100）+ 尾部省略提示行。有查询词（过滤）时同样上限防长匹配。
const RENDER_CAP = 100
// 分段视图：章节/动作各带标题；sel 仍走扁平索引，保证 ↑↓ 键盘导航跨组连续
const sections = computed(() => {
  const indexed = filtered.value.map((c, i) => ({ c, i }))
  return [
    { title: '章节', items: indexed.filter((x) => x.c.group === 'chapter') },
    { title: '动作', items: indexed.filter((x) => x.c.group === 'action') },
  ]
    .filter((s) => s.items.length)
    .map((s) => ({
      ...s,
      items: s.items.slice(0, RENDER_CAP),
      omitted: Math.max(0, s.items.length - RENDER_CAP), // 未渲染条数（提示行展示）
    }))
})
// R61-16（第六十一轮）：键盘导航上限收到已渲染区间——每节 slice(RENDER_CAP) 后未渲染
// 条目无 DOM，旧上限（filtered.length-1）会让 ↓ 走进不可见区，Enter 执行看不见的命令。
// 上限 = 末个非空节末项的扁平索引（sections 按渲染顺序排列，i 即 filtered 全量索引）。
const maxSelIndex = computed(() => {
  const secs = sections.value
  for (let s = secs.length - 1; s >= 0; s--) {
    const items = secs[s]!.items
    if (items.length > 0) return items[items.length - 1]!.i
  }
  return -1
})
watch(filtered, () => {
  sel.value = 0
})
// sel 变化滚动跟随（键盘移动后高亮项保持可见；鼠标 hover 路径同受益）
watch(sel, () => {
  paletteRef.value?.querySelector('.palette-item.sel')?.scrollIntoView?.({ block: 'nearest' })
})

async function openDoc(node: TreeNode): Promise<void> {
  if (!node.docId) return
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

const inp = ref<HTMLInputElement | null>(null)
watch(
  () => ui.paletteOpen,
  async (v) => {
    if (v) {
      q.value = ''
      sel.value = 0
      await nextTick()
      inp.value?.focus()
    }
  },
)

function onKey(e: KeyboardEvent): void {
  if (!ui.paletteOpen) return
  // R61-3（第六十一轮）：IME 组合期让渡——Enter/方向键正在收输入法候选框
  if (isImeComposing(e)) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    sel.value = Math.min(sel.value + 1, Math.max(maxSelIndex.value, 0))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    sel.value = Math.max(sel.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const c = filtered.value[sel.value]
    if (c) {
      c.run()
      ui.closePalette()
    }
  } else if (e.key === 'Escape') {
    ui.closePalette()
    e.preventDefault() // Z-23：本层消费 Esc，防同键退专注双效
  }
}
function run(c: Cmd): void {
  c.run()
  ui.closePalette()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.paletteOpen" class="palette-mask" @click="ui.closePalette">
      <div ref="paletteRef" class="palette" role="dialog" aria-modal="true" aria-label="命令面板" tabindex="-1" @click.stop>
        <input
          ref="inp"
          v-model="q"
          class="palette-input"
          placeholder="搜索章节或操作…"
          @keydown="onKey"
        />
        <div class="palette-list">
          <div v-for="sec in sections" :key="sec.title" class="palette-group">
            <div class="pg-title">{{ sec.title }}</div>
            <div
              v-for="{ c, i } in sec.items"
              :key="c.id"
              class="palette-item"
              :class="{ sel: i === sel }"
              @mouseenter="sel = i"
              @click="run(c)"
            >
              <span class="pi-label">
                <span v-if="c.no" class="pi-no">{{ c.no }}</span>
                <span class="pi-label-text">{{ c.label }}</span>
              </span>
              <CornerDownLeft v-if="i === sel" :size="13" class="pi-enter" />
            </div>
            <!-- M-P3-13：每节渲染上限外的省略提示（继续输入缩小范围后可见） -->
            <div v-if="sec.omitted > 0" class="pg-more">已省略 {{ sec.omitted }} 项，继续输入以缩小范围</div>
          </div>
          <div v-if="!filtered.length" class="palette-empty">无匹配</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  z-index: 150;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.palette {
  width: min(480px, calc(100vw - 32px));
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-l);
  overflow: hidden;
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.palette-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--background-modifier-border);
  padding: var(--size-4-3);
  font-size: var(--font-size-m);
  background: transparent;
  color: var(--text-normal);
  outline: none;
  box-sizing: border-box;
}
.palette-list {
  max-height: 320px;
  overflow: auto;
  padding: var(--size-4-1);
}
.palette-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px var(--size-4-3);
  font-size: var(--font-size-m);
  color: var(--text-normal);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.palette-item.sel {
  background: var(--background-modifier-hover);
}
.palette-group {
  padding: var(--size-4-1) 0;
}
.palette-group + .palette-group {
  border-top: 1px solid var(--background-modifier-border);
  margin-top: var(--size-4-1);
}
.pg-title {
  padding: var(--size-4-1) var(--size-4-3);
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
/* M-P3-13：渲染上限省略提示行 */
.pg-more {
  padding: var(--size-4-1) var(--size-4-3);
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-style: italic;
}
.pi-label {
  display: inline-flex;
  align-items: baseline;
  gap: var(--size-4-2);
  min-width: 0;
}
.pi-no {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.pi-label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pi-enter {
  color: var(--text-faint);
  flex-shrink: 0;
}
.palette-item.sel .pi-enter {
  color: var(--text-accent);
}
.palette-empty {
  padding: var(--size-4-3);
  font-size: var(--font-size-m);
  color: var(--text-faint);
  text-align: center;
}
</style>

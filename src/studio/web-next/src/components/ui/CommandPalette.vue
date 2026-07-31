<script setup lang="ts">
// 命令面板（细案 T2.4）：⌘P 弹出。跳章（当前树叶子）+ 动作（主题/栏/专注/设置/书架）。
// 模糊搜索 + ↑↓ 选 / 回车执行 / Esc 关。
import { ref, computed, watch, nextTick } from 'vue'
import { CornerDownLeft } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useAppActions } from '../../composables/useAppActions'
import type { TreeNode } from '../../types/tree'

const ui = useUiStore()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const { actions: appActions } = useAppActions()

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
// 分段视图：章节/动作各带标题；sel 仍走扁平索引，保证 ↑↓ 键盘导航跨组连续
const sections = computed(() => {
  const indexed = filtered.value.map((c, i) => ({ c, i }))
  return [
    { title: '章节', items: indexed.filter((x) => x.c.group === 'chapter') },
    { title: '动作', items: indexed.filter((x) => x.c.group === 'action') },
  ].filter((s) => s.items.length)
})
watch(filtered, () => {
  sel.value = 0
})

async function openDoc(node: TreeNode): Promise<void> {
  if (!node.docId) return
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch {
    /* 打开失败静默 */
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
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    sel.value = Math.min(sel.value + 1, filtered.value.length - 1)
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
      <div class="palette" @click.stop>
        <input
          ref="inp"
          v-model="q"
          class="palette-input"
          placeholder="输入命令或章节名…"
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

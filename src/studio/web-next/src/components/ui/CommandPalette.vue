<script setup lang="ts">
// 命令面板（细案 T2.4）：⌘P 弹出。跳章（当前树叶子）+ 动作（主题/栏/专注/设置/书架）。
// 模糊搜索 + ↑↓ 选 / 回车执行 / Esc 关。
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '../../stores/ui'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTheme } from '../../composables/useTheme'
import type { TreeNode } from '../../types/tree'

const ui = useUiStore()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const router = useRouter()
const { toggle: toggleTheme } = useTheme()

interface Cmd {
  id: string
  label: string
  hint?: string
  run: () => void
}
const cmds = computed<Cmd[]>(() => {
  const list: Cmd[] = []
  for (const [, node] of tree.byDocId) {
    if (!node.isDirectory) {
      const n = node
      list.push({ id: 'doc:' + n.docId, label: n.name, hint: '跳转', run: () => openDoc(n) })
    }
  }
  list.push({ id: 'act:theme', label: '切换亮/暗主题', run: () => toggleTheme() })
  list.push({ id: 'act:left', label: '切换左栏', run: () => ws.toggleLeft() })
  list.push({ id: 'act:right', label: '切换右栏', run: () => ws.toggleRight() })
  list.push({ id: 'act:focus', label: '切换专注模式', run: () => ws.toggleFocus() })
  list.push({ id: 'act:settings', label: '打开设置', run: () => ui.openSettings() })
  list.push({ id: 'act:shelf', label: '返回书架', run: () => router.push('/shelf') })
  return list
})

const q = ref('')
const sel = ref(0)
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return k ? cmds.value.filter((c) => c.label.toLowerCase().includes(k)) : cmds.value
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
          <div
            v-for="(c, i) in filtered"
            :key="c.id"
            class="palette-item"
            :class="{ sel: i === sel }"
            @mouseenter="sel = i"
            @click="run(c)"
          >
            <span class="pi-label">{{ c.label }}</span>
            <span v-if="c.hint" class="pi-hint">{{ c.hint }}</span>
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
}
.palette {
  width: 480px;
  max-width: 92vw;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.palette-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--background-modifier-border);
  padding: var(--size-4-3);
  font-size: 14px;
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
  font-size: 13px;
  color: var(--text-normal);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.palette-item.sel {
  background: var(--background-modifier-hover);
}
.pi-hint {
  font-size: 11px;
  color: var(--text-faint);
}
.palette-empty {
  padding: var(--size-4-3);
  font-size: 13px;
  color: var(--text-faint);
  text-align: center;
}
</style>

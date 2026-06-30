<script setup lang="ts">
// 命令面板（⌘P）：模糊搜索 + 键盘选择。跳转 / 打开设置。
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NModal, NInput } from 'naive-ui'

const show = defineModel<boolean>('show', { default: false })
const route = useRoute()
const router = useRouter()

const query = ref('')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inputRef = ref<any>(null)
const activeIdx = ref(0)

const enc = computed(() => (route.params.name ? encodeURIComponent(route.params.name as string) : ''))
const base = computed(() => `/books/${enc.value}`)

interface Cmd {
  id: string
  label: string
  hint: string
  run: () => void
}

const commands = computed<Cmd[]>(() => {
  const list: Cmd[] = []
  if (enc.value) {
    const go = (p: string) => () => router.push(p)
    list.push(
      { id: 'go-overview', label: '总览：作品概要', hint: '跳转', run: go(base.value) },
      { id: 'go-edit', label: '编辑：文件', hint: '跳转', run: go(`${base.value}/edit`) },
      { id: 'go-workbench', label: '工作台', hint: '跳转', run: go(`${base.value}/workbench`) },
      { id: 'go-health', label: '体检', hint: '总览·分析', run: go(`${base.value}/health`) },
      { id: 'go-rhythm', label: '节奏', hint: '总览·分析', run: go(`${base.value}/rhythm`) },
      { id: 'go-leads', label: '账本', hint: '总览·分析', run: go(`${base.value}/leads`) },
      { id: 'go-settings', label: '设定', hint: '总览·分析', run: go(`${base.value}/settings`) },
      { id: 'go-config', label: '配置', hint: '总览·分析', run: go(`${base.value}/config`) },
    )
  }
  return list
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
})

watch(filtered, () => {
  activeIdx.value = 0
})

function exec(c: Cmd): void {
  c.run()
  close()
}
function close(): void {
  show.value = false
  query.value = ''
}
watch(show, (s) => {
  if (s) {
    query.value = ''
    activeIdx.value = 0
    void nextTick(() => inputRef.value?.focus?.())
  }
})
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = Math.min(activeIdx.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const c = filtered.value[activeIdx.value]
    if (c) exec(c)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
</script>

<template>
  <NModal v-model:show="show" :bordered="false" style="width: 520px; max-width: 92vw">
    <div class="cp">
      <NInput
        ref="inputRef"
        v-model:value="query"
        placeholder="输入命令…（↑↓ 选择 · Enter 执行 · Esc 关闭）"
        @keydown="onKey"
      />
      <div class="cp-list">
        <div
          v-for="(c, i) in filtered"
          :key="c.id"
          class="cp-item"
          :class="{ active: i === activeIdx }"
          @click="exec(c)"
          @mouseenter="activeIdx = i"
        >
          <span class="cp-label">{{ c.label }}</span>
          <span class="cp-hint">{{ c.hint }}</span>
        </div>
        <div v-if="!filtered.length" class="cp-empty">无匹配命令</div>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.cp {
  background: var(--panel);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.cp-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
}
.cp-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.cp-item:hover,
.cp-item.active {
  background: var(--active-bg);
}
.cp-item.active .cp-label {
  color: var(--ink-cyan);
  font-weight: 500;
}
.cp-label {
  color: var(--ink);
}
.cp-hint {
  color: var(--text-3);
  font-size: 11px;
}
.cp-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
</style>

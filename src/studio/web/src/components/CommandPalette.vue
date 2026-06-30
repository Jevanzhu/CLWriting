<script setup lang="ts">
// 命令面板（⌘P）：模糊搜索 + 键盘选择（mockup .cmd-mask/.cmd-input-wrap/.cmd-list/.cmd-item）。
// B 策略保留 script 键盘逻辑；NModal/NInput → 原生 .cmd-mask 结构。
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const show = defineModel<boolean>('show', { default: false })
const route = useRoute()
const router = useRouter()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
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
    void nextTick(() => inputRef.value?.focus())
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
  <div class="cmd-mask" :class="{ show }" @click.self="close">
    <div class="cmd-box">
      <div class="cmd-input-wrap">
        <span class="cmd-icon">⌘</span>
        <input
          ref="inputRef"
          v-model="query"
          placeholder="输入命令或搜索…（↑↓ 选择 · Enter 执行 · Esc 关闭）"
          autocomplete="off"
          @keydown="onKey"
        />
      </div>
      <div class="cmd-list">
        <div
          v-for="(c, i) in filtered"
          :key="c.id"
          class="cmd-item"
          :class="{ sel: i === activeIdx }"
          @click="exec(c)"
          @mouseenter="activeIdx = i"
        >
          <span class="cmd-name">{{ c.label }}</span>
          <span v-if="c.hint" class="cmd-shortcut">{{ c.hint }}</span>
        </div>
        <div v-if="!filtered.length" class="cmd-empty">无匹配命令</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .cmd-mask/.cmd-input-wrap/.cmd-list/.cmd-item；.cmd-box 是内层卡片容器（components.css 未定义），此处补。 */
.cmd-box {
  width: 520px;
  max-width: 92vw;
  max-height: 60vh;
  background: var(--panel-80);
  backdrop-filter: blur(22px) saturate(1.4);
  -webkit-backdrop-filter: blur(22px) saturate(1.4);
  border: 1px solid var(--white-28);
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
}
</style>

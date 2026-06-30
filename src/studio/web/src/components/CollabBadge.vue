<script setup lang="ts">
// 顶栏徽章（mockup .topbar-cli/.cli-dot）。mockup 此位是 CLI 连接状态；真实无 CLI 在线探针，
// 借壳显示协作锁真实状态（/collab active）——不造假连接态。位置：编辑=文件，工作台=工作台。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'

const props = defineProps<{ bookName?: string; mode: string }>()

const route = useRoute()
const active = ref(false)
let timer: number | undefined

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

async function poll(): Promise<void> {
  const n = enc.value
  if (!n) return
  try {
    const r = await fetch(`/api/books/${n}/collab`)
    if (r.ok) {
      const d = (await r.json()) as { active?: boolean }
      active.value = !!d.active
    }
  } catch {
    /* 协作徽章是辅助显示，失败静默 */
  }
}

/** 当前写作位置：编辑模式取文件名，工作台取固定文案 */
const pos = computed(() => {
  if (props.mode === 'edit') {
    const f = route.query.file
    return typeof f === 'string' ? f : ''
  }
  return props.mode === 'workbench' ? '工作台' : ''
})

onMounted(() => {
  poll()
  timer = window.setInterval(poll, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <span
    class="topbar-cli"
    :class="{ off: !active }"
    :title="active ? '协作锁活跃：CLI 写入会被告知' : '当前空闲'"
  >
    <span class="cli-dot"></span>{{ active ? '单人编辑' : '空闲' }}<span v-if="pos"> · {{ pos }}</span>
  </span>
</template>

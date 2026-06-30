<script setup lang="ts">
// 工作台左栏：章节/篇任务列表（mockup .wb-tasks/.wb-task）。点击切章 → router query.chapter。
// 数据源 listFiles 解析正文章节；状态：有正文=已定稿（green）。无专门状态 API，不造假中间态。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getConfig, listFiles } from '../api/books'

const props = defineProps<{ bookName?: string }>()
const route = useRoute()
const router = useRouter()

interface Task {
  no: number
  name: string
  st: string
}
const tasks = ref<Task[]>([])
const kind = ref<'long' | 'short'>('long')
const unit = computed(() => (kind.value === 'short' ? '篇' : '章'))
const current = computed(() => {
  const q = route.query.chapter
  const n = typeof q === 'string' ? Number(q) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
})

async function load(): Promise<void> {
  if (!props.bookName) {
    tasks.value = []
    return
  }
  try {
    const [cfg, files] = await Promise.all([getConfig(props.bookName), listFiles(props.bookName)])
    kind.value = (cfg.kind ?? 'long') === 'short' ? 'short' : 'long'
    const pat = kind.value === 'short' ? /pieces\/sp(\d+)\.md$/i : /chapters\/ch(\d+)\.md$/i
    const nos = new Set<number>()
    for (const f of files) {
      const m = f.path.match(pat)
      if (m) nos.add(Number(m[1]))
    }
    tasks.value = [...nos]
      .sort((a, b) => a - b)
      .map((no) => ({ no, name: `第 ${no} ${unit.value}`, st: '已定稿' }))
  } catch {
    tasks.value = []
  }
}

function pick(no: number): void {
  router.push({ path: route.path, query: { ...route.query, chapter: String(no) } })
}

watch(
  () => props.bookName,
  () => load(),
  { immediate: true },
)
</script>

<template>
  <div class="tree-head">
    <span class="tree-head-label">任务</span>
    <span class="head-count">{{ tasks.length }}</span>
  </div>
  <div class="wb-tasks">
    <div
      v-for="t in tasks"
      :key="t.no"
      class="wb-task"
      :class="{ active: t.no === current }"
      @click="pick(t.no)"
    >
      <div class="tt"><span class="dot green"></span>{{ t.name }}</div>
      <div class="ts">{{ t.st }}</div>
    </div>
    <div v-if="!tasks.length" class="hint">暂无已定稿{{ unit }}（在工作台生成）</div>
  </div>
</template>

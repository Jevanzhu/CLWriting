<script setup lang="ts">
// 左栏底段：←书架 / ⋯设置 / 长短篇切换。三态共用。
// 长短篇切换 = 切到该类型第一本书（同 mockup kind-seg 语义）。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { listBooks } from '../api/books'
import type { BookMeta, BookKind } from '../types'

const props = defineProps<{ bookName?: string }>()
const emit = defineEmits<{ back: []; settings: [] }>()

const router = useRouter()
const books = ref<BookMeta[]>([])
const open = ref(false)

const cur = computed(() => books.value.find((b) => b.name === props.bookName))
const curKind = computed<BookKind>(() => cur.value?.kind ?? 'long')

async function load(): Promise<void> {
  try {
    books.value = (await listBooks()).books ?? []
  } catch {
    books.value = []
  }
}
watch(() => props.bookName, () => load(), { immediate: true })

/** 切类型：跳到该类型第一本书（无则忽略） */
function switchKind(k: BookKind): void {
  open.value = false
  if (k === curKind.value) return
  const target = books.value.find((b) => b.kind === k)
  if (target) router.push(`/books/${encodeURIComponent(target.name)}`)
}

// 点击外部收起下拉
function onDocClick(): void {
  open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="sider-foot">
    <div class="foot-back" @click="emit('back')"><span class="foot-arrow">←</span><span>书架</span></div>
    <div class="icon-btn" title="设置" @click="emit('settings')">⋯</div>
    <div class="kind-seg" :class="{ open }" @click.stop="open = !open">
      <div class="kind-drop">
        <span class="caret"><i class="up"></i><i class="dn"></i></span>
        <span>{{ curKind === 'short' ? '短篇集' : '长篇' }}</span>
      </div>
      <div class="kind-menu">
        <div class="kind-item" :class="{ active: curKind === 'long' }" @click.stop="switchKind('long')"><span>长篇</span><span v-if="curKind === 'long'" class="km-check">✓</span></div>
        <div class="kind-item" :class="{ active: curKind === 'short' }" @click.stop="switchKind('short')"><span>短篇集</span><span v-if="curKind === 'short'" class="km-check">✓</span></div>
      </div>
    </div>
  </div>
</template>

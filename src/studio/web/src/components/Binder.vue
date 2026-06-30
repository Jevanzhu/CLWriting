<script setup lang="ts">
// 左栏中段底部：同类型书列表（快速切书）。三态共用。GET /books 取列表，按当前书 kind 过滤。
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { listBooks } from '../api/books'
import type { BookMeta } from '../types'

const props = defineProps<{ bookName?: string }>()
const router = useRouter()
const books = ref<BookMeta[]>([])

const cur = computed(() => books.value.find((b) => b.name === props.bookName))
// 只列与当前书同类型的书（长篇 ↔ 长篇 / 短篇集 ↔ 短篇集）
const list = computed(() => (cur.value ? books.value.filter((b) => b.kind === cur.value!.kind) : []))
const kindLabel = computed(() => (cur.value?.kind === 'short' ? '短篇集' : '长篇'))

async function load(): Promise<void> {
  try {
    books.value = (await listBooks()).books ?? []
  } catch {
    books.value = []
  }
}
watch(() => props.bookName, () => load(), { immediate: true })

function open(name: string): void {
  if (name === props.bookName) return
  router.push(`/books/${encodeURIComponent(name)}`)
}
</script>

<template>
  <div class="binder">
    <div class="binder-head"><span>书籍</span><span class="head-count">{{ list.length }}</span></div>
    <div v-if="list.length" class="binder-items">
      <div
        v-for="b in list"
        :key="b.name"
        class="binder-item"
        :class="{ active: b.name === bookName }"
        @click="open(b.name)"
      >
        <span class="dot" :class="b.name === bookName ? 'green' : 'gray'"></span>
        <span class="bi-name">{{ b.name }}</span>
      </div>
    </div>
    <div v-else class="binder-empty">暂无{{ kindLabel }}书籍</div>
  </div>
</template>

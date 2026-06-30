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
      <div class="kind-drop"><span>{{ curKind === 'short' ? '短篇集' : '长篇' }}</span></div>
      <div class="kind-menu">
        <div class="kind-item" :class="{ active: curKind === 'long' }" @click.stop="switchKind('long')"><span>长篇</span><span v-if="curKind === 'long'" class="km-check">✓</span></div>
        <div class="kind-item" :class="{ active: curKind === 'short' }" @click.stop="switchKind('short')"><span>短篇集</span><span v-if="curKind === 'short'" class="km-check">✓</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sider-foot{flex-shrink:0;padding:8px 12px;border-top:1px solid var(--white-14);display:flex;flex-direction:row;gap:4px;align-items:center;justify-content:center}
.foot-back{display:flex;align-items:center;justify-content:flex-start;gap:10px;height:32px;min-width:78px;padding:0 12px;font-size:13px;font-weight:500;color:var(--text-2);cursor:pointer;border-radius:5px;flex-shrink:0;transition:background .12s,color .12s}
.foot-back:hover{background:var(--flat-hover);color:var(--ink)}
.foot-arrow{color:var(--text-3);font-size:12px}
.icon-btn{height:32px;min-width:32px;padding:6px 10px;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;color:var(--text-2);cursor:pointer;border-radius:5px;transition:background .12s,color .12s}
.icon-btn:hover{background:var(--hover);color:var(--ink)}
.kind-seg{position:relative;min-width:78px}
.kind-drop{height:32px;min-width:78px;display:flex;align-items:center;justify-content:center;padding:0 12px;font-size:13px;font-weight:500;color:var(--text-2);cursor:pointer;border-radius:5px;transition:background .12s,color .12s}
.kind-drop:hover{background:var(--flat-hover);color:var(--ink)}
.kind-seg.open .kind-drop{color:var(--ink-cyan);background:var(--flat-hover)}
.kind-menu{display:none;position:absolute;bottom:calc(100% + 4px);left:0;right:0;background:var(--panel);border:1px solid var(--white-22);border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:40}
.kind-seg.open .kind-menu{display:block}
.kind-item{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-size:13px;color:var(--text-2);cursor:pointer;border-radius:5px}
.kind-item:hover{background:var(--flat-hover);color:var(--ink)}
.kind-item.active{color:var(--ink-cyan);font-weight:600}
.km-check{color:var(--ink-cyan);font-size:12px}
</style>

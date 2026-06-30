<script setup lang="ts">
// 编辑态右栏：当前文件上下文（字数实时）。对齐 mockup 右栏 .card/.kv。
// 当前文件 = route.query.file（与 FileTree/Editor 同源）。
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const file = computed(() => (typeof route.query.file === 'string' ? route.query.file : ''))
const enc = computed(() => (route.params.name ? encodeURIComponent(route.params.name as string) : ''))
const isText = computed(() => !file.value.endsWith('.md') || file.value.includes('/chapters/'))
const words = ref(0)
const loading = ref(false)

async function load(): Promise<void> {
  if (!file.value || !enc.value) {
    words.value = 0
    return
  }
  loading.value = true
  try {
    const r = await fetch(`/api/books/${enc.value}/file?file=${encodeURIComponent(file.value)}`)
    if (r.ok) {
      const d = (await r.json()) as { content?: string }
      words.value = String(d.content ?? '').replace(/\s+/g, '').length
    } else {
      words.value = 0
    }
  } catch {
    words.value = 0
  } finally {
    loading.value = false
  }
}

watch(file, () => load(), { immediate: true })
</script>

<template>
  <div class="card">
    <div class="card-title">当前文件</div>
    <div class="kv"><span class="k">文件</span><span class="v cyan" style="word-break:break-all">{{ file || '（未选）' }}</span></div>
    <div class="kv"><span class="k">类型</span><span class="v">{{ isText ? '正文' : '设定/大纲' }}</span></div>
    <div class="kv"><span class="k">字数</span><span class="v">{{ loading ? '…' : words.toLocaleString() }}</span></div>
  </div>
  <div class="card">
    <div class="card-title">上下文</div>
    <div class="dd-hint">正文/设定在编辑器写；账本提醒、角色卡等数据查看请切顶栏「总览」。</div>
  </div>
</template>

<style scoped>
/* mockup 右栏 .card/.kv 已覆盖；仅补说明文本（mockup 无此语义类）。 */
.dd-hint{font-size:12px;color:var(--text-2);line-height:1.7}
</style>

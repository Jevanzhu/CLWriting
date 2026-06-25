<script setup lang="ts">
// 编辑态右栏：当前文件上下文（字数实时）。当前文件 = route.query.file（与 FileTree/Editor 同源）。
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
  <div class="ctx">
    <div class="ctx-card">
      <div class="ctx-title">当前文件</div>
      <div class="ctx-file" :title="file">{{ file || '（未选）' }}</div>
      <div class="ctx-kv"><span>类型</span><b>{{ isText ? '正文' : '设定/大纲' }}</b></div>
      <div class="ctx-kv"><span>字数</span><b>{{ loading ? '…' : words.toLocaleString() }}</b></div>
    </div>
    <div class="ctx-card">
      <div class="ctx-title">上下文</div>
      <div class="ctx-hint">正文/设定在编辑器写；账本提醒、角色卡等数据查看请切顶栏「总览」。</div>
    </div>
  </div>
</template>

<style scoped>
.ctx-card {
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.ctx-title {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.ctx-file {
  font-size: 13px;
  color: var(--ink-cyan);
  font-weight: 500;
  margin-bottom: 8px;
  word-break: break-all;
}
.ctx-kv {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
  color: var(--text-2);
}
.ctx-kv b {
  color: var(--ink);
  font-weight: 500;
}
.ctx-hint {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
}
</style>

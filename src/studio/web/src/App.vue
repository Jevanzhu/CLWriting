<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 启动初始态：--book 指定的书 → 直进单书（仅当当前停在书架首页时）
onMounted(async () => {
  try {
    const r = await fetch('/api/boot')
    if (!r.ok) return
    const data = (await r.json()) as { initialBook?: string }
    if (data.initialBook && router.currentRoute.value.path === '/') {
      router.push(`/books/${encodeURIComponent(data.initialBook)}`)
    }
  } catch {
    // boot 失败不影响书架浏览
  }
})
</script>

<template>
  <div class="studio-root">
    <header class="studio-header">
      <h1>CLWriting Studio</h1>
    </header>
    <main class="studio-main">
      <router-view />
    </main>
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
}
.studio-root {
  min-height: 100vh;
  background: #f6f7f9;
}
.studio-header {
  background: #1f2937;
  color: #fff;
  padding: 16px 24px;
}
.studio-header h1 {
  margin: 0;
  font-size: 18px;
}
.studio-main {
  padding: 24px;
}
</style>

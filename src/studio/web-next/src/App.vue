<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getLastInitialBook } from './api/client'

// 根组件：路由出口 + 启动 initialBook 直进工作区（/api/boot 返回时）。
const router = useRouter()
onMounted(() => {
  const ib = getLastInitialBook()
  if (ib && location.pathname === '/') {
    router.replace(`/book/${encodeURIComponent(ib)}`)
  }
})
</script>

<template>
  <router-view />
</template>

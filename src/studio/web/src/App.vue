<script setup lang="ts">
import Bookshelf from './pages/Bookshelf.vue'
</script>

<template>
  <div class="studio-root">
    <header class="studio-header">
      <h1>CLWriting Studio</h1>
    </header>
    <main class="studio-main">
      <Bookshelf />
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

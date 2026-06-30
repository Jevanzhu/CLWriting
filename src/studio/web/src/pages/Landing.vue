<script setup lang="ts">
// 启动页（landing）：品牌欢迎 + 最近打开的书 + 入口动作。对齐 mockup v5 renderLanding。
// 桌面版注入 window.clwritingDesktop（书库管理 IPC）；浏览器版隐藏桌面入口。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { listBooks } from '../api/books'
import type { BookMeta } from '../types'

const router = useRouter()
const desktop = window.clwritingDesktop ?? null
const recentBooks = ref<BookMeta[]>([])

async function loadRecent(): Promise<void> {
  try {
    const r = await listBooks()
    recentBooks.value = (r.books ?? []).slice(0, 6)
  } catch {
    /* 空书架时 recentBooks 为空，仍显示欢迎 */
  }
}

function openBook(name: string): void {
  router.push(`/books/${encodeURIComponent(name)}`)
}
function goShelf(): void {
  router.push('/shelf')
}
function newBook(): void {
  router.push('/books/new')
}
async function openLibrary(): Promise<void> {
  if (desktop) await desktop.openLibrary()
}

onMounted(loadRecent)
</script>

<template>
  <section class="landing">
    <div class="landing-logo">墨</div>
    <div class="landing-title">CLWriting Studio</div>
    <div class="landing-sub">沉浸式写作空间</div>

    <div v-if="recentBooks.length" class="landing-recent">
      <div class="landing-recent-title">最近打开的书</div>
      <div class="landing-cards">
        <div v-for="b in recentBooks" :key="b.name" class="landing-card" tabindex="0" @click="openBook(b.name)" @keydown.enter="openBook(b.name)">
          <div class="lc-icon" :class="b.kind">{{ b.kind === 'short' ? '短' : '长' }}</div>
          <div class="lc-info">
            <div class="lc-name">{{ b.name }}</div>
            <div class="lc-meta">{{ b.kind === 'short' ? '短篇集' : '长篇' }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="landing-actions">
      <button class="btn primary" @click="goShelf">📚 书架</button>
      <button class="btn" @click="newBook">+ 新建</button>
      <button v-if="desktop" class="btn" @click="openLibrary">📂 打开书库</button>
    </div>
  </section>
</template>

<style scoped>
.landing{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 40px;text-align:center;position:relative;overflow:hidden}
.landing::before,.landing::after{content:'';position:absolute;border-radius:50%;filter:blur(80px);pointer-events:none;z-index:0}
.landing::before{width:400px;height:400px;background:var(--white-40);top:-100px;left:-50px;opacity:.5}
.landing::after{width:360px;height:360px;background:var(--white-30);bottom:-120px;right:-60px;opacity:.4}
.landing-logo{position:relative;z-index:1;width:84px;height:84px;border-radius:22px;background:var(--ink-cyan);color:#fff;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:800;font-family:'STKaiti','KaiTi','楷体',serif;margin-bottom:24px;box-shadow:0 12px 32px var(--cyan-28)}
.landing-title{position:relative;z-index:1;font-size:32px;font-weight:800;color:var(--ink);letter-spacing:1px;margin-bottom:8px}
.landing-sub{position:relative;z-index:1;font-size:14px;color:var(--text-2);margin-bottom:40px}
.landing-recent{position:relative;z-index:1;width:100%;max-width:680px;margin-bottom:36px}
.landing-recent-title{font-size:11px;color:var(--text-3);font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:14px}
.landing-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.landing-card{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--panel-74);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);border:1px solid var(--white-20);border-radius:14px;cursor:pointer;transition:transform .25s cubic-bezier(.2,.8,.2,1),border-color .2s;text-align:left}
.landing-card:hover,.landing-card:focus-visible{transform:translateY(-3px);border-color:var(--white-36);outline:none}
.lc-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;background:var(--cyan-14);color:var(--ink-cyan)}
.lc-icon.short{background:var(--ochre-14);color:var(--ochre)}
.lc-info{min-width:0}
.lc-name{font-size:14px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-meta{font-size:11px;color:var(--text-3);margin-top:2px}
.landing-actions{position:relative;z-index:1;display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
</style>

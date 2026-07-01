<script setup lang="ts">
// 书库管理（libraries）：当前书库 + 最近列表 + 切换(relaunch)/打开选择器。对齐 mockup v5 renderLibraries。
// 真实为单 workDir 架构（一次一书库，切换=app.relaunch）；mockup 的"重命名/删除/字数"无后端支持 → 省略。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { listBooks } from '../api/books'

const router = useRouter()
const desktop = window.clwritingDesktop ?? null
const isDesktop = computed(() => desktop !== null)
const recentLibs = ref<{ path: string; label: string }[]>([])
const currentLib = ref<string | null>(null)
const bookCount = ref(0)

const currentLabel = computed(() => {
  if (!currentLib.value) return ''
  const seg = currentLib.value.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? currentLib.value
})
const otherLibs = computed(() => recentLibs.value.filter((x) => x.path !== currentLib.value))

async function load(): Promise<void> {
  if (!desktop) return
  try {
    const [recent, current] = await Promise.all([
      desktop.getRecentLibraries(),
      desktop.getCurrentLibrary(),
    ])
    recentLibs.value = recent
    currentLib.value = current
  } catch {
    /* preload 失败静默 */
  }
  try {
    const r = await listBooks()
    bookCount.value = (r.books ?? []).length
  } catch {
    /* 读不到书数静默 */
  }
}

async function switchTo(path: string): Promise<void> {
  if (desktop) await desktop.switchLibrary(path)
}
async function openLibrary(): Promise<void> {
  if (desktop) await desktop.openLibrary()
}
function goShelf(): void {
  router.push('/shelf')
}
function newBook(): void {
  router.push('/books/new')
}
/** 重命名/删除书库：单 workDir 架构，后端暂不支持 → 占位入口（对齐 mockup 操作） */
function renameLibrary(): void {
  window.alert('重命名书库待后端支持（单 workDir 架构）')
}
function deleteLibrary(): void {
  if (window.confirm('确认删除该书库？后端暂不支持，仅预留入口。')) {
    /* TODO(后端): 书库删除 API */
  }
}

onMounted(load)
</script>

<template>
  <div class="workspace full">
    <div class="lib-page">
      <div class="lib-head">
        <div class="lib-title">书库</div>
        <div class="lib-sub">{{ recentLibs.length || 1 }} 个书库 · {{ currentLabel || '当前工作目录' }}</div>
      </div>

      <p v-if="!isDesktop" style="color:var(--text-2);font-size:13px;padding:24px 0">
        书库管理为桌面端功能（浏览器版单工作目录）。桌面版可切换 / 打开书库目录。
      </p>

      <template v-else>
        <!-- 当前书库 -->
        <div v-if="currentLib" class="lib-card">
          <div class="lib-icon long">书</div>
          <div class="lib-info">
            <div class="lib-name">{{ currentLabel }}</div>
            <div class="lib-path">{{ currentLib }}</div>
            <div class="lib-stats">
              <span class="lib-stat"><b>{{ bookCount }}</b> 本书</span>
            </div>
          </div>
          <div class="lib-actions">
            <button class="btn primary" @click="goShelf">打开书架</button>
            <button class="btn" @click="newBook">+ 新建书</button>
            <button class="btn" @click="openLibrary">切换书库</button>
            <button class="btn" @click="renameLibrary">✏ 重命名</button>
            <button class="btn" @click="deleteLibrary">🗑 删除</button>
          </div>
        </div>

        <!-- 最近书库（点击切换 → relaunch） -->
        <div
          v-for="r in otherLibs"
          :key="r.path"
          class="lib-card"
          tabindex="0"
          @click="switchTo(r.path)"
          @keydown.enter="switchTo(r.path)"
        >
          <div class="lib-icon long">书</div>
          <div class="lib-info">
            <div class="lib-name">{{ r.label }}</div>
            <div class="lib-path">{{ r.path }}</div>
          </div>
          <div class="lib-actions">
            <span class="btn">切换 →</span>
          </div>
        </div>

        <div style="margin-top:18px">
          <button class="btn primary" @click="openLibrary">+ 新建 / 打开其他书库</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 更新提示横幅（阶段 53）：有新正式版时提示并指路下载。
//
// 与 StartupNoticeBanner 的区别在「记忆键」：通告按条指纹（kind@ts）记忆，本横幅按
// **版本号**记忆——同一版本关掉不再弹，出新版（下次检查拿到新版本号）再弹。
//
// 「去下载」两条路：桌面版走 IPC openExternal（主进程白名单只放行本项目发布页）；
// 浏览器版无桥 → 降级复制链接（navigator.clipboard 不可用时连复制也不提，只留提示）。
// 取不到版本/接口失败一律静默不显示（设计 §3.3 的静默口径同款）。
import { computed, onMounted, ref } from 'vue'
import { Download, X } from 'lucide-vue-next'
import { getAppInfo } from '../../api/app-info'

const DISMISS_KEY = 'clw-update-dismissed'

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    // 脏值容错照 R43-11 先例（StartupNoticeBanner 同款）：非数组不炸 + 元素验 string，
    // 防手改/损坏的 localStorage 把脏值固化进比对面
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const currentVersion = ref<string | null>(null)
const latest = ref<{ version: string; url: string } | null>(null)
const dismissed = ref<string[]>(loadDismissed())
const copied = ref(false)

/** 有更新且该版本未被关闭过 */
const visible = computed(
  () => latest.value !== null && !dismissed.value.includes(latest.value.version),
)

onMounted(async () => {
  try {
    const info = await getAppInfo()
    currentVersion.value = info.version
    latest.value = info.update
  } catch {
    /* 服务未起/离线：静默不显示（更新提示不阻塞应用） */
  }
})

async function openDownload(): Promise<void> {
  const url = latest.value?.url
  if (!url) return
  const bridge = window.clwritingDesktop
  if (bridge?.openExternal) {
    const r = await bridge.openExternal(url)
    // 主进程拒绝（白名单外/打开失败）→ 降级复制，不留死按钮
    if (r.ok) return
  }
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
  } catch {
    /* 剪贴板不可用（非安全上下文/无权限）：只留链接文案，不报错 */
  }
}

function dismiss(): void {
  const v = latest.value?.version
  if (!v) return
  dismissed.value = [...dismissed.value, v]
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed.value))
  } catch {
    /* localStorage 不可用：本次会话内关闭即静默 */
  }
}
</script>

<template>
  <div v-if="visible" class="ub-banner" role="status">
    <Download :size="18" class="ub-icon" />
    <div class="ub-body">
      <p class="ub-title">有新版本 v{{ latest!.version }}</p>
      <p class="ub-sub">当前 v{{ currentVersion ?? '未知' }} · 不会自动下载，点「去下载」到发布页</p>
    </div>
    <button class="ub-open" @click="openDownload">
      {{ copied ? '链接已复制' : '去下载' }}
    </button>
    <button class="ub-close" title="关闭（该版本不再提示，出新版会再提示）" @click="dismiss">
      <X :size="16" />
    </button>
  </div>
</template>

<style scoped>
.ub-banner {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin: var(--size-4-2) var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--text-accent, #4f8cff);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}
.ub-icon {
  flex: none;
  color: var(--text-accent, #4f8cff);
}
.ub-body {
  flex: 1;
  min-width: 0;
}
.ub-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.ub-sub {
  margin-top: 2px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.ub-open {
  flex: none;
  padding: 4px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--text-accent, #4f8cff);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-accent, #4f8cff);
  cursor: pointer;
}
.ub-open:hover {
  background: var(--background-modifier-hover);
}
.ub-close {
  flex: none;
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ub-close:hover {
  background: var(--background-modifier-hover);
}
</style>

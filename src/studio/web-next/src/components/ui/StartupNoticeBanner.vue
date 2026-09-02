<script setup lang="ts">
// 启动通告横幅（A4 批 0）：启动链迁移失败（事件库/书库登记/版式迁移等）此前只有
// console 失明出口，打包态用户完全看不见。横幅一次性——「知道了」按通告指纹
// （kind@ts）落 localStorage，关闭后不再弹；后续新通告（新指纹）会再弹。
// 挂 App.vue 根部（ErrorBoundary 内、router-view 之外），全路由可见。
import { computed, onMounted, ref } from 'vue'
import { AlertTriangle, X } from 'lucide-vue-next'
import { getStartupNotices, type StartupNotice } from '../../api/startup-notices'

const DISMISS_KEY = 'clw-startup-notices-dismissed'

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

const notices = ref<StartupNotice[]>([])
const dismissed = ref<string[]>(loadDismissed())

/** 未Dismissed 的通告（指纹 = kind@ts，精确到条） */
const visible = computed(() =>
  notices.value.filter((n) => !dismissed.value.includes(`${n.kind}@${n.ts}`)),
)

onMounted(async () => {
  try {
    notices.value = await getStartupNotices()
  } catch {
    /* 离线/服务未起：横幅静默不显示（诊断信息不阻塞应用） */
  }
})

function dismiss(): void {
  dismissed.value = [...dismissed.value, ...visible.value.map((n) => `${n.kind}@${n.ts}`)]
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed.value))
  } catch {
    /* localStorage 不可用（隐私模式等）：本次会话内关闭即静默 */
  }
}
</script>

<template>
  <div v-if="visible.length" class="sn-banner" role="alert">
    <AlertTriangle :size="18" class="sn-icon" />
    <div class="sn-body">
      <p class="sn-title">启动自检发现 {{ visible.length }} 条通告</p>
      <ul class="sn-list">
        <li v-for="n in visible" :key="`${n.kind}@${n.ts}`">
          <span class="sn-kind">{{ n.kind }}</span>
          <span class="sn-msg">{{ n.message }}</span>
        </li>
      </ul>
    </div>
    <button class="sn-close" title="知道了（同一批通告不再提示）" @click="dismiss">
      <X :size="16" />
      知道了
    </button>
  </div>
</template>

<style scoped>
.sn-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  margin: var(--size-4-2) var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--text-warning, #d4a72c);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}
.sn-icon {
  flex: none;
  margin-top: 2px;
  color: var(--text-warning, #d4a72c);
}
.sn-body {
  flex: 1;
  min-width: 0;
}
.sn-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.sn-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sn-list li {
  display: flex;
  gap: 8px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  word-break: break-word;
}
.sn-kind {
  flex: none;
  font-family: var(--font-monospace);
  opacity: 0.7;
}
.sn-close {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.sn-close:hover {
  background: var(--background-modifier-hover);
}
</style>

<script setup lang="ts">
// 设置 · 诊断页（全局）：生成诊断包（环境 + 配置白名单 + 近 7 天日志，逐项脱敏）。
// 隐私口径与内核同源（src/diagnostics/index.ts 头注）：不含书稿正文与 API Key、
// 不含接口地址，路径替换为占位符。入口属「系统」组——排查件与应用/运行环境相关，
// 与当前打开哪本书无关（故本页得「全局」徽章，同其余非 book 页）。
import { computed, ref } from 'vue'
import { buildDiagnostics, type DiagnosticsResponse } from '../../api/diagnostics'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import SettingItem from './SettingItem.vue'

const ui = useUiStore()
const loading = ref(false)
const result = ref<DiagnosticsResponse | null>(null)
// 桌面版才有「打开所在文件夹」通道（浏览器版无 clwritingDesktop → 按钮隐藏）
const canReveal = computed(() => typeof window.clwritingDesktop?.revealDiagnostics === 'function')

async function run(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const r = await buildDiagnostics()
    result.value = r
    ui.toast(`诊断包已生成（${r.entries?.length ?? 0} 个条目）`, 'success')
    if ((r.warnings?.length ?? 0) > 0) {
      // 收集期非致命问题（单日志文件不可读等）——包可用，如实告知条数
      ui.toast(`诊断包有 ${r.warnings?.length ?? 0} 条收集告警（包仍可用）`, 'warning')
    }
  } catch (e) {
    // 业务失败（未定位到应用数据目录等）由 apiJson 抛 ApiError，信封文案即诊断
    ui.toast(friendlyError(e), 'error')
  } finally {
    loading.value = false
  }
}

function reveal(): void {
  void window.clwritingDesktop?.revealDiagnostics()
}

/** 包体积显示（KB/MB 一档；不足 1KB 也显示 1KB——包恒非空） */
const sizeText = computed(() => {
  const b = result.value?.bytes ?? 0
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`
})
</script>

<template>
  <div class="settings-tab">
    <div class="cfg-card-head">诊断</div>
    <section class="cfg-card">
      <SettingItem
        name="生成诊断包"
        desc="应用版本、平台与运行环境、配置白名单、近 7 天日志——脱敏后打成单个 ZIP 供排查；不含书稿正文与 API Key"
      >
        <button class="save-btn" :disabled="loading" data-testid="diagnostics-build" @click="run">
          {{ loading ? '生成中…' : '生成' }}
        </button>
      </SettingItem>
      <SettingItem v-if="result" name="已生成" desc="把该文件发给开发者即可（含日志，注意按需分享）">
        <div class="diag-result">
          <div class="diag-path" data-testid="diagnostics-path">{{ result.file }}</div>
          <div class="diag-meta">{{ result.entries?.length ?? 0 }} 个条目 · {{ sizeText }}</div>
          <button v-if="canReveal" class="link-btn" data-testid="diagnostics-reveal" @click="reveal">
            打开所在文件夹
          </button>
        </div>
      </SettingItem>
    </section>
  </div>
</template>

<style scoped>
.diag-result {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  max-width: 100%;
}
.diag-path {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  word-break: break-all;
  text-align: right;
}
.diag-meta {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
</style>

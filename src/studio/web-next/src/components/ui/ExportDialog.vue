<script setup lang="ts">
// 导出定稿弹窗（细案 T4.2）：选 format/platform → POST /export（spawn CLI，数秒）。
// 成功 toast + 关弹窗；失败展示 stderr/stdout。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'
import { exportBook, EXPORT_FORMATS, EXPORT_PLATFORMS, type ExportFormat, type ExportPlatform } from '../../api/io'
import { useUiStore } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'
import { friendlyError } from '../../shared/error'
import { useFocusTrap } from '../../composables/useFocusTrap'

const ui = useUiStore()
const ws = useWorkspaceStore()
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

const FORMATS = EXPORT_FORMATS
const PLATFORMS = EXPORT_PLATFORMS

const format = ref<ExportFormat>('both')
const platform = ref<ExportPlatform>('generic')
const loading = ref(false)

async function run(): Promise<void> {
  if (!ws.bookName || loading.value) return
  loading.value = true
  try {
    const r = await exportBook(ws.bookName, {
      format: format.value,
      platform: platform.value,
    })
    if (r.ok) {
      ui.toast(`导出完成（${r.chapterCount ?? '?'} ${r.unit ?? '章'}）`, 'success')
      ui.closeExport()
    } else {
      console.error('导出失败:', r.error)
      ui.toast('导出失败，请重试', 'error')
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    loading.value = false
  }
}

// Esc 关闭（mask 点击已支持；键盘可达性补全）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.exportOpen) {
    ui.closeExport()
    e.preventDefault() // Z-23：本层消费 Esc，防 useHotkeys 同键退专注双效
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.exportOpen" class="modal-mask" @click.self="ui.closeExport">
      <div ref="modalRef" class="export-modal" role="dialog" aria-modal="true" aria-label="导出" tabindex="-1" data-testid="export-dialog">
        <div class="modal-head">
          <span>导出定稿</span>
          <button class="close-btn" data-tip="关闭（Esc）" aria-label="关闭" data-tip-dir="bottom" data-testid="export-close" @click="ui.closeExport"><X :size="18" /></button>
        </div>
        <div class="form-row">
          <label>格式</label>
          <div class="opt-list">
            <button
              v-for="f in FORMATS"
              :key="f.v"
              class="opt"
              :class="{ on: format === f.v }"
              :data-testid="`export-format-${f.v}`"
              @click="format = f.v"
            >
              <span class="opt-label">{{ f.label }}</span>
              <span class="opt-hint">{{ f.hint }}</span>
            </button>
          </div>
        </div>
        <div class="form-row">
          <label>平台（可选）</label>
          <div class="seg-list">
            <button
              v-for="p in PLATFORMS"
              :key="p.v"
              class="seg-btn"
              :class="{ on: platform === p.v }"
              :data-testid="`export-platform-${p.v}`"
              @click="platform = p.v"
            >
              {{ p.label }}
            </button>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="loading" data-testid="export-run" @click="run">
            {{ loading ? '导出中…' : '导出' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.export-modal {
  width: min(420px, calc(100vw - 32px));
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-l);
  padding: var(--size-4-4);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-4);
}
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.close-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.form-row {
  margin-bottom: var(--size-4-4);
}
.form-row > label {
  display: block;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  margin-bottom: var(--size-4-2);
}
.opt-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 8px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  cursor: pointer;
  text-align: left;
}
.opt.on {
  border-color: var(--interactive-accent);
}
.opt-label {
  font-size: var(--font-size-m);
  color: var(--text-normal);
}
.opt-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.seg-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.seg-btn {
  padding: 5px 12px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.seg-btn.on {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.btn {
  padding: 6px 18px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>

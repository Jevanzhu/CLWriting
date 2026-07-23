import { defineStore } from 'pinia'
import { ref } from 'vue'

// 正文排版偏好（细案 §5 prefs）：直写 :root 的 --prose-* 变量，持久化沿用旧键 clw-*
//（用户偏好无缝迁移）。SettingsModal 滑块 → setXxx → apply。
const LS = { size: 'clw.proseSize', lh: 'clw.proseLh', gap: 'clw.proseGap' }
function load(key: string, def: number): number {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : def
}

export const usePrefsStore = defineStore('prefs', () => {
  const proseSize = ref(load(LS.size, 17))
  const proseLh = ref(load(LS.lh, 1.85))
  const proseGap = ref(load(LS.gap, 1))

  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(proseLh.value))
    r.style.setProperty('--prose-gap', `${proseGap.value}em`)
  }
  function setSize(v: number): void {
    proseSize.value = v
    localStorage.setItem(LS.size, String(v))
    apply()
  }
  function setLh(v: number): void {
    proseLh.value = v
    localStorage.setItem(LS.lh, String(v))
    apply()
  }
  function setGap(v: number): void {
    proseGap.value = v
    localStorage.setItem(LS.gap, String(v))
    apply()
  }

  return { proseSize, proseLh, proseGap, apply, setSize, setLh, setGap }
})

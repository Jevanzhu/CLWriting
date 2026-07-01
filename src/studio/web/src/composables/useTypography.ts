// 编辑器排版（字号/行高/段间距）：持久化 localStorage，模块加载即应用 --prose-size/lh/gap。
// 与 useFont（字体 family）/ useTheme（色温）并列，三者共构编辑器外观。
import { ref } from 'vue'

const KEY_SIZE = 'clw-prose-size'
const KEY_LH = 'clw-prose-lh'
const KEY_GAP = 'clw-prose-gap'

function readNum(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

const proseSize = ref<number>(readNum(KEY_SIZE, 18))
const proseLh = ref<number>(readNum(KEY_LH, 2.0))
const proseGap = ref<number>(readNum(KEY_GAP, 16))

/** 应用到 :root CSS var（CodeMirror editorTheme 读 --prose-size/lh/gap） */
function apply(): void {
  const r = document.documentElement.style
  r.setProperty('--prose-size', proseSize.value + 'px')
  r.setProperty('--prose-lh', String(proseLh.value))
  r.setProperty('--prose-gap', proseGap.value + 'px')
}

export function useTypography() {
  return {
    proseSize,
    proseLh,
    proseGap,
    setSize(v: number): void {
      proseSize.value = v
      try {
        localStorage.setItem(KEY_SIZE, String(v))
      } catch {
        /* ignore */
      }
      apply()
    },
    setLh(v: number): void {
      proseLh.value = v
      try {
        localStorage.setItem(KEY_LH, String(v))
      } catch {
        /* ignore */
      }
      apply()
    },
    setGap(v: number): void {
      proseGap.value = v
      try {
        localStorage.setItem(KEY_GAP, String(v))
      } catch {
        /* ignore */
      }
      apply()
    },
  }
}

// 模块加载即应用持久化排版（main.ts import 本模块即触发）
apply()

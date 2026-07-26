import { defineStore } from 'pinia'
import { ref } from 'vue'

// 排版 + 字体偏好（细案 §5 prefs + 字体设置）：直写 :root 变量，持久化沿用旧键 clw-*。
// 字体分 UI（--font-ui）/ 正文（--prose-font）两组，各中/英文 → 拼 font-family。
const LS = {
  size: 'clw.proseSize',
  lh: 'clw.proseLh',
  gap: 'clw.proseGap',
  uiFontCn: 'clw.uiFontCn',
  uiFontEn: 'clw.uiFontEn',
  proseFontCn: 'clw.proseFontCn',
  proseFontEn: 'clw.proseFontEn',
}
function loadNum(key: string, def: number): number {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : def
}
function loadStr(key: string): string {
  return localStorage.getItem(key) ?? ''
}

/** 拼字体族：英文字体优先（英文片段），中文字体兜底（中文），最后系统 fallback。
 *  含空格的字体名自动加引号。 */
function buildFontFamily(en: string, cn: string, fallback: string): string {
  const parts: string[] = []
  if (en) parts.push(en.includes(' ') ? `"${en}"` : en)
  if (cn) parts.push(cn.includes(' ') ? `"${cn}"` : cn)
  parts.push(fallback)
  return parts.join(', ')
}

export const usePrefsStore = defineStore('prefs', () => {
  const proseSize = ref(loadNum(LS.size, 17))
  const proseLh = ref(loadNum(LS.lh, 1.85))
  const proseGap = ref(loadNum(LS.gap, 1))
  const uiFontCn = ref(loadStr(LS.uiFontCn))
  const uiFontEn = ref(loadStr(LS.uiFontEn))
  const proseFontCn = ref(loadStr(LS.proseFontCn))
  const proseFontEn = ref(loadStr(LS.proseFontEn))

  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(proseLh.value))
    r.style.setProperty('--prose-gap', `${proseGap.value}em`)
    // 字体：仅用户设定时覆盖，否则用 tokens.css 默认（完整 fallback 链）
    if (uiFontCn.value || uiFontEn.value) {
      r.style.setProperty(
        '--font-ui',
        buildFontFamily(uiFontEn.value, uiFontCn.value, 'system-ui, sans-serif'),
      )
    } else {
      r.style.removeProperty('--font-ui')
    }
    if (proseFontCn.value || proseFontEn.value) {
      r.style.setProperty(
        '--prose-font',
        buildFontFamily(
          proseFontEn.value,
          proseFontCn.value,
          "'LXGW WenKai', 'Noto Serif SC', serif",
        ),
      )
    } else {
      r.style.removeProperty('--prose-font')
    }
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
  function setUiFontCn(v: string): void {
    uiFontCn.value = v
    localStorage.setItem(LS.uiFontCn, v)
    apply()
  }
  function setUiFontEn(v: string): void {
    uiFontEn.value = v
    localStorage.setItem(LS.uiFontEn, v)
    apply()
  }
  function setProseFontCn(v: string): void {
    proseFontCn.value = v
    localStorage.setItem(LS.proseFontCn, v)
    apply()
  }
  function setProseFontEn(v: string): void {
    proseFontEn.value = v
    localStorage.setItem(LS.proseFontEn, v)
    apply()
  }

  return {
    proseSize,
    proseLh,
    proseGap,
    uiFontCn,
    uiFontEn,
    proseFontCn,
    proseFontEn,
    apply,
    setSize,
    setLh,
    setGap,
    setUiFontCn,
    setUiFontEn,
    setProseFontCn,
    setProseFontEn,
  }
})

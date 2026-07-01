// 字体切换（双维度）：appFont（界面字体）+ editorFont（编辑器字体）。
// 模块单例，持久化 localStorage，模块加载即应用到 :root CSS var。
// 字体资源：思源宋体（@fontsource/noto-serif-sc）+ 霞鹜文楷（lxgw-wenkai-webfont）打包，
//   楷体/宋体走系统兜底。main.ts import 字体 css 注册 @font-face；此处只切 family 名。
import { ref } from 'vue'

export interface FontOption {
  id: string
  label: string
  /** CSS font-family 栈（首选打包字体，系统字体兜底） */
  stack: string
}

/** 界面字体（APP 主题字体：按钮/菜单/标签等 UI 文字；UI 用楷体偏花，故默认系统无衬线） */
export const APP_FONTS: FontOption[] = [
  { id: 'system', label: '系统默认', stack: "system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" },
  { id: 'lxgw', label: '霞鹜文楷', stack: "'LXGW WenKai','PingFang SC',sans-serif" },
  { id: 'noto', label: '思源宋体', stack: "'Noto Serif SC','PingFang SC',sans-serif" },
]

/** 编辑器字体（CodeMirror 正文 + chapter-title，文学写作首选楷/宋衬线） */
export const EDITOR_FONTS: FontOption[] = [
  { id: 'kai', label: '楷体（系统）', stack: "'STKaiti','KaiTi','楷体','Songti SC',serif" },
  { id: 'lxgw', label: '霞鹜文楷', stack: "'LXGW WenKai','楷体',serif" },
  { id: 'song', label: '宋体（系统）', stack: "'Songti SC','SimSun','宋体',serif" },
  { id: 'noto', label: '思源宋体', stack: "'Noto Serif SC','Songti SC',serif" },
]

const APP_KEY = 'clw-app-font'
const EDITOR_KEY = 'clw-editor-font'

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

const appFontId = ref<string>(read(APP_KEY, 'system'))
const editorFontId = ref<string>(read(EDITOR_KEY, 'kai'))

function findFont(list: FontOption[], id: string): FontOption {
  return list.find((f) => f.id === id) ?? list[0]!
}

/** 应用到 :root CSS var（界面 --app-font / 编辑器 --prose-font） */
function apply(): void {
  const root = document.documentElement.style
  root.setProperty('--app-font', findFont(APP_FONTS, appFontId.value).stack)
  root.setProperty('--prose-font', findFont(EDITOR_FONTS, editorFontId.value).stack)
}

export function useFont() {
  return {
    appFontId,
    editorFontId,
    appFonts: APP_FONTS,
    editorFonts: EDITOR_FONTS,
    setAppFont(id: string): void {
      appFontId.value = id
      try {
        localStorage.setItem(APP_KEY, id)
      } catch {
        /* localStorage 不可用时仅内存切换 */
      }
      apply()
    },
    setEditorFont(id: string): void {
      editorFontId.value = id
      try {
        localStorage.setItem(EDITOR_KEY, id)
      } catch {
        /* 同上 */
      }
      apply()
    },
  }
}

// 模块加载即应用持久化选择（main.ts import 本模块即触发，CSS var 在渲染前就位）
apply()

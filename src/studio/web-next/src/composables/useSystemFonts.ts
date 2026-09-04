// 系统字体加载（桌面版 IPC）。
// 模块级单例：多个组件共享同一份字体列表，IPC 只调一次。
import { ref, computed, onMounted } from 'vue'
import { usePlatform } from './usePlatform'

const CJK_RE = /[一-鿿㐀-䶿぀-ヿ가-힯]/
// J5：补 Windows 系统中文字体关键词（微软雅黑/宋体/黑体系）——原表全 mac/思源系，
// win 内置字体会被错分进「英文字体」组
const CN_KW =
  /\b(SC|TC|HK|GB|Hans|Hant|Hei|Kai|Heiti|Songti|Kaiti|Yuanti|Libian|Xingkai|Weibei|Baoli|Wawati|Yuppy|Hannotate|HanziPen|Lantinghei|LingWai|FangSong|STHeiti|STSong|STKaiti|STFangsong|STXihei|STXingkai|STXinwei|STHupo|STCaiyun|STZhongsong|Hiragino Sans GB|Source Han Sans|Source Han Serif|Noto Sans SC|Noto Serif SC|Noto Sans CJK|Noto Serif CJK|LXGW WenKai|Microsoft YaHei|SimSun|NSimSun|SimHei|KaiTi|DengXian|YouYuan|LiSu)\b/i
const FONT_CN_LABEL: Record<string, string> = {
  // J5：Windows 内置中文字体中文名
  'Microsoft YaHei': '微软雅黑', 'Microsoft YaHei UI': '微软雅黑',
  SimSun: '宋体', NSimSun: '新宋体', SimHei: '黑体',
  KaiTi: '楷体', FangSong: '仿宋', DengXian: '等线',
  YouYuan: '幼圆', LiSu: '隶书',
  'PingFang SC': '苹方', 'PingFang TC': '苹方', 'PingFang HK': '苹方',
  'Heiti SC': '黑体', 'Heiti TC': '黑体', Hei: '黑体',
  'Songti SC': '宋体', 'Songti TC': '宋体',
  'Kaiti SC': '楷体', 'Kaiti TC': '楷体', Kai: '楷体',
  'Yuanti SC': '圆体', 'Yuanti TC': '圆体',
  'Xingkai SC': '行楷', 'Xingkai TC': '行楷',
  'Weibei SC': '魏碑', 'Weibei TC': '魏碑',
  'Libian SC': '隶变', 'Libian TC': '隶变',
  'Baoli SC': '报隶', 'Baoli TC': '报隶',
  'Yuppy SC': '雅痞', 'Yuppy TC': '雅痞',
  'Wawati SC': '娃娃体', 'Wawati TC': '娃娃体',
  'Hannotate SC': '手札体', 'Hannotate TC': '手札体',
  'HanziPen SC': '汉字笔', 'HanziPen TC': '汉字笔',
  'Lantinghei SC': '兰亭黑', 'Lantinghei TC': '兰亭黑',
  'LingWai SC': '翎外', 'LingWai TC': '翎外',
  'Hiragino Sans GB': '冬青黑体',
  STHeiti: '华文黑体', STSong: '华文宋体', STKaiti: '华文楷体',
  STFangsong: '华文仿宋', STXihei: '华文细黑', STXingkai: '华文行楷',
  STXinwei: '华文新魏', STHupo: '华文琥珀', STCaiyun: '华文彩云',
  STZhongsong: '华文中宋',
  'Source Han Sans SC': '思源黑体', 'Source Han Serif SC': '思源宋体',
  'Noto Sans SC': '思源黑体', 'Noto Serif SC': '思源宋体',
  'Noto Sans CJK SC': '思源黑体', 'Noto Serif CJK SC': '思源宋体',
  'LXGW WenKai': '霞鹜文楷',
}

function isChineseFont(name: string): boolean {
  return CJK_RE.test(name) || CN_KW.test(name) || name in FONT_CN_LABEL
}

function fontDisplayName(name: string): string {
  return FONT_CN_LABEL[name] ?? name
}

// ── 默认字体解析（2026-09-04 作者反馈：字体下拉默认态只显「默认」，看不出默认
// 究竟是什么字体——按 tokens.css 默认栈 + 已安装列表解析成具体字体名展示）──

/** 正文默认栈（tokens.css --prose-font 首选序；与 prefs apply() 的回退栈同源） */
export const PROSE_DEFAULT_STACK = ['LXGW WenKai', 'Noto Serif SC', 'SimSun'] as const
/** 正文回退 CSS 串（prefs apply() 尾基座；由栈派生保同源） */
export const PROSE_FONT_FALLBACK = `${PROSE_DEFAULT_STACK.map((f) => `'${f}'`).join(', ')}, serif`

// UI 默认栈（tokens.css --font-ui 平台块的 CJK/拉丁首选；mac 拉丁 = system-ui
// 无字体名可显，留空由调用方回落旧占位）
const UI_DEFAULT_STACK = {
  win: { cn: ['Microsoft YaHei UI', 'Microsoft YaHei'], en: ['Segoe UI'] },
  mac: { cn: ['PingFang SC', 'Microsoft YaHei'], en: [] as string[] },
} as const

// 模块级单例
const systemFonts = ref<string[]>([])
let fontsLoaded = false

export function useSystemFonts() {
  onMounted(async () => {
    if (fontsLoaded || !window.clwritingDesktop) return
    try {
      systemFonts.value = await window.clwritingDesktop.getSystemFonts()
      fontsLoaded = true
    } catch (e) {
      console.error('加载系统字体失败：', e)
    }
  })

  const chineseFonts = computed(() => systemFonts.value.filter(isChineseFont))
  const englishFonts = computed(() => systemFonts.value.filter((f) => !isChineseFont(f)))

  // 各槽位默认字体名：栈序即优先序，取第一个已安装的；全不在装退栈首（win 系统
  // 必装雅黑/宋体，实际不触达）。列表加载完成前即有栈首可用，加载后按实装收敛。
  const { isWin } = usePlatform()
  function resolveDefault(stack: readonly string[]): string {
    const installed = new Set(systemFonts.value)
    return stack.find((f) => installed.has(f)) ?? stack[0] ?? ''
  }
  const defaultUiFontCn = computed(() => resolveDefault(isWin ? UI_DEFAULT_STACK.win.cn : UI_DEFAULT_STACK.mac.cn))
  const defaultUiFontEn = computed(() => resolveDefault(isWin ? UI_DEFAULT_STACK.win.en : UI_DEFAULT_STACK.mac.en))
  const defaultProseFont = computed(() => resolveDefault(PROSE_DEFAULT_STACK))

  return {
    systemFonts, chineseFonts, englishFonts, fontDisplayName,
    defaultUiFontCn, defaultUiFontEn,
    // 正文栈拉丁字形由 CJK 字体自带（霞鹜/思源含拉丁），中英两槽默认同源
    defaultProseFontCn: defaultProseFont, defaultProseFontEn: defaultProseFont,
  }
}

/** select change 事件取值 */
export function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

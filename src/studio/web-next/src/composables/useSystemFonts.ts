// 系统字体加载（桌面版 IPC）。
// 模块级单例：多个组件共享同一份字体列表，IPC 只调一次。
import { ref, computed, onMounted } from 'vue'

const CJK_RE = /[一-鿿㐀-䶿぀-ヿ가-힯]/
const CN_KW =
  /\b(SC|TC|HK|GB|Hans|Hant|Hei|Kai|Heiti|Songti|Kaiti|Yuanti|Libian|Xingkai|Weibei|Baoli|Wawati|Yuppy|Hannotate|HanziPen|Lantinghei|LingWai|FangSong|STHeiti|STSong|STKaiti|STFangsong|STXihei|STXingkai|STXinwei|STHupo|STCaiyun|STZhongsong|Hiragino Sans GB|Source Han Sans|Source Han Serif|Noto Sans SC|Noto Serif SC|Noto Sans CJK|Noto Serif CJK|LXGW WenKai)\b/i
const FONT_CN_LABEL: Record<string, string> = {
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

  return { systemFonts, chineseFonts, englishFonts, fontDisplayName }
}

/** select change 事件取值 */
export function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

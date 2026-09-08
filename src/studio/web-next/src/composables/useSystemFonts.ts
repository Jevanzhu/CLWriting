// 系统字体加载（桌面版 IPC）。
// 模块级单例：多个组件共享同一份字体列表，IPC 只调一次。
import { ref, computed, onMounted } from 'vue'
import { usePlatform } from './usePlatform'
import { isFontInstalled } from '../shared/font-names'

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
// 2026-09-08 mac 预设批：默认栈/回退尾双平台拆分（此前 win 单栈，mac 上三个 win
// 死名全不命中 → 衬线尾裸落浏览器 serif 兜底、无衬线尾裸落 sans-serif）；平台
// 判定对齐 UI_DEFAULT_STACK 惯例（isWin ? win : mac，浏览器预览态走 mac 观感
// 基准 = tokens.css :root 口径）。

/** 正文默认栈·win（栈序即优先序；win 必装 SimSun 兜底） */
const PROSE_DEFAULT_STACK_WIN = ['LXGW WenKai', 'Noto Serif SC', 'SimSun'] as const
/** 正文默认栈·mac（Songti SC 恒装兜底；霞鹜文楷装了优先） */
const PROSE_DEFAULT_STACK_MAC = ['LXGW WenKai', 'Songti SC'] as const

/** 当前平台正文默认栈（「默认」徽标解析用；与 tokens.css --prose-font 平台块同源） */
export function proseDefaultStack(): readonly string[] {
  return usePlatform().isWin ? PROSE_DEFAULT_STACK_WIN : PROSE_DEFAULT_STACK_MAC
}

/** 正文回退尾·win 衬线基座（prefs apply() 尾基座；与 tokens.css :root 栈同源） */
export const PROSE_FONT_FALLBACK_WIN = `'${PROSE_DEFAULT_STACK_WIN.map((f) => f).join("', '")}', serif`
/** 正文回退尾·mac 衬线基座（与 tokens.css darwin 块 --prose-font 同源） */
export const PROSE_FONT_FALLBACK_MAC = `'${PROSE_DEFAULT_STACK_MAC.map((f) => f).join("', '")}', serif`

/**
 * 无衬线中文回退尾·win（衬线/书卷族之外的中文字体挂此尾——修「选思源黑体预设但未装
 * Noto 时正文静默落宋体」的跨族翻转，F0c② 2026-09-05；win 必装雅黑，实际不触达）。
 */
export const PROSE_FONT_SANS_FALLBACK_WIN = `'Microsoft YaHei', 'DengXian', 'SimHei', sans-serif`
/**
 * 无衬线中文回退尾·mac（2026-09-08）：苹方恒装兜底；-apple-system 居首让拉丁走 SF
 * （mac 无恒装拉丁 UI 字体名，对齐 UI_DEFAULT_STACK.mac.en 留空先例）。
 */
export const PROSE_FONT_SANS_FALLBACK_MAC = `-apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif`

/** 衬线/书卷族关键词：宋/仿宋/楷/明/思源宋/霞鹜文楷等归衬线回退，其余归无衬线。 */
const CN_SERIF_RE =
  /(宋|明|Song|Ming|Serif|SimSun|NSimSun|Kai|楷|FangSong|仿宋|WenKai|Songti|STSong|STKaiti|STFangsong|STZhongsong)/i

/** 中文正文族判定（衬线/书卷 vs 无衬线）——prefs apply() 与测试共用 */
export function isSerifCnFont(name: string): boolean {
  return CN_SERIF_RE.test(name)
}

/**
 * 正文回退尾（prefs apply() 拼 --prose-font）：CN 槽空时维持衬线基座（出厂空槽口径）；
 * 指名中文为衬线/书卷族 → 衬线栈，其余（雅黑/等线/黑体/思源黑/苹方…）→ 无衬线栈。
 * 平台分支（2026-09-08）：两族尾各带 win/mac 双基座，usePlatform 判定（浏览器态走
 * mac 侧，与默认栈同口径）。
 */
export function proseFallbackTail(cnFont: string): string {
  const { isWin } = usePlatform()
  return cnFont && !isSerifCnFont(cnFont)
    ? (isWin ? PROSE_FONT_SANS_FALLBACK_WIN : PROSE_FONT_SANS_FALLBACK_MAC)
    : (isWin ? PROSE_FONT_FALLBACK_WIN : PROSE_FONT_FALLBACK_MAC)
}

/** 拼字体族：英文字体优先（英文片段），中文字体兜底（中文），最后系统 fallback。
 *  含空格的字体名自动加引号。prefs apply() 与设置预览样张共用（单源）。 */
export function buildFontFamily(en: string, cn: string, fallback: string): string {
  const parts: string[] = []
  if (en) parts.push(en.includes(' ') ? `"${en}"` : en)
  if (cn) parts.push(cn.includes(' ') ? `"${cn}"` : cn)
  parts.push(fallback)
  return parts.join(', ')
}

/** 正文 --prose-font 完整拼栈（prefs apply() 与设置预览样张共用，单源）：
 *  英文优先 + 中文 + 按中文族分族的回退尾。 */
export function buildProseFontStack(cn: string, en: string): string {
  return buildFontFamily(en, cn, proseFallbackTail(cn))
}

// UI 默认栈（tokens.css --font-ui 平台块的 CJK/拉丁首选；mac 拉丁 = system-ui
// 无字体名可显，留空由调用方回落旧占位）
const UI_DEFAULT_STACK = {
  win: { cn: ['Microsoft YaHei UI', 'Microsoft YaHei'], en: ['Segoe UI'] },
  mac: { cn: ['PingFang SC', 'Microsoft YaHei'], en: [] as string[] },
} as const

// 模块级单例
const systemFonts = ref<string[]>([])
/** 字表已从主进程回（SettingsEditor 预设「未装」徽标据此判定，避免列表未回时误标） */
const fontsLoaded = ref(false)
let fontsPending: Promise<void> | null = null

function loadOnce(): Promise<void> {
  if (!window.clwritingDesktop) return Promise.resolve()
  if (!fontsPending) {
    // R48-84（四十八轮）：挂载并发去重——原布尔标志在 await 后才置位，两组件
    // 同拍挂载（设置弹窗与外壳同帧消费单例）双双通过入口守卫，getSystemFonts IPC
    // 被并发调两次，违背头注「IPC 只调一次」。改 in-flight promise 去重（对齐 doc
    // store inflightOpens 惯例）；失败清 pending 保留「下次挂载可重试」原语义。
    fontsPending = window.clwritingDesktop
      .getSystemFonts()
      .then((fonts) => {
        systemFonts.value = fonts
        // F 线二批：成功后置响应式标志（未装徽标从「列表未回」翻「真未装」）
        fontsLoaded.value = true
      })
      .catch((e: unknown) => {
        console.error('加载系统字体失败：', e)
        fontsPending = null
      })
  }
  return fontsPending
}

export function useSystemFonts() {
  onMounted(() => {
    void loadOnce()
  })

  const chineseFonts = computed(() => systemFonts.value.filter(isChineseFont))
  const englishFonts = computed(() => systemFonts.value.filter((f) => !isChineseFont(f)))

  // 各槽位默认字体名：栈序即优先序，取第一个已安装的；全不在装退栈首（win 系统
  // 必装雅黑/宋体、mac 必装苹方/宋体-简，实际不触达）。列表加载完成前即有栈首
  // 可用，加载后按实装收敛。
  const { isWin } = usePlatform()
  // F 线④（2026-09-06）：已装判定走族键（zh-cn 枚举中文名/思源双产品异名同族），
  // zh 系统上默认解析不再退栈首、能落到真实渲染的栈成员
  function resolveDefault(stack: readonly string[]): string {
    return stack.find((f) => isFontInstalled(systemFonts.value, f)) ?? stack[0] ?? ''
  }
  const defaultUiFontCn = computed(() => resolveDefault(isWin ? UI_DEFAULT_STACK.win.cn : UI_DEFAULT_STACK.mac.cn))
  const defaultUiFontEn = computed(() => resolveDefault(isWin ? UI_DEFAULT_STACK.win.en : UI_DEFAULT_STACK.mac.en))
  const defaultProseFont = computed(() => resolveDefault(proseDefaultStack()))

  return {
    systemFonts, fontsLoaded, chineseFonts, englishFonts, fontDisplayName,
    defaultUiFontCn, defaultUiFontEn,
    // 正文栈拉丁字形由 CJK 字体自带（霞鹜/思源含拉丁），中英两槽默认同源
    defaultProseFontCn: defaultProseFont, defaultProseFontEn: defaultProseFont,
  }
}

/** select change 事件取值 */
export function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

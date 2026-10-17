/**
 * coverage 入口面与阈值桶单一数据源。
 *
 * vitest.config.ts 直接消费本表；test/governance/coverage-threshold-globs.test.ts 用同一
 * 份数据做「桶 glob 至少命中一个文件 / 入口集无桶外文件 / 数值形状」守护。两处不再各留
 * 一份抄本——键或数值只有这里一处可改，配置与守护门不可能漂移。
 *
 * 维护规则（只紧不松）：
 * - 阈值 = 全量 coverage 实测基线 −2pp 向下取整，只防回退不追高；观测已高于现门时按
 *   同一规则重算，floor(实测−2pp) > 现值才升。
 * - 下调须在批记/注释里留理由（razor 档：实测与现门相差 < 0.35pp 时维持不降）。
 * - 0/0 是显式登记的「e2e 自管」边界，不是放松；出现真单测面时须按实测立非零门。
 * - 新增源码子目录后，须确认它至少命中一个桶（守护测试会点名桶外文件）。
 */

/** coverage 统计入口（.ts + web-next SFC；scripts/ 有意不纳管，由 tsc/eslint/直测覆盖）。 */
export const COVERAGE_INCLUDE = ['src/**/*.ts', 'src/studio/web-next/src/**/*.vue'] as const

/** coverage 排除面（纯类型声明、第三方 .ts、构建引导、AppleDouble 伴生文件）。 */
export const COVERAGE_EXCLUDE = [
  'src/**/*.d.ts',
  '**/node_modules/**',
  '**/._*',
  'src/studio/web-next/vite.config.ts',
  'src/studio/web-next/src/types/tree.ts',
  'src/studio/web-next/src/{main,router}.ts',
] as const

/** 单桶阈值（缺省指标 = 该桶不设该指标门；0 = 显式登记「该面由 e2e 自管」）。 */
export interface CoverageThreshold {
  statements?: number
  branches?: number
  functions?: number
  lines?: number
}

/** 桶序 = 主码单桶 → 域级子桶 → 前端分层窄桶；键集与数值由守护门双向核对。 */
export const COVERAGE_THRESHOLDS: Record<string, CoverageThreshold> = {
  // 主代码单桶：除 web-next 外的全部后端/共享代码，池化口径。
  'src/{!(studio),studio/!(web-next)}/**': { statements: 89, branches: 83, functions: 95, lines: 92 },
  // 主桶之上叠域的域级子桶：匹配多桶的文件须过所有桶（域级基线 + 聚合防回退叠加）。
  'src/ai/**': { statements: 91, branches: 85, functions: 95, lines: 93 },
  'src/events/**': { statements: 93, branches: 90, functions: 98, lines: 95 },
  'src/studio/server/**': { statements: 87, branches: 74, functions: 92, lines: 90 },
  'src/metrics/**': { statements: 91, branches: 80, functions: 95, lines: 97 },
  'src/driver/**': { statements: 95, branches: 92, functions: 98, lines: 97 },
  'src/review/**': { statements: 93, branches: 81, functions: 98, lines: 94 },
  // 后端 15 域：域内单文件腰斩会被主桶池化均值稀释，故逐域立门。
  'src/cache/**': { statements: 91, branches: 82, functions: 95, lines: 93 },
  'src/check/**': { statements: 93, branches: 88, functions: 98, lines: 94 },
  'src/desktop/**': { statements: 87, branches: 79, functions: 87, lines: 90 },
  'src/document/**': { statements: 90, branches: 83, functions: 95, lines: 92 },
  'src/export/**': { statements: 89, branches: 89, functions: 94, lines: 88 },
  'src/format/**': { statements: 94, branches: 92, functions: 97, lines: 95 },
  'src/fs/**': { statements: 93, branches: 89, functions: 98, lines: 93 },
  'src/git/**': { statements: 89, branches: 78, functions: 93, lines: 91 },
  'src/install/**': { statements: 88, branches: 83, functions: 98, lines: 92 },
  'src/knowledge/**': { statements: 90, branches: 86, functions: 98, lines: 90 },
  'src/learn/**': { statements: 94, branches: 71, functions: 93, lines: 94 },
  'src/log/**': { statements: 97, branches: 91, functions: 88, lines: 97 },
  'src/process/**': { statements: 88, branches: 81, functions: 97, lines: 92 },
  'src/rag/**': { statements: 91, branches: 88, functions: 94, lines: 93 },
  'src/state/**': { statements: 91, branches: 85, functions: 95, lines: 93 },
  // 前端 API 层：参数/响应映射逻辑单列，阈值只登记实测可守的 lines/branches。
  'src/studio/web-next/src/api/**': { lines: 91, branches: 88 },
  // 前端聚合桶（components/composables/editor/shared/stores/types 的纯 TS 运行时文件）。
  'src/studio/web-next/src/{components,composables,editor,shared,stores,types}/**': {
    lines: 80,
    branches: 66,
  },
  // views/pages 显影桶：当前 0/0 登记「e2e 自管」；出现真单测面时须按实测立非零门。
  'src/studio/web-next/src/{pages,views}/**': { lines: 0, branches: 0 },
  'src/studio/web-next/src/{pages,views}/{Book,Library,Shelf,AuditView,EditorView,OnboardView,OverviewView,RelationsView,StyleView,WorkbenchView}.vue':
    { lines: 78, branches: 59 },
  'src/studio/web-next/src/{pages,views}/{Welcome,LearnView}.vue': { lines: 98, branches: 98 },
  'src/studio/web-next/src/*.vue': { lines: 96, branches: 88 },
  // 前端纯逻辑层窄桶：域级基线门与聚合桶并存。
  'src/studio/web-next/src/stores/**': { lines: 93, branches: 83 },
  'src/studio/web-next/src/composables/**': { lines: 79, branches: 63 },
  // 运行时入口只在 spawn/挂载路径执行，单测面薄——窄桶防「运行时才炸」的回退。
  'src/**/*-worker.ts': { statements: 98, branches: 98, functions: 98, lines: 98 },
  'src/studio/web-next/src/components/relations/*.vue': { lines: 40, branches: 47 },
  'src/studio/web-next/src/composables/useLibraryIpc.ts': { lines: 98, branches: 98 },
}

/**
 * Vue SFC 类型 shim —— 让根 tsc(不解析 .vue)认 `import X from '*.vue'`。
 *
 * 根 tsconfig exclude src/studio/web(web 用 vue-tsc 单独检),
 * 但 test/ 的前端组件测 import web 的 .vue,需此 shim 避免 tsc 报 TS2307。
 * 实际 .vue 类型由 vue-tsc(web)+ @vue/test-utils 运行时保证。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

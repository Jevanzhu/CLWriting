import { test, expect } from 'vitest'
// R0913 复核批 P1 防复活锚（静态源码守卫,先例同 menu-labels.test.ts）：
// 全局 utilities.css 的 .is-drag 是「真实拖拽容器」专属单类（-webkit-app-region: drag,
// 继承语义）——页面根若用同名类做桌面态标记,会被该规则命中且整页继承成拖拽面,
// 点击被窗口拖拽吞掉（Library/Shelf/Welcome 三页根 P1 修复改名 is-desktop 的由来）。
// app-region 仅 Electron 桌面壳生效、e2e 纯 Chromium 惰性,无运行时门可捕获,只能静态钉。
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(`src/studio/web-next/src/${p}`, 'utf-8')

const PAGES: [string, string, string][] = [
  // [文件, 页根类, 页内标题栏类]
  ['pages/Library.vue', 'library', 'lib-titlebar'],
  ['pages/Shelf.vue', 'shelf', 'shelf-titlebar'],
  ['pages/Welcome.vue', 'welcome', 'welcome-titlebar'],
]

test('三页根桌面态标记 = is-desktop;模板与 scoped 样式零 is-drag 残留', () => {
  for (const [p, cls, titlebar] of PAGES) {
    const src = read(p)
    expect(src, `${p} 模板根应绑 is-desktop`).toContain(`'is-desktop':`)
    expect(src, `${p} 不得再用 is-drag 做页根标记`).not.toContain(`'is-drag'`)
    expect(src, `${p} scoped 后代拖拽选择器应随根类改名`).toContain(`.${cls}.is-desktop .${titlebar}`)
    expect(src, `${p} 不得残留 .is-drag 选择器`).not.toMatch(new RegExp(`\\.${cls}\\.is-drag`))
  }
})

test('四壳层组件仍绑 is-drag(全局单类的合法消费面——本身即拖拽容器、子件 no-drag 齐备)', () => {
  for (const p of [
    'components/shell/SidebarLeft.vue',
    'components/shell/SidebarRight.vue',
    'components/shell/TabBar.vue',
    'components/shell/ViewHeader.vue',
  ]) {
    expect(read(p), `${p} 应保留 is-drag 绑定`).toContain(`'is-drag':`)
  }
})

test('utilities.css 定义 .is-drag 单类、不定义 .is-desktop(两语义不得再合流)', () => {
  const css = read('styles/utilities.css')
  expect(css).toMatch(/^\.is-drag \{/m)
  expect(css).not.toMatch(/^\.is-desktop/m)
})

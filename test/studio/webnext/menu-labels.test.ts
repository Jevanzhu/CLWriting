import { test, expect } from 'vitest'
// 从 ChapterTreePanel.vue 提取的菜单常量逻辑验证（真实文件用 grep 断言）
import { readFileSync } from 'node:fs'

const src = readFileSync('src/studio/web-next/src/components/panels/ChapterTreePanel.vue', 'utf-8')

test('所有新建项 label 带「新建」前缀', () => {
  // 常量里的 label
  expect(src).toContain("label: '新建卷'")
  expect(src).toContain("label: '新建章节'")
  expect(src).toContain("label: '新建章纲'")
  expect(src).toContain("label: '新建卷纲'")
  expect(src).toContain("label: '新建总纲'")
  expect(src).toContain("label: '新建角色'")
  expect(src).toContain("label: '新建物品'")
  expect(src).toContain("label: '新建世界观'")
  expect(src).toContain("label: '新建伏笔'")
  expect(src).toContain("label: '新建文档'")
})

test('所有位置摊开：不再有 新建 ▸ 子菜单包裹', () => {
  // buildMenuItems 里的 submenu 应全部消失（新建类不再缩子菜单）
  // 用「新建」父级定义检查：submenu: [{ key: 'new- 不应出现
  const submenuNew = src.match(/submenu: \[\{ key: 'new-/g)
  expect(submenuNew).toBeNull() // 无新建类子菜单残留
})

test('叶子菜单仍保留操作项（非新建）', () => {
  expect(src).toContain("label: '重命名'")
  expect(src).toContain("label: '删除'")
  expect(src).toContain("label: '章节信息…'")
})

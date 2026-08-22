import { test, expect } from 'vitest'
import {
  chapterTemplate,
  chapterOutlineTemplate,
  volumeOutlineTemplate,
  synopsisTemplate,
  worldviewTemplate,
  characterTemplate,
  itemTemplate,
  foreshadowTemplate,
} from '../../../src/studio/web-next/src/shared/templates'

test('章节模板含完整 front matter（readChapter 可解析）', () => {
  const t = chapterTemplate(3, '风起')
  expect(t).toContain('章号: 3')
  expect(t).toContain('标题: 风起')
  expect(t).toContain('钩子类型: 悬念钩')
  expect(t).toContain('情绪定位: 铺垫')
})

test('章纲/卷纲/角色/物品/伏笔模板骨架', () => {
  expect(chapterOutlineTemplate(2, '初遇')).toContain('## 第2章 初遇')
  expect(volumeOutlineTemplate(1)).toContain('## 第1卷')
  expect(characterTemplate('林晚')).toContain('姓名: 林晚')
  expect(itemTemplate('玉佩')).toContain('名称: 玉佩')
  expect(foreshadowTemplate(5)).toContain('埋设章号: 5')
})

// M-8（第十一轮）：单例模板恢复（createSingleton 供 content）——新建总纲/世界观不再落全空文件
test('总纲/世界观单例模板骨架（M-8：createSingleton 新建供给）', () => {
  expect(synopsisTemplate()).toContain('# 总纲')
  expect(synopsisTemplate()).toContain('## 主线')
  expect(worldviewTemplate()).toContain('# 世界观')
  expect(worldviewTemplate()).toContain('## 规则')
})

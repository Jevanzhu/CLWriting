/**
 * 新建文档模板 —— 右键菜单/TabBar 新建时按类型给初始内容，降低空白页阻力。
 *
 * 设计（context-menu-new-file.md §5）：
 * - 前端组装（`createDoc` 已支持 content 参数），章号/标题在 inline 命名时已知，模板内联。
 * - 章节模板带完整 front matter（章号/标题/钩子/情绪），新建即通过 readChapter 解析，机检不误报。
 * - 章纲/卷纲/总纲/角色/物品/世界观/伏笔给可改骨架，字段留空待填（总纲/世界观为
 *   createSingleton 单例固定路径专用——M-8·第十一轮恢复：骨架模板删除后新建落全空文件，
 *   新书这两文件无处供给骨架）。
 */

/** 正文章节：完整 front matter + 空白正文（对齐 #7 章节元数据 schema）。 */
export function chapterTemplate(章号: number, 标题: string): string {
  return [
    '---',
    `章号: ${章号}`,
    `标题: ${标题}`,
    '钩子类型: 悬念钩',
    '钩子强弱: 中',
    '情绪定位: 铺垫',
    '---',
    '',
    '',
  ].join('\n')
}

/** 章纲：结构化 fm + 场景/情节要点/章尾钩 结构（前端 inline 命名时章号已定） */
export function chapterOutlineTemplate(章号: number, 标题: string): string {
  return [
    '---',
    `章号: ${章号}`,
    `标题: ${标题}`,
    '钩子类型: 悬念钩',
    '钩子强弱: 中',
    '情绪定位: 铺垫',
    '---',
    '',
    `## 第${章号}章 ${标题}`,
    '',
    '### 场景',
    '',
    '',
    '### 情节要点',
    '',
    '',
    '### 章尾钩',
    '',
    '',
  ].join('\n')
}

/** 卷纲：本卷主线/支线/节奏点 结构（卷号从现有卷数推断）。 */
export function volumeOutlineTemplate(卷号: number): string {
  return [
    `## 第${卷号}卷`,
    '',
    '### 本卷主线',
    '',
    '',
    '### 支线',
    '',
    '',
    '### 节奏点',
    '',
    '',
  ].join('\n')
}

/** 总纲：全书大纲骨架（单例文件，固定 大纲/总纲.md，createSingleton 专用）。 */
export function synopsisTemplate(): string {
  return [
    '# 总纲',
    '',
    '## 主题',
    '',
    '',
    '## 主线',
    '',
    '',
    '## 卷目',
    '',
    '',
    '## 风格',
    '',
    '',
  ].join('\n')
}

/** 世界观：地理/势力/规则/历史 骨架（单例文件，固定 设定/世界观.md，createSingleton 专用）。 */
export function worldviewTemplate(): string {
  return [
    '# 世界观',
    '',
    '## 地理',
    '',
    '',
    '## 势力',
    '',
    '',
    '## 规则',
    '',
    '',
    '## 历史',
    '',
    '',
  ].join('\n')
}

/** 角色卡：front matter（姓名/身份/目标/境界/关系）+ 自由描述区。 */
export function characterTemplate(姓名: string): string {
  return [
    '---',
    `姓名: ${姓名}`,
    '身份: ',
    '目标: ',
    '境界: ',
    '关系: ',
    '---',
    '',
    '## 性格',
    '',
    '',
    '## 外貌',
    '',
    '',
    '## 履历',
    '',
    '',
  ].join('\n')
}

/** 物品：front matter（名称/类型/持有者）+ 描述区。 */
export function itemTemplate(名称: string): string {
  return [
    '---',
    `名称: ${名称}`,
    '类型: ',
    '持有者: ',
    '---',
    '',
    '## 描述',
    '',
    '',
    '## 相关剧情',
    '',
    '',
  ].join('\n')
}

/** 伏笔：front matter（类型/状态/埋设章号）+ 内容描述。 */
export function foreshadowTemplate(埋设章号: number): string {
  return [
    '---',
    '类型: 草蛇灰线',
    '状态: 未激活',
    `埋设章号: ${埋设章号}`,
    '---',
    '',
    '### 内容',
    '',
    '',
    '### 预期回收点',
    '',
    '',
  ].join('\n')
}
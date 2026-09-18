/**
 * 0918三轮修复批（G203）回归：`##` 段落标题识别单源（format/section-heading）。
 *
 * 修复前同一正文有两套 `##` 标题识别器且口径分裂：check/count.ts（剥围栏 + 紧排
 * 容忍）与 metrics/short-index.ts collectBodyAnchors（`^##\s+`、无围栏剔除）——
 * 紧排 `##标题`（R26-43 认可的合法形态）在 metrics 侧全量漏识 → 短篇索引假 issue
 * 「正文缺少 ## 段落锚点」、anchoredSetupCount 系统性低估；反向，围栏代码块内的
 * `## 示例` 在 metrics 侧被照收为假锚点虚增。修复后两处消费同一
 * extractSectionHeadings——本文件锚定单源形态本身 + 两侧消费面逐位一致。
 * （check/count.ts 侧语义由其既有测试面守恒，本件不重复盖。）
 * 锚：0918三轮修复批 G203。
 */
import { describe, expect, it } from 'vitest'
import { extractSectionHeadings } from '../../src/format/section-heading.js'
import { collectBodyAnchors } from '../../src/metrics/short-index.js'

describe('G203（0918三轮修复批）：## 标题识别单源', () => {
  it('形态锚定：松排/紧排/全角空格/trim/裸 ## 不计/### 子标题不计/CRLF 容忍', () => {
    const body = [
      '## 开头钩子',
      '##紧排锚点',
      '##　全角空格锚点',
      '##  两端空白应trim  ',
      '##',
      '### 三级子标题',
      '#### 四级',
      '正文段落。',
    ].join('\r\n')
    expect(extractSectionHeadings(body)).toEqual(['开头钩子', '紧排锚点', '全角空格锚点', '两端空白应trim'])
  })

  it('围栏内 ## 不计：``` 开栏内 ~~~ 是内容不闭栏（R28-9 同字符判定），外栏闭合后恢复识别', () => {
    const body = [
      '## 真锚一',
      '```md',
      '## 围栏内示例一',
      '~~~',
      '## 围栏内示例二',
      '~~~',
      '```',
      '## 真锚二',
      '~~~',
      '## tilde 围栏内',
      '~~~',
      '## 闭合后锚点',
    ].join('\n')
    expect(extractSectionHeadings(body)).toEqual(['真锚一', '真锚二', '闭合后锚点'])
  })

  it('两侧消费面同源：collectBodyAnchors 与 extractSectionHeadings 逐位一致（紧排不再漏识）', () => {
    const body = [
      '## 松排锚点',
      '##紧排锚点',
      '```',
      '## 围栏内示例',
      '```',
      '## 尾锚点',
    ].join('\n')
    expect(collectBodyAnchors(body)).toEqual(extractSectionHeadings(body))
    expect(collectBodyAnchors(body)).toEqual(['松排锚点', '紧排锚点', '尾锚点'])
    // 修复前 metrics 侧对紧排形态全量漏识（anchors 空 → 假 issue 面），此处单独钉住
    expect(collectBodyAnchors('##紧排锚点\n正文。')).toEqual(['紧排锚点'])
  })
})

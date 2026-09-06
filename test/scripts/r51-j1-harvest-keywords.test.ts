/**
 * R51-J-1（五十一轮）回归：harvest-corpus 关键词提取与机检 message 模板口径对齐。
 *
 * 修复前（quotedOf 只认「」引号与 `词×N` 两形态）三类采集失真：
 * - style-sentence-overlong / style-parallel-streak 引号内是「截断前缀+省略号」
 *   （`「他沿着城墙走了很久也没有走到…」`）——省略号字面量在正文永不出现，
 *   finalBody.includes 恒 false → 恒判「被改掉」，作者没改的样本全进错桶；
 * - simile-density 的「像…」是模板字面量（message 只报次数不带命中文本）→ 同上；
 * - repeat 类统计消息无任何锚点 → 静默零候选（无从归因）。
 * 修复后：截断前缀剥省略号作锚、simile 用引擎同款 SIMILE_RE 直扫正文取真实短语
 * （按短语逐个判幸存/改掉）、无锚命中按 checkId 人话告警（不设退出码——无锚项
 * 本就不参与幸存者判定，与 R63-14/R34D-31「收割不完整」失败哨兵不同级）。
 * 手法：本目录 harvest-corpus.test.ts 既有 spawnSync tsx 冷启动形态（R62-61 多断言
 * 合并）；版本快照手工落 工作区/.版本/<docId>/<ULID>.md（fm 来源: ai），无 pinned
 * finalize → 幸存者基准退化为现行正文文件（harvest 原口径）。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'

const script = fileURLToPath(new URL('../../scripts/harvest-corpus.ts', import.meta.url))
const repoRoot = join(fileURLToPath(new URL('../../', import.meta.url)))

/** 幸存者基准（现行正文，无 pinned finalize 时 harvest 退化用它）：
 *  保留 16 字超长句原句（> 铁律单句上限 12）、四连「雪落」句首排比（> 排比连续数 2）
 *  与一枚比喻短语——修复后三者的锚都应判「幸存（误报候选）」。 */
const finalBody = [
  '他沿着城墙走了很久也没有走到尽头。',
  '雪落在肩上。雪落在瓦上。雪落在旗上。雪落在剑上。',
  '灯灭了，他握紧手里那封信，纸像蝉翼一样薄。',
].join('')

/** 被检版本快照：基准全文 + 11 枚额外比喻（基准 1 枚共 12 > 阈值 10，点火
 *  simile-density）+ 三连重复句（8-gram 绝对重复量超阈，点火 repeat）。 */
const versionBody =
  finalBody +
  [
    '山像屏风一样立着。云像棉絮一样铺开。风像刀子一样刮过。火像豆子一样亮着。',
    '路像肠子一样绕着。塔像楔子一样钉着。船像叶一样漂着。桥像弓一样弯着。',
    '月像钩一样挂着。星像盐一样撒着。井像眼一样睁着。',
  ].join('') +
  '他大步流星地走了过去。'.repeat(15)

function makeBook(): string {
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '雪泥集')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  mkdirSync(join(root, '工作区', '.版本', 'chap-1'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 雪泥集', '  genre: 玄幻'].join('\n'), 'utf-8')
  // 铁律阈值：点火 style-sentence-overlong（12）与 style-parallel-streak（2）
  writeFileSync(join(root, '文风', '文风铁律.md'), ['# 文风铁律', '', '单句上限字数: 12', '排比连续数: 2', ''].join('\n'), 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-雪夜.md'),
    `---\n章号: 1\n标题: 雪夜\n---\n${finalBody}`,
    'utf-8',
  )
  // 版本快照（origin ai，非 pinned）——被检对象
  writeFileSync(
    join(root, '工作区', '.版本', 'chap-1', '01ARZ3NDEKTSV4RRFFQ69G5FAV.md'),
    `---\n来源: ai\n字数: 900\n---\n${versionBody}`,
    'utf-8',
  )
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-雪夜.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  return root
}

test('R51-J-1: 截断前缀/比喻短语按真实幸存判定 + repeat 无锚命中告警——单次 spawn 多断言', () => {
  const root = makeBook()
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    // 无锚命中只告警不设退出码（退出码哨兵只属 R63-14/R34D-31 的收割失败路径）
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('章快照判定完成')

    const falsePositive = readFileSync(join(root, '工作区', '语料候选', '误报候选.md'), 'utf-8')
    const hit = readFileSync(join(root, '工作区', '语料候选', '命中候选.md'), 'utf-8')

    // 修复前恒判「被改掉」的两类截断前缀锚——剥省略号后按前缀真实幸存 → 误报候选
    expect(falsePositive).toContain('checkId: style-sentence-overlong')
    expect(falsePositive).toContain('checkId: style-parallel-streak')

    // simile 改按 SIMILE_RE 真实短语逐个判定：幸存短语进误报候选、被改短语进命中候选
    //（摘录含前后 50 字上下文窗口，跨短语字样出现属正常，故不做跨桶 not 断言）
    expect(falsePositive).toContain('checkId: simile-density')
    expect(falsePositive).toContain('像蝉翼一样')
    expect(hit).toContain('像屏风一样')

    // repeat 统计消息无锚 → 不再静默零候选，按 checkId 人话告警（stderr）
    expect(r.stderr).toContain('提取不到关键词锚点')
    expect(r.stderr).toContain('repeat×1')
    expect(r.stderr).not.toContain('版本快照判定失败')
    expect(r.stderr).not.toContain('章节解析失败')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)

// 对照臂：无版本快照的干净书 → 零命中零告警，退出码 0 照旧（告警只随真实命中出现）
test('R51-J-1: 干净书零命中 → 无锚点告警不出现', () => {
  const root = join(mkdtempTracked(join(tmpdir(), 'harvest-corpus-')), '净本')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 净本', '  genre: 玄幻'].join('\n'), 'utf-8')
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n雪落在了城墙上。', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'chap-1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )
  try {
    const r = spawnSync('node', ['--import', 'tsx', script, root], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('提取不到关键词锚点')
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
}, 60_000)

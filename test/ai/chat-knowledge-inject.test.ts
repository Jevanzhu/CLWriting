/**
 * 知识层方法论注入单测（0917清库修复批，2026-09-17）。
 *
 * 台账挂账「知识层方法论注入未接线（重评-0916-五轮 P3-13）」转实施：buildChatContext
 * 读 知识层/_manifest.json 的 category='方法论' 条目（≤4 条），经 resolveWithinRoot
 * 防越界（fail-closed）后注入 chat system prompt（单文件 2000 码点帽、全段 6000 码点
 * 帽；段头写明「与本书设定冲突时以设定为准」）。可选增强口径：manifest 缺失/坏形状/
 * 无方法论条目/资产文件缺失一律不注入（undefined），不阻断对话。
 *
 * 本件锁定：注入选取（只取方法论）与双帽、越界跳过、无资产不注入、chatSystem 渲染、
 * files 登记面（进 llm/call promptMeta.files 的「模型可见 ⟺ 已记录」通道）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildChatContext, chatSystem } from '../../src/ai/prompts/chat.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-kb-'))
  dirs.push(root)
  return root
}

/** 写 manifest + 资产文件（target: content）；readKnowledgeManifest 只 parse 不校验字段，
 *  条目补最小合法形状（source/license/sha256）走生产同构形状 */
function seedKnowledge(bookRoot: string, files: Record<string, string>, entries: Array<{ target: string; category?: string }>): void {
  for (const [target, content] of Object.entries(files)) {
    const abs = join(bookRoot, target)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(join(bookRoot, '知识层'), { recursive: true })
  writeFileSync(
    join(bookRoot, '知识层', '_manifest.json'),
    JSON.stringify({
      version: 1,
      generated_at: '2026-09-17T00:00:00.000Z',
      summary: { migrated: 0, deferred: 0, review_assets: 0 },
      entries: entries.map((e) => ({ source: 'seed', license: 'seed', sha256: '0'.repeat(64), ...e })),
    }),
  )
}

describe('知识层方法论注入（buildChatContext）', () => {
  it('只取方法论条目：题材条目不进注入，正文与段头进 system prompt，files 登记注入源', () => {
    const root = makeBook()
    seedKnowledge(
      root,
      {
        '知识层/方法论/节奏三幕.md': '三幕节奏：开头钩子、中段反转、结尾爽点。',
        '知识层/方法论/对话纪律.md': '对话标签占比 < 30%。',
        '知识层/题材/仙侠.md': '仙侠题材套路大全（不应注入）。',
      },
      [
        { target: '知识层/方法论/节奏三幕.md', category: '方法论' },
        { target: '知识层/方法论/对话纪律.md', category: '方法论' },
        { target: '知识层/题材/仙侠.md', category: '题材' },
      ],
    )
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).toContain('## 本书知识层方法论')
    expect(ctx.knowledge).toContain('与本书设定冲突时以设定为准')
    expect(ctx.knowledge).toContain('三幕节奏')
    expect(ctx.knowledge).toContain('对话标签占比')
    expect(ctx.knowledge).not.toContain('仙侠题材套路')
    // files 登记面：两个方法论源文件进 promptFiles 通道（题材不进）
    expect(ctx.files).toEqual(['知识层/方法论/节奏三幕.md', '知识层/方法论/对话纪律.md'])
    // chatSystem 渲染：knowledge 段进 system prompt
    expect(chatSystem(ctx)).toContain('三幕节奏')
  })

  it('双帽生效：单文件超 2000 码点截断、全段 6000 码点处停取（第 4 条起不入）', () => {
    const root = makeBook()
    const long = '长'.repeat(2500)
    seedKnowledge(
      root,
      {
        '知识层/方法论/肥文件.md': long,
        '知识层/方法论/a.md': '甲'.repeat(1800),
        '知识层/方法论/b.md': '乙'.repeat(1800),
        '知识层/方法论/c.md': '丙'.repeat(1800),
        '知识层/方法论/d.md': '丁'.repeat(1800),
      },
      [
        { target: '知识层/方法论/肥文件.md', category: '方法论' },
        { target: '知识层/方法论/a.md', category: '方法论' },
        { target: '知识层/方法论/b.md', category: '方法论' },
        { target: '知识层/方法论/c.md', category: '方法论' },
        { target: '知识层/方法论/d.md', category: '方法论' },
      ],
    )
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    // 单文件帽：肥文件截断（2500 → 2000 + 截断标记）
    expect(ctx.knowledge).toContain('…（超长截断）')
    expect(ctx.knowledge!.length).toBeLessThan(long.length + 6000)
    // 总帽：肥文件 2000 + a/b 1800×2 = 5600，c 再入即 7400 > 6000 → 停取（d 更不取）
    expect(ctx.knowledge).toContain('乙')
    expect(ctx.knowledge).not.toContain('丙')
    expect(ctx.files).toHaveLength(3)
  })

  it('防越界 fail-closed：target 越出书根跳过，不注入也不崩', () => {
    const root = makeBook()
    seedKnowledge(
      root,
      { '知识层/方法论/合法.md': '合法资产。' },
      [
        { target: '../逃逸.md', category: '方法论' },
        { target: '知识层/方法论/合法.md', category: '方法论' },
      ],
    )
    const ctx = buildChatContext(root)
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.knowledge).toContain('合法资产')
    expect(ctx.files).toEqual(['知识层/方法论/合法.md'])
  })

  it('无资产不注入：无 manifest / 无方法论条目 / 目标文件缺失 → knowledge undefined', () => {
    const bare = makeBook()
    expect(buildChatContext(bare).knowledge).toBeUndefined()

    const noMethod = makeBook()
    seedKnowledge(noMethod, { '知识层/题材/都市.md': '都市题材。' }, [{ target: '知识层/题材/都市.md', category: '题材' }])
    expect(buildChatContext(noMethod).knowledge).toBeUndefined()

    const missing = makeBook()
    seedKnowledge(missing, {}, [{ target: '知识层/方法论/不存在.md', category: '方法论' }])
    expect(buildChatContext(missing).knowledge).toBeUndefined()
  })
})

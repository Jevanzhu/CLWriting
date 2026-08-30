/**
 * R63-15：check-knowledge 反向扫描（R62-53 新逻辑）纯函数直测。
 *
 * scanUnregisteredKnowledgeAssets 此前 export 无测试——豁免规则（草稿/README 白名单）
 * 改动只能偶然暴露。本文件锚定：未登记必报、登记不报、两类豁免、知识层目录缺失
 * 返回空、manifest 对象与 entries 数组两种入参形状同口径、rootDir 覆写隔离。
 * R27-135（二十七轮）：扫描面扩到任意扩展名（登记面对非 .md 放行，只认 .md 会让
 * 未登记非 .md 资产两向失明）+ _manifest.json/隐藏文件豁免，导出更名
 * scanUnregisteredKnowledgeAssets（下文既有用例名保留 R63-15 历史称呼）。
 * （check-knowledge.ts 已加直跑守卫，import 无校验/exit 副作用。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanUnregisteredKnowledgeAssets } from '../../scripts/check-knowledge.js'
import type { KnowledgeManifest } from '../../src/knowledge/manifest.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-know-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// entries 形状直接用最小对象（target 字段是唯一被读的键）
const entries = [{ target: '知识层/正式条目.md' }] as never

describe('R63-15：scanUnregisteredKnowledgeAssets 反向扫描直测', () => {
  it('盘上 .md 未登记 → 报相对路径；已登记 → 不报', () => {
    mkdirSync(join(dir, '知识层'), { recursive: true })
    writeFileSync(join(dir, '知识层', '正式条目.md'), '# 已登记')
    writeFileSync(join(dir, '知识层', '野文件.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual(['知识层/野文件.md'])
  })

  it('豁免白名单：文件名含「草稿」或为 README.md 不报（草稿不经版本化、README 为导航）', () => {
    mkdirSync(join(dir, '知识层', '子目录'), { recursive: true })
    writeFileSync(join(dir, '知识层', '机检误报-草稿-2026-08-24.md'), '# 草稿')
    writeFileSync(join(dir, '知识层', 'README.md'), '# 导航')
    writeFileSync(join(dir, '知识层', '子目录', '深层草稿.md'), '# 嵌套豁免')
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual([])
  })

  it('递归子目录全树扫描——嵌套未登记文件以项目根相对路径上报', () => {
    mkdirSync(join(dir, '知识层', 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, '知识层', 'a', 'b', '深处.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, [])).toEqual(['知识层/a/b/深处.md'])
  })

  it('知识层目录不存在 → 空数组（新仓/净仓不误报）', () => {
    expect(scanUnregisteredKnowledgeAssets(dir, entries)).toEqual([])
  })

  it('manifest 对象与 entries 数组两种入参形状同口径（调用点传 report.manifest）', () => {
    mkdirSync(join(dir, '知识层'), { recursive: true })
    writeFileSync(join(dir, '知识层', '野文件.md'), '# 未登记')
    const manifest = { entries: [{ target: '知识层/正式条目.md' }] } as never
    const viaManifest = scanUnregisteredKnowledgeAssets(dir, manifest)
    const viaEntries = scanUnregisteredKnowledgeAssets(dir, entries)
    expect(viaManifest).toEqual(viaEntries)
  })

  it('rootDir 可覆写（默认知识层；直测用它隔离到临时目录——此处验证覆写生效）', () => {
    mkdirSync(join(dir, '其他层'), { recursive: true })
    writeFileSync(join(dir, '其他层', '野文件.md'), '# 未登记')
    expect(scanUnregisteredKnowledgeAssets(dir, [], '其他层')).toEqual(['其他层/野文件.md'])
  })

  // R27-135（二十七轮）：扫描面扩到任意扩展名——登记面（isSafeKnowledgeTarget/
  // validateEntry）对非 .md 放行（只跳过 fm 校验），反向扫描只认 .md 时未登记非 .md
  // 资产两向失明（正向 sha256 有条件、反向捡拾无条件盲区）。豁免：对账单本体
  // _manifest.json、隐藏文件（.DS_Store 等系统/工具噪音）。
  it('R27-135: 非 .md 资产同入反向对账——未登记上报、登记后不报；_manifest.json 与隐藏文件豁免', () => {
    mkdirSync(join(dir, '知识层', '资料包'), { recursive: true })
    writeFileSync(join(dir, '知识层', '图谱.json'), '{}')
    writeFileSync(join(dir, '知识层', '资料包', '图.png'), 'bin')
    writeFileSync(join(dir, '知识层', '_manifest.json'), '{}')
    writeFileSync(join(dir, '知识层', '.DS_Store'), 'bin')
    // 未登记非 .md 资产上报（修复前只捡 .md，两文件双向隐身）；readdir 序不保证，排序后比对
    expect(scanUnregisteredKnowledgeAssets(dir, entries).sort()).toEqual(['知识层/图谱.json', '知识层/资料包/图.png'])
    // 登记后不报（非 .md target 是合法登记面）
    const registered = [{ target: '知识层/图谱.json' }, { target: '知识层/资料包/图.png' }] as never
    expect(scanUnregisteredKnowledgeAssets(dir, registered)).toEqual([])
  })
})

describe('R63-15：真实仓库反向扫描——门禁口径锚定（当前全登记/全豁免）', () => {
  it('仓库根实跑（读真实 _manifest.json）：无未登记 .md（与 npm run check:knowledge 同口径）', () => {
    const rootPath = fileURLToPath(new URL('../../', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(rootPath, '知识层', '_manifest.json'), 'utf8')) as KnowledgeManifest
    // R27-135 扩面后仍须空：仓库 知识层/ 的非 .md 只有 _manifest.json（豁免）与
    // .DS_Store（隐藏豁免）——扩面不得把真实仓门禁打红
    expect(scanUnregisteredKnowledgeAssets(rootPath, manifest)).toEqual([])
  })
})

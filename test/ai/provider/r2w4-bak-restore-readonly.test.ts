/**
 * R2W-4（win 平台专项复审 R2）：providers.json 备份恢复不再用 copyFileSync 覆盖写。
 *
 * 夹具：主文件损坏 + 只读属性（copyFileSync 覆盖写在 win 撞只读 EPERM、posix 撞
 * EACCES——两平台修复前都恢复失败）；修复后「改名留证（win 上对只读属性文件
 * renameSync 实测成功）+ atomicWriteFile 落盘」→ 自愈成功、bak 保留、主文件恢复可解析。
 *
 * A-7（RC 源码重审，Opus-5.5 轮）：本文件的固定点由「rmQuietly 前置（先删主文件）」
 * 迁到「留证改名」——只读主文件自愈后仍在 .corrupt-<ts> 留证（原字节可查），删除降为
 * 改名失败时的退回口径。
 */
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import { loadProviders, saveProviders, emptySettings } from '../../../src/ai/provider/store.js'

describe('providers bak 自愈对只读主文件（R2W-4）', () => {
  it('主文件损坏且只读 → loadProviders 自愈成功（bak 字节落位、bak 保留）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'clw-r2w4-bak-'))
    try {
      // 两笔 save：主文件在位 + 写前备份生成 providers.bak.json
      // 0918独立重评修复批（D002）：saveProvidersLocked 写前有 revision 基线复验——
      // 第二笔改用同一 store 实例（首写后 store.revision 已同步 +1，基线与盘一致）；
      // 此前两笔各自 emptySettings()（基线恒 0）在新闸下会判基线漂移被拒
      const seed = emptySettings()
      saveProviders(dir, seed)
      saveProviders(dir, seed)
      const fp = join(dir, 'providers.json')
      const bakFp = join(dir, 'providers.bak.json')
      expect(existsSync(bakFp)).toBe(true)

      // 主文件改坏 + 只读属性（修复前 copyFileSync 对只读目标两平台都失败）
      writeFileSync(fp, '{oops-not-json', 'utf-8')
      chmodSync(fp, 0o444)

      const loaded = loadProviders(dir)
      expect(loaded.providers).toEqual([])

      // 主文件已恢复为合法 JSON 且不再只读（后续 save 可写）
      const restored = JSON.parse(readFileSync(fp, 'utf-8'))
      expect(restored).toBeTypeOf('object')
      expect(existsSync(bakFp)).toBe(true)

      // A-7：损坏且只读的主文件被改名留证（而非删除），原字节可查；原名是新文件
      const siblings = readdirSync(dir).filter((n) => n.startsWith('providers.json.corrupt-'))
      expect(siblings).toHaveLength(1)
      expect(readFileSync(join(dir, siblings[0]!), 'utf-8')).toBe('{oops-not-json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * R0912-3（2026-09-12 全量重评 #41）回归：knowledge-commit 错误文案区分两态。
 *
 * 修复前：登记已成功写入 manifest、但 manifest 存预存坏行使尾部对账失败时，CLI 仍报
 * 「manifest 未写入有效状态」——作者按提示重试只会撞「已在 manifest」自相矛盾。
 * 修后两态区分：判重拒绝/manifest 查无本 target ⇒ 维持原文案；登记已落盘 ⇒ 改报
 * 「登记已写入…预存坏行、请先修 manifest」。退出码恒 1 不变。
 * 手法：scripts/knowledge-commit.ts 的 root 取 import.meta.url 父目录（硬接线仓库根），
 * 无法对 tmp 根直跑——本文件建沙箱（拷脚本 + symlink src → 仓库 src；win 无 symlink
 * 权限按 r71 先例 skipIf，语义由 mac/linux CI 腿覆盖）使 root 指向沙箱，两态 + 干净
 * 路径全链实测；真实 知识层/_manifest.json 零触碰。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const script = fileURLToPath(new URL('../../scripts/knowledge-commit.ts', import.meta.url))

/** 沙箱：root=沙箱根（脚本 import.meta.url 的父目录），src 经 symlink 复用仓库实现 */
function setup(entries: unknown[]): string {
  const sandbox = mkdtempTracked(join(tmpdir(), 'r0912-kc-'))
  symlinkSync(join(repoRoot, 'src'), join(sandbox, 'src'), 'dir')
  mkdirSync(join(sandbox, 'scripts'), { recursive: true })
  cpSync(script, join(sandbox, 'scripts', 'knowledge-commit.ts'))
  mkdirSync(join(sandbox, '知识层'), { recursive: true })
  writeFileSync(
    join(sandbox, '知识层', '_manifest.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-09-12T00:00:00.000+08:00',
        summary: { migrated: 0, deferred: 0, review_assets: 0 },
        entries,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
  writeFileSync(join(sandbox, '知识层', '定稿-试.md'), '# 定稿内容', 'utf-8')
  return sandbox
}

function run(sandbox: string) {
  return spawnSync('node', ['--import', 'tsx', join(sandbox, 'scripts', 'knowledge-commit.ts'), '知识层/定稿-试.md'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  })
}

test.skipIf(process.platform === 'win32')(
  'R0912-3: 登记已写入但 manifest 存预存坏行 → 报「登记已写入…预存坏行」不再报「未写入」（退出码仍 1）',
  () => {
    const sandbox = setup([null])
    const r = run(sandbox)
    expect(r.status).toBe(1)
    // 两态新文案：登记实态如实（旧矛盾——按「未写入」提示重试只会撞「已在 manifest」——不再出现）
    expect(r.stderr).toContain('登记已写入 manifest')
    expect(r.stderr).toContain('预存坏行')
    expect(r.stderr).not.toContain('manifest 未写入有效状态')
    // 明细照列（预存坏行由校验器上报）
    expect(r.stderr).toContain('存在坏形状条目')
    // 登记确实落盘（新条目已在沙箱 manifest 里）
    const written = JSON.parse(readFileSync(join(sandbox, '知识层', '_manifest.json'), 'utf-8')) as {
      entries: Array<{ target?: string } | null>
    }
    expect(written.entries.some((e) => e !== null && e.target === '知识层/定稿-试.md')).toBe(true)
  },
  60_000,
)

test.skipIf(process.platform === 'win32')(
  'R0912-3: 重试撞判重拒绝 → 维持「manifest 未写入」原文案 + 已在 manifest 明细（退出码仍 1）',
  () => {
    const sandbox = setup([null])
    run(sandbox) // 首跑：登记已写入（预存坏行态）
    const r2 = run(sandbox) // 重试：判重拒绝（登记面未写入任何东西）
    expect(r2.status).toBe(1)
    expect(r2.stderr).toContain('manifest 未写入有效状态')
    expect(r2.stderr).toContain('已在 manifest')
    expect(r2.stderr).not.toContain('登记已写入')
  },
  60_000,
)

test.skipIf(process.platform === 'win32')('R0912-3: 干净 manifest → 成功文案不变、退出码 0（防两态区分误伤成功路径）', () => {
  const sandbox = setup([])
  const r = run(sandbox)
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('已登记：知识层/定稿-试.md')
  expect(r.stderr).toBe('')
}, 60_000)

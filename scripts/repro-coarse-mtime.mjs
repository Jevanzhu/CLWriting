#!/usr/bin/env node
/**
 * 低精度 mtime 卷「同尺寸改写 → 指纹缓存陈旧命中」后果链复现/取证脚本。
 *
 * 需真低精度卷（mac: hdiutil MS-DOS；或 FAT/exFAT/SMB），**不入 CI**——挂卷不可移植。
 *
 * 被测对象是仓库**真实**指纹缓存代码路径：document/manifest.ts 的文档清单 stat 指纹缓存
 * 与 document/trash.ts 的回收站清单 stat 指纹缓存（两者签名同为 `size:mtimeNs`，同为
 * fs/mtime-precision.ts 的 isCoarseMtimeNs 消费方）。现象链：
 *   FAT/exFAT/SMB 时间戳粒度粗于毫秒（FAT 2s）→ 同尺寸改写落在粗粒度窗口内 →
 *   mtimeNs 与 size 全同 → 指纹签名不变 → 缓存陈旧命中 → 读到旧内容/旧表
 *   （RMW 场景即以此旧表整文件回写、静默回滚外部修改）。
 * 降级判据（isCoarseMtimeNs 为真 → stat 签名返 null → get/set 两侧均绕缓存）闭合该链。
 *
 * 用法（mac 造 FAT 卷）：
 *   hdiutil create -size 8m -fs MS-DOS -volname CLWFAT /tmp/clw-fat.dmg
 *   hdiutil attach -nobrowse -mountpoint /tmp/clw-fat-mnt /tmp/clw-fat.dmg
 *   node --import tsx scripts/repro-coarse-mtime.mjs                        # 降级生效 → 期望 no-stale-hit
 *   CLW_BYPASS_COARSE=1 node --import tsx scripts/repro-coarse-mtime.mjs    # 降级短路 → 期望 stale-hit
 *   hdiutil detach /tmp/clw-fat-mnt && rm -f /tmp/clw-fat.dmg
 *
 * 输出判据：各链各自打印 stale-hit / no-stale-hit；与当前模式期望值不符则退出码 1。
 *
 * 不改生产代码：CLW_BYPASS_COARSE=1 时经 node:module registerHooks 把
 * src/fs/mtime-precision.ts 重定向到一份临时模块（isCoarseMtimeNs 恒 false，等价降级判据
 * 短路），被测的 manifest/trash 代码路径逐位不变；临时模块落 os.tmpdir()，退出即弃。
 *
 * 「外部改写」刻意经子进程 fs.writeFileSync 直写，绕开 writeManifest/writeTrashManifest
 * 的写侧主动清缓存（e64 双保险）——复现的是「他进程/外部编辑器改清单」这一真实触发面。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MS_NS = 1_000_000n
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const mnt = process.env.CLW_REPRO_MNT ?? '/tmp/clw-fat-mnt'
const bypass = process.env.CLW_BYPASS_COARSE === '1'

// ── 降级判据短路（仅本地取证用；不落生产代码）────────────────
if (bypass) {
  const dir = mkdtempSync(join(tmpdir(), 'clw-repro-coarse-'))
  const overridePath = join(dir, 'mtime-precision-bypass.ts')
  writeFileSync(
    overridePath,
    '// repro-coarse-mtime 运行时覆盖：降级判据恒 false（等价 E1 前）。不属生产代码。\n' +
      'export function isCoarseMtimeNs(): boolean {\n  return false\n}\n',
  )
  const overrideUrl = pathToFileURL(overridePath).href
  registerHooks({
    resolve(spec, ctx, next) {
      const r = next(spec, ctx)
      if (r.url && r.url.endsWith('/src/fs/mtime-precision.ts')) return { ...r, url: overrideUrl, shortCircuit: true }
      return r
    },
  })
}

const mtimePrecision = await import(pathToFileURL(join(repoRoot, 'src/fs/mtime-precision.ts')).href)
const manifestMod = await import(pathToFileURL(join(repoRoot, 'src/document/manifest.ts')).href)
const trashMod = await import(pathToFileURL(join(repoRoot, 'src/document/trash.ts')).href)

const log = (...a) => console.log(...a)
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])

/** 他进程同尺寸改写（子进程直写，绕开写侧清缓存）。返回写后 stat。 */
function externalRewrite(filePath, content) {
  const code =
    'const fs=require("node:fs");const [p,c]=process.argv.slice(1);' +
    'fs.writeFileSync(p,c);const s=fs.statSync(p,{bigint:true});' +
    'process.stdout.write(JSON.stringify({size:String(s.size),mtimeNs:String(s.mtimeNs)}))'
  const out = execFileSync(process.execPath, ['-e', code, filePath, content], { encoding: 'utf-8' })
  return JSON.parse(out)
}

/** 对齐到 2s 桶起点附近，让「写→改写」两笔大概率落同一个 FAT 2s 桶。 */
function alignToBucket() {
  const rem = 2 - ((Date.now() / 1000) % 2)
  if (rem < 1.0) sleep(Math.round((rem + 0.1) * 1000))
}

// ── 卷前提：真低精度 ─────────────────────────────
{
  const probe = join(mnt, 'clw-repro-probe.txt')
  const A = 'AAAAAAAAAA'
  const B = 'BBBBBBBBBB'
  writeFileSync(probe, A)
  const s1 = statSync(probe, { bigint: true })
  externalRewrite(probe, B)
  const s2 = statSync(probe, { bigint: true })
  rmSync(probe, { force: true })
  log(`[卷前提] mount=${mnt}`)
  log(`  探针 size ${s1.size}→${s2.size}；mtimeNs ${s1.mtimeNs}→${s2.mtimeNs}`)
  log(`  mtimeNs 整毫秒对齐 = ${s1.mtimeNs % MS_NS === 0n}；同尺寸改写后 mtimeNs 不变 = ${s1.mtimeNs === s2.mtimeNs}`)
  log(
    `  生产判据 isCoarseMtimeNs(mtimeNs) = ${mtimePrecision.isCoarseMtimeNs(s1.mtimeNs)}${bypass ? '  ← 已短路' : ''}`,
  )
  if (!(s1.mtimeNs % MS_NS === 0n)) {
    log(`\n卷不是低精度时间戳面（挂载点 ${mnt}）——本复现须 FAT/exFAT/SMB。退出。`)
    process.exit(2)
  }
}

const scratch = join(mnt, 'clw-repro')
rmSync(scratch, { recursive: true, force: true })

/** 一条链 = 建档 → 预热缓存 → 他进程同尺寸改写 → 重读，比对是否命中旧值。
 *  windowHit=false 表示两笔写跨了粗粒度桶（前提不成立，本次结果丢弃重试）。 */
function runChain({ name, filePath, setup, primeRead, readBack, oldValue, newValue }) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    alignToBucket()
    rmSync(filePath, { force: true })
    mkdirSync(dirname(filePath), { recursive: true })
    const before = setup()
    primeRead() // 预热缓存（此刻签名 = before 的 size:mtimeNs）
    const after = externalRewrite(filePath, newValue)
    if (after.size !== String(before.size) || after.mtimeNs !== String(before.mtimeNs)) continue // 跨桶，重试
    const seen = readBack()
    const stale = seen === oldValue
    log(
      `[${name}] 第 ${attempt} 次：同尺寸改写 size=${before.size} 不变、mtimeNs=${before.mtimeNs} 不变（粗粒度窗口内）`,
    )
    log(
      `  重读得到 = ${JSON.stringify(seen)}；期望旧值(命中旧缓存) = ${JSON.stringify(oldValue)}，新值(重读正确) = ${JSON.stringify(newValue)}`,
    )
    log(`  判定：${stale ? 'stale-hit（陈旧命中，读到旧内容/旧表）' : 'no-stale-hit（重读正确）'}`)
    return { stale }
  }
  log(`[${name}] 5 次尝试均跨粗粒度桶，未能构造陈旧窗`)
  return { stale: null }
}

const results = []

// ── 链 1：document/manifest.ts 文档清单指纹缓存 ──────────────
{
  const bookRoot = join(scratch, 'book-manifest')
  const mPath = manifestMod.manifestPathOf(bookRoot)
  const id = 'doc_repro_1'
  const oldTag = '初稿'
  const newTag = '改稿'
  const entry = (tag) => ({ id, nodeType: 'document', path: '正文/第一章.md', parentId: null, tags: [tag] })
  const text = (tag) => `${JSON.stringify({ version: 1, type: 'header' })}\n${JSON.stringify(entry(tag))}\n`
  const r = runChain({
    name: '链1 manifest',
    filePath: mPath,
    setup: () => {
      manifestMod.writeManifest(mPath, { version: 1, entries: new Map([[id, entry(oldTag)]]) })
      return statSync(mPath, { bigint: true })
    },
    primeRead: () => {
      const m = manifestMod.readManifestStrict(mPath)
      if (m.entries.get(id)?.tags?.[0] !== oldTag) throw new Error('预热读未拿到旧值')
    },
    readBack: () => manifestMod.readManifestStrict(mPath).entries.get(id)?.tags?.[0] ?? null,
    oldValue: oldTag,
    newValue: text(newTag),
  })
  results.push({ name: 'manifest(readManifestStrict)', ...r })
}

// ── 链 2：后果面——陈旧命中后的 RMW 整文件回写把外部修改静默回滚 ──
// 链 1 只证「读到旧值」；本条把危害显形：调用方按读到（陈旧）的表做一次 RMW
// （此处给同一 id 补一个 order），writeManifest 整文件重写 → 外部那次同尺寸改
// 被静默吞掉（回滚）。降级生效后读到新表，外部修改随 RMW 保住。
{
  const bookRoot = join(scratch, 'book-rmw')
  const mPath = manifestMod.manifestPathOf(bookRoot)
  const id = 'doc_repro_3'
  const entry = (tag) => ({ id, nodeType: 'document', path: '正文/第一章.md', parentId: null, tags: [tag] })
  const rawTags = () => {
    for (const line of readFileSync(mPath, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      const o = JSON.parse(t)
      if (o.id === id) return o.tags?.[0] ?? null
    }
    return null
  }
  const newContent = `${JSON.stringify({ version: 1, type: 'header' })}\n${JSON.stringify(entry('改稿'))}\n`
  let verdict = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    alignToBucket()
    rmSync(mPath, { force: true })
    mkdirSync(dirname(mPath), { recursive: true })
    manifestMod.writeManifest(mPath, { version: 1, entries: new Map([[id, entry('初稿')]]) })
    const before = statSync(mPath, { bigint: true })
    manifestMod.readManifestStrict(mPath) // 预热缓存
    const after = externalRewrite(mPath, newContent)
    if (after.size !== String(before.size) || after.mtimeNs !== String(before.mtimeNs)) continue
    // 模拟调用方的 RMW：读（走缓存）→ 补 order → 整文件写回
    const m = manifestMod.readManifestStrict(mPath)
    const e = m.entries.get(id)
    e.order = 7
    manifestMod.writeManifest(mPath, m)
    const survived = rawTags() === '改稿' // 盘上真值（裸读，绕缓存）
    verdict = survived
    log(`[链2 RMW 后果] 第 ${attempt} 次：改前 tags=初稿（缓存），外部已同尺寸改到 tags=改稿`)
    log(
      `  一次 RMW 后盘上 tags = ${JSON.stringify(rawTags())} → 外部修改${survived ? '保住（no-stale-hit）' : '被静默回滚（stale-hit 后果）'}`,
    )
    break
  }
  if (verdict === null) log('[链2 RMW 后果] 5 次尝试均跨粗粒度桶，未能构造陈旧窗')
  // 后果面向：降级生效时外部修改须保住；短路时须被回滚
  results.push({ name: 'manifest(RMW 回滚后果)', stale: verdict === null ? null : !verdict })
}

// ── 链 3：document/trash.ts 回收站清单指纹缓存 ──────────────
{
  const bookRoot = join(scratch, 'book-trash')
  const tPath = join(bookRoot, trashMod.TRASH_DIR_REL, '.trash-manifest.jsonl')
  const oldPathRel = '正文/甲.md'
  const newPathRel = '正文/乙.md'
  const entry = (orig) => ({
    id: 'doc_repro_2',
    originalPath: orig,
    trashedPath: '工作区/.trash/doc_repro_2-甲.md',
    trashedAt: '2026-10-17T00:00:00.000Z',
    role: 'discard',
  })
  const text = (orig) => `${JSON.stringify(entry(orig))}\n`
  const r = runChain({
    name: '链3 trash',
    filePath: tPath,
    setup: () => {
      // 真 API 建条目（写侧会清缓存，故随后显式预热一次）
      trashMod.appendTrashEntry(bookRoot, entry(oldPathRel))
      return statSync(tPath, { bigint: true })
    },
    primeRead: () => {
      const e = trashMod.readTrashManifestStrict(bookRoot)
      if (e[0]?.originalPath !== oldPathRel) throw new Error('预热读未拿到旧值')
    },
    readBack: () => trashMod.readTrashManifestStrict(bookRoot)[0]?.originalPath ?? null,
    oldValue: oldPathRel,
    newValue: text(newPathRel),
  })
  results.push({ name: 'trash(readTrashManifestStrict)', ...r })
}

rmSync(scratch, { recursive: true, force: true })

// ── 汇总 ─────────────────────────────────────
const expectStale = bypass
log(
  `\n模式：isCoarseMtimeNs ${bypass ? '已短路（等价 E1 前）→ 期望各链均 stale-hit' : '生效（E1 后现状）→ 期望各链均 no-stale-hit'}`,
)
let ok = true
for (const r of results) {
  const pass = r.stale === expectStale
  if (!pass) ok = false
  log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.stale === null ? '未构造出窗口' : r.stale ? 'stale-hit' : 'no-stale-hit'}`,
  )
}
log(ok ? '\n结论：与期望一致。' : '\n结论：与期望不符（见上）。')
process.exit(ok ? 0 : 1)

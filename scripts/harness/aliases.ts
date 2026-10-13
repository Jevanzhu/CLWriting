/**
 * Language contract for Agent Notes: canonical heading names per language,
 * counterpart naming, and the language switcher. The tree, format, and archive
 * gates share this table; headings are compared through slots, never as literal
 * strings across languages.
 *
 * A note's primary file is `yyyy-mm-dd-topic.md`, written in the repository's
 * primary language (`.agents/notes/harness.json`, default `en`). A counterpart
 * is `yyyy-mm-dd-topic.<locale>.md` for the other language. The tier suffix
 * names the file's own language, so `.en.md` in an English-primary repository is
 * not a counterpart but a misnamed primary file.
 */

/** A language an Agent Note may be written in. */
export type Locale = 'en' | 'zh'

/** A skeleton section, language-neutral. */
export type SectionSlot =
  | 'problem' | 'proposal' | 'decision' | 'alternatives'
  | 'acceptance' | 'risks' | 'consequences'
  // Proposal-era headings, named so the gate can report them by slot in `implemented/`.
  | 'plan' | 'migration' | 'testing' | 'verification' | 'deferred' | 'related'

/** Locales a note may be written in. */
export const LOCALES: readonly Locale[] = ['en', 'zh']

/**
 * Canonical heading for every slot, per language. The Chinese names follow the
 * normative ones in the upstream `README.zh.md`; `## 后果` renders what English
 * calls Consequences, which carries the cost and the gain together.
 */
const SLOT_HEADINGS: Record<SectionSlot, Record<Locale, string>> = {
  problem: { en: 'Problem', zh: '问题' },
  proposal: { en: 'Proposal', zh: '提案' },
  decision: { en: 'Decision', zh: '决策' },
  alternatives: { en: 'Alternatives considered', zh: '曾考虑的替代方案' },
  acceptance: { en: 'Acceptance criteria', zh: '验收标准' },
  risks: { en: 'Risks', zh: '风险' },
  consequences: { en: 'Consequences', zh: '后果' },
  plan: { en: 'Plan', zh: '计划' },
  migration: { en: 'Migration plan', zh: '迁移计划' },
  testing: { en: 'Testing', zh: '测试' },
  verification: { en: 'Verification', zh: '验证' },
  deferred: { en: 'Deferred', zh: '推迟工作' },
  related: { en: 'Related', zh: '相关' },
}

/** The `## ` heading a slot must carry in `locale`. */
export function headingFor(slot: SectionSlot, locale: Locale): string {
  return `## ${SLOT_HEADINGS[slot][locale]}`
}

/** The slot a `## ` heading names in `locale`; undefined for bespoke headings. */
export function slotOf(heading: string, locale: Locale): SectionSlot | undefined {
  for (const [slot, rows] of Object.entries(SLOT_HEADINGS) as Array<[SectionSlot, Record<Locale, string>]>) {
    if (heading === `## ${rows[locale]}`) return slot
  }
  return undefined
}

/** Whether a heading carries any canonical name in either language. */
export function anyCanonicalHeading(heading: string): boolean {
  return slotOf(heading, 'en') !== undefined || slotOf(heading, 'zh') !== undefined
}

/** The other language of a pair. */
export function otherLocale(locale: Locale): Locale {
  return locale === 'en' ? 'zh' : 'en'
}

/**
 * Split a note filename into its extension-free stem and optional tier.
 * `yyyy-mm-dd-topic.zh.md` and `yyyy-mm-dd-topic.en.md` are tiered (the tier is
 * the file's own language); `yyyy-mm-dd-topic.md` is the primary file.
 */
export function splitTier(name: string): { stem: string; tier: Locale | undefined } {
  for (const tier of LOCALES) {
    const suffix = tierSuffix(tier)
    if (name.endsWith(suffix)) return { stem: name.slice(0, -suffix.length), tier }
  }
  return { stem: name.endsWith('.md') ? name.slice(0, -3) : name, tier: undefined }
}

/** The filename suffix marking a file written in `locale`. */
export function tierSuffix(locale: Locale): string {
  return `.${locale}.md`
}

/** The consistency record's filename suffix. */
export const SIDECAR_SUFFIX = '.i18n.yaml'

/**
 * The consistency record's filename for a note: `yyyy-mm-dd-topic.i18n.yaml`.
 * Active pairs use the section-keyed record; archiving rewrites it to the
 * whole-file blob record the archive gate seals.
 */
export function sidecarName(name: string): string {
  return `${splitTier(name).stem}${SIDECAR_SUFFIX}`
}

/** The language switcher's plain-text label per language. */
const SWITCHER_LABEL: Record<Locale, string> = { en: 'English', zh: '中文' }

/**
 * Line 5 of a paired note: the file's own language as plain text, the
 * counterpart as a relative link under its language name. The upstream corpus
 * writes `English | [中文](x.zh.md)` in English files and
 * `[English](x.md) | 中文` in Chinese ones; this renders the same shapes from
 * the pair's configuration instead of hardcoding which side is Chinese.
 */
export function switcherLine(own: Locale, counterpartFile: string): string {
  const counterpart = `[${SWITCHER_LABEL[otherLocale(own)]}](${counterpartFile})`
  return own === 'en'
    ? `${SWITCHER_LABEL.en} | ${counterpart}`
    : `${counterpart} | ${SWITCHER_LABEL.zh}`
}

/** The row-1 title prefix. It stays constant across languages so structure is language-independent. */
export const TITLE_PREFIX = '# Agent Note: '

/** Required slots per lifecycle, beyond the universal `problem` opener. */
export const REQUIRED_SLOTS: Record<string, readonly SectionSlot[]> = {
  proposed: ['proposal', 'acceptance', 'risks'],
  implemented: ['decision', 'consequences'],
  rejected: ['proposal'],
}

/** Slots that mark an `implemented/` note as unwritten proposal-era text. */
export const PROPOSAL_ERA_SLOTS: readonly SectionSlot[] = ['proposal', 'plan', 'migration', 'acceptance']

/**
 * Minimal frontmatter reader for the bundled `SKILL.md`.
 *
 * Only the top-level scalar fields the skill registry needs are read; nested
 * blocks and comments are skipped. Keeping this dependency-free means the
 * bundle has no runtime dependencies at all, so it installs from npm or a git
 * checkout without a build step or a pnpm build allowance.
 *
 * @module cua-computer-use/frontmatter
 */

/** Matches a leading `---` fenced block. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Split a Markdown document into its top-level frontmatter scalars and body.
 *
 * @param {string} markdown - the raw document.
 * @returns {{ attributes: Record<string, string>, body: string }} parsed parts.
 */
export function parseFrontmatter(markdown) {
  const match = FRONTMATTER.exec(markdown)
  if (!match) return { attributes: {}, body: markdown }

  /** @type {Record<string, string>} */
  const attributes = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) continue
    const line = rawLine.replace(/\s+#.*$/, '')
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!key || !value) continue
    const unquoted = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
    attributes[key] = unquoted
  }

  return { attributes, body: markdown.slice(match[0].length) }
}

/**
 * cua-computer-use — wire the Cua Driver MCP server into DeepSeek Harness.
 *
 * The plugin itself owns no automation code. It resolves the `cua-driver`
 * executable to an absolute path and publishes it as the `cuaComputerUse`
 * service; the companion row in `cordis.patch.yml` hands that path to the
 * in-box `@deepseek-ai/dsh-mcp-client`, which starts `cua-driver mcp` and
 * registers every advertised tool as `mcp__cua-driver__<name>`.
 *
 * Resolving an absolute path is the whole point. The desktop host is started by
 * launchd, whose `PATH` omits `~/.local/bin` — exactly where the Cua Driver
 * installer puts the binary — so a bare `cua-driver` in the MCP row would fail
 * to spawn. See `lib/locate.js` for the search order.
 *
 * @module cua-computer-use
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { parseFrontmatter } from './lib/frontmatter.js'
import { locateCuaDriver, missingBinaryMessage } from './lib/locate.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(ROOT, 'skill')
const SKILL_NAME = 'cua-computer-use'
const LOG_PREFIX = `[${SKILL_NAME}]`

/** Cordis plugin name used by loader diagnostics. */
export const name = SKILL_NAME

/** This plugin provides a service and requires none. */
export const inject = []

/**
 * Effective defaults. They are declared twice on purpose: `Config` documents
 * them for the profile schema, while the constructor re-applies them because a
 * row mounted from a hand-written patch need not pass through validation.
 */
const DEFAULTS = {
  command: '',
  args: ['mcp'],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 120_000,
  skill: true,
  prompt: true,
}

/**
 * Standing note so the model reaches for these tools without being told the
 * word "computer use". Kept short: the long workflow lives in the skill.
 */
const PROMPT_TEXT = [
  'Native desktop applications are driven through the `mcp__cua-driver__*` tools supplied by the cua-computer-use plugin.',
  'Typical loop: `list_windows` or `launch_app` for a window id, `get_window_state` to read the accessibility tree, then `click`/`type_text`/`set_value` on a fresh `element_token`, and `verify_state` or a new snapshot to confirm.',
  'Prefer stable structured state over pixel coordinates, and re-read after every action that changes the window.',
].join(' ')

export const Config = Schema.object({
  command: Schema.string()
    .default(DEFAULTS.command)
    .description('Explicit cua-driver executable. Empty auto-discovers the installed binary.'),
  args: Schema.array(Schema.string())
    .default(DEFAULTS.args)
    .description('Arguments passed to the executable. The MCP server is `cua-driver mcp`.'),
  env: Schema.dict(Schema.string())
    .default(DEFAULTS.env)
    .description('Extra environment variables merged into the MCP child process.'),
  cwd: Schema.string()
    .default(DEFAULTS.cwd)
    .description('Working directory for the MCP child process. Empty inherits the host directory.'),
  toolCallTimeoutMs: Schema.number()
    .default(DEFAULTS.toolCallTimeoutMs)
    .description('Per-call timeout in milliseconds. The default is generous because GUI waits and cold daemon starts are slow.'),
  skill: Schema.boolean()
    .default(DEFAULTS.skill)
    .description('Register the bundled DSH skill describing the accessibility-first workflow.'),
  prompt: Schema.boolean()
    .default(DEFAULTS.prompt)
    .description('Add a short standing note about these tools to the system prompt.'),
})

/**
 * Read the packaged skill body and its routing metadata.
 *
 * @returns {{ name: string, description: string, whenToUse?: string, content: string, path: string }} the parsed skill.
 */
function readBundledSkill() {
  const path = join(SKILL_DIR, 'SKILL.md')
  if (!existsSync(path)) {
    throw new Error(`${LOG_PREFIX} bundled skill is missing: ${path}`)
  }
  const { attributes, body } = parseFrontmatter(readFileSync(path, 'utf8'))
  return {
    name: attributes.name ?? SKILL_NAME,
    description:
      attributes.description ??
      'Drive a native GUI app through the cua-driver MCP tools registered by the cua-computer-use plugin.',
    whenToUse: attributes['when-to-use'],
    content: body,
    path,
  }
}

/**
 * Merge row config over the defaults, ignoring explicit `undefined`.
 *
 * @param {Record<string, unknown>} [config] - row config from the loader.
 * @returns {typeof DEFAULTS} the resolved config.
 */
function resolveConfig(config = {}) {
  /** @type {Record<string, unknown>} */
  const resolved = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined && key in DEFAULTS) resolved[key] = value
  }
  return /** @type {typeof DEFAULTS} */ (resolved)
}

/**
 * Service carrying the resolved launch parameters for the MCP client row.
 *
 * @augments Service
 */
export class CuaComputerUse extends Service {
  static inject = inject
  static Config = Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   * @param {Record<string, unknown>} [config] - row config.
   */
  constructor(ctx, config) {
    super(ctx, 'cuaComputerUse')

    const resolved = resolveConfig(config)
    const found = locateCuaDriver({
      explicit: resolved.command,
      env: { ...process.env, ...resolved.env },
    })

    if (!found.command) {
      throw new Error(`${LOG_PREFIX} ${missingBinaryMessage(found)}`)
    }

    /** Absolute path to the cua-driver executable. */
    this.command = found.command
    /** Arguments for the MCP server subcommand. */
    this.args = [...resolved.args]
    /** Extra environment variables for the child process. */
    this.env = { ...resolved.env }
    /** Working directory, or empty to inherit. */
    this.cwd = resolved.cwd
    /** Per-call timeout handed to the MCP client. */
    this.toolCallTimeoutMs = resolved.toolCallTimeoutMs
    /** How the executable was found: config, env, known-directory, or PATH. */
    this.source = found.source

    ctx.logger?.info?.(`${LOG_PREFIX} cua-driver: ${this.command} (via ${this.source})`)

    if (resolved.skill) this.#registerSkill(ctx)
    if (resolved.prompt) this.#registerPrompt(ctx)
  }

  /**
   * Publish the bundled skill when a skill registry is mounted.
   *
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   */
  #registerSkill(ctx) {
    const skills = ctx.get('skills')
    if (!skills) {
      ctx.logger?.warn?.(`${LOG_PREFIX} no skill registry mounted; the bundled skill was not registered`)
      return
    }
    const skill = readBundledSkill()
    skills.register({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      source: 'bundled',
      content: skill.content,
      path: skill.path,
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    })
  }

  /**
   * Add the standing system-prompt note when that service is mounted.
   *
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   */
  #registerPrompt(ctx) {
    const systemPrompt = ctx.get('systemPrompt')
    if (!systemPrompt) return
    systemPrompt.section({
      name: `tool:${SKILL_NAME}`,
      order: 118,
      text: PROMPT_TEXT,
    })
  }
}

export default CuaComputerUse

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
 * When the binary is missing entirely, `lib/setup.js` runs the official
 * installer and then checks the macOS permission grants the driver needs. That
 * work happens before the service is published, so the MCP row simply waits —
 * the harness boots immediately instead of blocking on a download.
 *
 * @module cua-computer-use
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { parseFrontmatter } from './lib/frontmatter.js'
import { missingBinaryMessage } from './lib/locate.js'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  checkPermissions,
  createSetupLogger,
  ensureBinary,
  resolveStateDir,
} from './lib/setup.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(ROOT, 'skill')
const SKILL_NAME = 'cua-computer-use'
const LOG_PREFIX = `[${SKILL_NAME}]`

/**
 * How long to wait before probing macOS for permissions.
 *
 * The probe talks to a daemon that may have to be started, and may raise system
 * dialogs, so it is deliberately kept off the boot path.
 */
const PERMISSION_CHECK_DELAY_MS = 1_000

/** Cordis plugin name used by loader diagnostics. */
export const name = SKILL_NAME

/** This plugin provides a service and requires none. */
/** @type {string[]} */
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
  autoInstall: true,
  installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
  installEnv: {},
  installTelemetry: false,
  modifyPath: false,
  installDir: '',
  permissionCheck: true,
  permissionPrompt: true,
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
  autoInstall: Schema.boolean()
    .default(DEFAULTS.autoInstall)
    .description('Run the official Cua Driver installer when the executable is missing. Set CUA_DRIVER_NO_AUTO_INSTALL=1 to suppress it without editing config.'),
  installTimeoutMs: Schema.number()
    .default(DEFAULTS.installTimeoutMs)
    .description('Ceiling for the installer in milliseconds. The download and signature check are slow on a cold cache.'),
  installEnv: Schema.dict(Schema.string())
    .default(DEFAULTS.installEnv)
    .description('Extra environment variables for the installer process. These win over every default the plugin sets.'),
  installTelemetry: Schema.boolean()
    .default(DEFAULTS.installTelemetry)
    .description('Let the installer send its anonymized install event. Off by default: a harness boot has no consent step, unlike a command a person typed.'),
  modifyPath: Schema.boolean()
    .default(DEFAULTS.modifyPath)
    .description('Let the installer append its directory to your shell rc files. Off by default; this plugin always passes an absolute path, so nothing needs it.'),
  installDir: Schema.string()
    .default(DEFAULTS.installDir)
    .description('Directory to install the executable into. Empty uses the installer default, ~/.local/bin.'),
  permissionCheck: Schema.boolean()
    .default(DEFAULTS.permissionCheck)
    .description('On macOS, report missing Accessibility and Screen Recording grants for the driver.'),
  permissionPrompt: Schema.boolean()
    .default(DEFAULTS.permissionPrompt)
    .description('On macOS, let the driver raise the permission prompts once per distinct missing grant.'),
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
 * Constructing this is what publishes `ctx.cuaComputerUse`, so it happens only
 * once there is an executable to point at. Until then the MCP client row sits
 * in cordis's normal "waiting for service" state rather than failing.
 *
 * @augments Service
 */
export class CuaComputerUse extends Service {
  static inject = inject
  static Config = Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   * @param {typeof DEFAULTS} resolved - effective config.
   * @param {{ command: string, source: string | null }} found - the located executable.
   * @param {{ info: (text: string) => void, warn: (text: string) => void, debug: (text: string) => void }} logger - setup logger.
   */
  constructor(ctx, resolved, found, logger) {
    super(ctx, 'cuaComputerUse')
    /** Logger that reaches both the console and the harness. */
    this.logger = logger

    /** Absolute path to the cua-driver executable. */
    this.command = /** @type {string} */ (found.command)
    /** Arguments for the MCP server subcommand. */
    this.args = [...resolved.args]
    /** Extra environment variables for the child process. */
    this.env = { ...resolved.env }
    /** Working directory, or empty to inherit. */
    this.cwd = resolved.cwd
    /** Per-call timeout handed to the MCP client. */
    this.toolCallTimeoutMs = resolved.toolCallTimeoutMs
    /** How the executable was found: config, env, known-directory, PATH, or install. */
    this.source = found.source

    logger.info(`${LOG_PREFIX} cua-driver: ${this.command} (via ${this.source})`)

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
      this.logger.warn(`${LOG_PREFIX} no skill registry mounted; the bundled skill was not registered`)
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

/**
 * Resolve the executable, publishing the service only once it exists.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - row config.
 * @returns {Promise<void>} resolves once the service is published.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const env = { ...process.env, ...resolved.env }
  const logger = createSetupLogger(ctx)

  const { found, installed, install, skipped } = await ensureBinary({
    explicit: resolved.command,
    autoInstall: resolved.autoInstall,
    env,
    installEnv: resolved.installEnv,
    timeoutMs: resolved.installTimeoutMs,
    modifyPath: resolved.modifyPath,
    telemetry: resolved.installTelemetry,
    binDir: resolved.installDir,
    logger,
    label: LOG_PREFIX,
  })

  const command = found.command
  if (!command) {
    const why =
      skipped === 'disabled' || skipped === 'environment'
        ? ' Automatic installation is switched off.'
        : install && !install.ok
          ? ' The automatic install was attempted and failed; see the lines above.'
          : ''
    throw new Error(`${LOG_PREFIX} ${missingBinaryMessage(found)}${why}`)
  }

  const service = new CuaComputerUse(ctx, resolved, { command, source: found.source }, logger)
  if (installed) {
    logger.info(`${LOG_PREFIX} installed cua-driver on this machine`)
  }

  if (resolved.permissionCheck) {
    const timer = setTimeout(() => {
      void checkPermissions({
        command: service.command,
        stateDir: resolveStateDir(),
        platform: process.platform,
        prompt: resolved.permissionPrompt,
        env,
        logger,
        label: LOG_PREFIX,
      }).catch((error) => {
        // checkPermissions degrades to log lines on its own; reaching here
        // means something unexpected, so say so instead of swallowing it.
        logger.warn(`${LOG_PREFIX} could not check the macOS permissions: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, PERMISSION_CHECK_DELAY_MS)
    // Never let the permission probe hold the process open.
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer))
  }

  // Deliberately no return value. An async `apply` resolves to the fiber's
  // disposer, and cordis rejects anything that is neither a function nor null
  // with `TypeError: Invalid effect`. The service is already registered by the
  // constructor above, which is exactly why it is constructed this late.
}

export default { name, inject, Config, apply }

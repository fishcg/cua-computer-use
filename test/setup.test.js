/**
 * Tests for first-run setup.
 *
 * Everything that spawns a process takes an injected runner or an injected
 * filesystem probe, so the suite never downloads an installer, never touches
 * the real `~/.dsh`, and never depends on what this machine happens to have
 * installed. The one exception is `run()` itself, which is exercised against
 * `/bin/sh`.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AUTO_INSTALL_ENV,
  INSTALLER_URL,
  autoInstallDisabled,
  checkPermissions,
  createSetupLogger,
  ensureBinary,
  installEnvironment,
  installerInvocation,
  missingGrants,
  parsePermissionReport,
  permissionGuide,
  readState,
  resolveStateDir,
  run,
  tail,
  writeState,
} from '../lib/setup.js'

const POSIX = process.platform !== 'win32'

/** Collect log calls so tests can assert on what the operator would see. */
function collector() {
  /** @type {string[]} */
  const lines = []
  /**
   * @param {string} level - log level.
   * @returns {(text: string) => void} a recorder for that level.
   */
  const record = (level) => (text) => lines.push(`${level}: ${text}`)
  return {
    lines,
    logger: { info: record('info'), warn: record('warn'), debug: record('debug') },
    text: () => lines.join('\n'),
  }
}

test('the unix installer command is the documented one-liner', () => {
  const { file, args } = installerInvocation('darwin')
  assert.equal(file, '/bin/bash')
  assert.equal(args.length, 2)
  assert.match(args[1], new RegExp(INSTALLER_URL.unix.replace(/[.]/g, '\\.')))
  assert.match(args[1], /curl -fsSL/)
})

test('the windows installer command uses powershell', () => {
  const { file, args } = installerInvocation('win32')
  assert.equal(file, 'powershell.exe')
  assert.ok(args.includes('-ExecutionPolicy'))
  assert.ok(args.includes('Bypass'))
  assert.match(String(args.at(-1)), /irm https:\/\/cua\.ai\/driver\/install\.ps1 \| iex/)
})

test('the installer is told not to edit shell rc files by default', () => {
  const env = installEnvironment({})
  assert.equal(env.CUA_DRIVER_NO_MODIFY_PATH, '1')
  assert.equal(env.CUA_DRIVER_RS_NO_MODIFY_PATH, '1')

  const allowed = installEnvironment({ modifyPath: true })
  assert.equal(allowed.CUA_DRIVER_NO_MODIFY_PATH, undefined)
  assert.equal(allowed.CUA_DRIVER_RS_NO_MODIFY_PATH, undefined)
})

test('install telemetry is off unless the operator asks for it', () => {
  assert.equal(installEnvironment({}).CUA_DRIVER_RS_TELEMETRY_ENABLED, '0')
  assert.equal(installEnvironment({}).CUA_TELEMETRY_ENABLED, '0')
  assert.equal(installEnvironment({ telemetry: true }).CUA_DRIVER_RS_TELEMETRY_ENABLED, '1')
})

test('an inherited environment variable outranks the plugin default', () => {
  const env = installEnvironment({ env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' } })
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '1')
  assert.equal(env.CUA_TELEMETRY_ENABLED, '1')
})

test('installEnv wins over every default the plugin sets', () => {
  const env = installEnvironment({
    modifyPath: true,
    env: { CUA_DRIVER_RS_NO_MODIFY_PATH: '0', CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' },
  })
  assert.equal(env.CUA_DRIVER_RS_NO_MODIFY_PATH, '0')
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '1')
})

test('a configured install directory reaches the installer by environment', () => {
  const env = installEnvironment({ binDir: '/opt/cua' })
  assert.equal(env.CUA_DRIVER_RS_INSTALL_DIR, '/opt/cua')
  assert.equal(installEnvironment({}).CUA_DRIVER_RS_INSTALL_DIR, undefined)
})

test('the auto-install kill switch needs a non-empty value', () => {
  assert.equal(autoInstallDisabled({}), false)
  assert.equal(autoInstallDisabled({ [AUTO_INSTALL_ENV]: '' }), false)
  assert.equal(autoInstallDisabled({ [AUTO_INSTALL_ENV]: '   ' }), false)
  assert.equal(autoInstallDisabled({ [AUTO_INSTALL_ENV]: '1' }), true)
})

test('the state directory follows $DSH_HOME and ignores a blank one', () => {
  assert.equal(resolveStateDir({}, '/Users/test'), '/Users/test/.dsh/cua-computer-use')
  assert.equal(resolveStateDir({ DSH_HOME: '/srv/dsh' }, '/Users/test'), '/srv/dsh/cua-computer-use')
  assert.equal(resolveStateDir({ DSH_HOME: '  ' }, '/Users/test'), '/Users/test/.dsh/cua-computer-use')
})

test('state round-trips and survives corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cua-state-'))
  try {
    assert.deepEqual(readState(dir), {})
    writeState(dir, { promptedFor: 'accessibility' })
    writeState(dir, { promptedAt: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(readState(dir), {
      promptedFor: 'accessibility',
      promptedAt: '2026-01-01T00:00:00.000Z',
    })

    writeFileSync(join(dir, 'setup.json'), '{ not json')
    assert.deepEqual(readState(dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a permission report parses the driver JSON', () => {
  const report = parsePermissionReport(
    JSON.stringify({
      accessibility: true,
      screen_recording: false,
      screen_recording_capturable: false,
      source: { bundle_id: 'com.trycua.driver', executable: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' },
    }),
  )
  assert.ok(report)
  assert.equal(report.accessibility, true)
  assert.equal(report.screenRecording, false)
  assert.equal(report.bundle, 'com.trycua.driver')
  assert.deepEqual(missingGrants(report), ['screenRecording'])
})

test('a field the driver does not report is unknown, never denied', () => {
  const report = parsePermissionReport(JSON.stringify({ screen_recording: true }))
  assert.ok(report)
  assert.equal(report.accessibility, null)
  assert.equal(report.screenRecording, true)
  assert.deepEqual(missingGrants(report), [])
})

test('unparseable permission output yields nothing rather than a false alarm', () => {
  assert.equal(parsePermissionReport('not json'), null)
  assert.equal(parsePermissionReport('[]'), null)
  assert.equal(parsePermissionReport('null'), null)
  assert.deepEqual(missingGrants(null), [])
})

test('the permission guide names the missing grant, the owner and the fix', () => {
  const guide = permissionGuide({
    command: '/Users/test/.local/bin/cua-driver',
    report: { accessibility: false, screenRecording: false, bundle: 'com.trycua.driver' },
  })
  assert.match(guide, /Accessibility and Screen Recording/)
  assert.match(guide, /com\.trycua\.driver/)
  assert.match(guide, /Privacy & Security/)
  assert.match(guide, /\/Users\/test\/\.local\/bin\/cua-driver permissions grant/)
  assert.match(guide, /permissions status/)
})

test('tail keeps the end of a noisy log', () => {
  assert.equal(tail('a\nb\nc\nd\ne', 2), 'd\ne')
  assert.equal(tail('  \n'), '')
  assert.equal(tail(undefined), '')
})

test('run reports a non-zero exit with its output', async () => {
  const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.equal(result.stdout.trim(), 'out')
  assert.equal(result.stderr.trim(), 'err')
})

test('run kills a process that overruns its deadline', async () => {
  const result = await run('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 250 })
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message), /timed out/)
})

test('run reports a missing executable instead of throwing', async () => {
  const result = await run('/nonexistent/cua-driver', ['permissions', 'status'])
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

/**
 * Write a fake cua-driver that answers `permissions status` with the given JSON.
 *
 * @param {string} dir - scratch directory to write into.
 * @param {object} status - the JSON body the stub should print.
 * @returns {{ path: string, log: string, calls: () => number }} the stub and its call counter.
 */
function writeStub(dir, status) {
  const path = join(dir, 'cua-driver')
  const log = join(dir, 'calls.log')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'if [ "$1" = "permissions" ] && [ "$2" = "status" ]; then',
      `  printf '%s' '${JSON.stringify(status)}'`,
      '  exit 0',
      'fi',
      'if [ "$1" = "permissions" ] && [ "$2" = "grant" ]; then',
      `  echo grant >> ${JSON.stringify(log)}`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return {
    path,
    log,
    calls: () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    },
  }
}

test('the permission check is a no-op off macOS', async () => {
  const result = await checkPermissions({ command: '/nonexistent/cua-driver', platform: 'linux' })
  assert.equal(result.status, 'not-applicable')
})

test('an unreachable driver reports unknown rather than a false alarm', async () => {
  const seen = collector()
  const result = await checkPermissions({
    command: '/nonexistent/cua-driver',
    platform: 'darwin',
    stateDir: mkdtempSync(join(tmpdir(), 'cua-state-')),
    logger: seen.logger,
  })
  assert.equal(result.status, 'unknown')
  assert.doesNotMatch(seen.text(), /withholding/)
})

test('granted permissions log nothing', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cua-perm-'))
  const seen = collector()
  try {
    const stub = writeStub(dir, { accessibility: true, screen_recording: true })
    const result = await checkPermissions({
      command: stub.path,
      platform: 'darwin',
      stateDir: join(dir, 'state'),
      logger: seen.logger,
    })
    assert.equal(result.status, 'granted')
    assert.equal(seen.lines.length, 0)
    assert.equal(stub.calls(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing grant is reported and prompted for once', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cua-perm-'))
  const seen = collector()
  try {
    const stub = writeStub(dir, { accessibility: false, screen_recording: true })
    const stateDir = join(dir, 'state')
    const options = { command: stub.path, platform: 'darwin', stateDir, prompt: true, logger: seen.logger }

    const first = await checkPermissions(options)
    assert.equal(first.status, 'prompted')
    assert.deepEqual(first.missing, ['accessibility'])
    assert.match(seen.text(), /withholding Accessibility/)
    assert.equal(stub.calls(), 1)

    const second = await checkPermissions(options)
    assert.equal(second.status, 'missing')
    assert.equal(stub.calls(), 1, 'the prompt must not repeat for the same missing grant')
    assert.equal(readState(stateDir).promptedFor, 'accessibility')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('permissionPrompt: false reports without touching the driver', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cua-perm-'))
  const seen = collector()
  try {
    const stub = writeStub(dir, { accessibility: false, screen_recording: false })
    const result = await checkPermissions({
      command: stub.path,
      platform: 'darwin',
      stateDir: join(dir, 'state'),
      prompt: false,
      logger: seen.logger,
    })
    assert.equal(result.status, 'missing')
    assert.equal(stub.calls(), 0)
    assert.match(seen.text(), /Accessibility and Screen Recording/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const BASE = { platform: 'darwin', home: '/Users/test', env: { PATH: '/usr/bin:/bin' } }

test('a located binary is used as-is and nothing is installed', async () => {
  let installed = false
  const result = await ensureBinary({
    ...BASE,
    isFile: (path) => path === '/Users/test/.local/bin/cua-driver',
    install: async () => {
      installed = true
      return { ok: true }
    },
  })
  assert.equal(result.found.command, '/Users/test/.local/bin/cua-driver')
  assert.equal(result.installed, false)
  assert.equal(installed, false)
})

test('a missing binary is installed and then re-located', async () => {
  const seen = collector()
  let present = false
  const result = await ensureBinary({
    ...BASE,
    autoInstall: true,
    label: '[test]',
    logger: seen.logger,
    isFile: (path) => present && path === '/Users/test/.local/bin/cua-driver',
    install: async () => {
      present = true
      return { ok: true, code: 0, stdout: 'installed', stderr: '' }
    },
  })
  assert.equal(result.installed, true)
  assert.equal(result.found.command, '/Users/test/.local/bin/cua-driver')
  assert.match(seen.text(), /\[test\] cua-driver was not found/)
  assert.match(seen.text(), /\[test\] cua-driver installed/)
})

test('autoInstall: false leaves the binary missing', async () => {
  let called = false
  const result = await ensureBinary({
    ...BASE,
    autoInstall: false,
    isFile: () => false,
    install: async () => {
      called = true
      return { ok: false }
    },
  })
  assert.equal(result.found.command, null)
  assert.equal(result.skipped, 'disabled')
  assert.equal(called, false)
})

test('the environment kill switch suppresses the install', async () => {
  let called = false
  const result = await ensureBinary({
    ...BASE,
    env: { ...BASE.env, [AUTO_INSTALL_ENV]: '1' },
    autoInstall: true,
    isFile: () => false,
    install: async () => {
      called = true
      return { ok: false }
    },
  })
  assert.equal(result.skipped, 'environment')
  assert.equal(called, false)
})

test('an explicitly configured path never triggers an install', async () => {
  let called = false
  const result = await ensureBinary({
    ...BASE,
    explicit: '/custom/cua-driver',
    autoInstall: true,
    isFile: () => false,
    install: async () => {
      called = true
      return { ok: false }
    },
  })
  assert.equal(result.skipped, 'explicit-missing')
  assert.equal(result.found.explicit, '/custom/cua-driver')
  assert.equal(called, false)
})

test('a failed install reports why, with the installer output', async () => {
  const seen = collector()
  const result = await ensureBinary({
    ...BASE,
    autoInstall: true,
    label: '[test]',
    logger: seen.logger,
    isFile: () => false,
    install: async () => ({
      ok: false,
      code: 1,
      stdout: 'downloading',
      stderr: '/Applications is not writable.',
      error: new Error('exited with code 1'),
    }),
  })
  assert.equal(result.found.command, null)
  assert.equal(result.skipped, 'install-failed')
  assert.match(seen.text(), /the cua-driver installer failed/)
  assert.match(seen.text(), /\/Applications is not writable\./)
})

test('a non-default install directory is checked directly', async () => {
  const result = await ensureBinary({
    ...BASE,
    autoInstall: true,
    binDir: '/opt/cua/bin',
    isFile: (path) => path === '/opt/cua/bin/cua-driver',
    install: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  })
  assert.equal(result.installed, true)
  assert.equal(result.found.command, '/opt/cua/bin/cua-driver')
  assert.equal(result.found.source, 'install')
})

test('ensureBinary passes every install knob through to the installer', async () => {
  let received = null
  await ensureBinary({
    ...BASE,
    autoInstall: true,
    binDir: '/opt/cua/bin',
    modifyPath: true,
    telemetry: true,
    timeoutMs: 1234,
    installEnv: { CUA_DRIVER_RS_VERSION: '0.35.4' },
    isFile: () => false,
    install: async (options) => {
      received = options
      return { ok: false, code: 1, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(received, {
    platform: 'darwin',
    timeoutMs: 1234,
    modifyPath: true,
    telemetry: true,
    binDir: '/opt/cua/bin',
    env: { CUA_DRIVER_RS_VERSION: '0.35.4' },
  })
})

test('createSetupLogger writes to the console so the user actually sees it', () => {
  /** @type {string[]} */
  const logs = []
  /** @type {string[]} */
  const warns = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (text) => logs.push(text)
  console.warn = (text) => warns.push(text)
  try {
    const logger = createSetupLogger()
    logger.info('an informational line')
    logger.warn('a line the user has to act on')
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }

  assert.deepEqual(logs, ['an informational line'])
  assert.deepEqual(warns, ['a line the user has to act on'])
})

test('createSetupLogger forwards to the harness logger with a bound receiver', () => {
  /** @type {string[]} */
  const seen = []
  // Mirrors cordis, whose logger is a callable instance: the methods live on
  // the prototype and reach the instance through `this`. Detaching one throws.
  class HarnessLogger {
    constructor() {
      this.tag = 'harness'
    }
    /** @param {string} text - message. */
    info(text) {
      seen.push(this.tag + ':' + text)
    }
    /** @param {string} text - message. */
    warn(text) {
      seen.push(this.tag + ':' + text)
    }
  }
  const harness = new HarnessLogger()

  const logger = createSetupLogger({ logger: harness })
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    logger.info('kept')
    logger.warn('kept too')
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }

  assert.deepEqual(seen, ['harness:kept', 'harness:kept too'])
})

test('a harness logger that throws never breaks the boot', () => {
  const hostile = {
    info() {
      throw new TypeError('this is not a function')
    },
  }
  const logger = createSetupLogger({ logger: hostile })
  const originalLog = console.log
  /** @type {string[]} */
  const logs = []
  console.log = (text) => logs.push(text)
  try {
    assert.doesNotThrow(() => logger.info('still delivered'))
  } finally {
    console.log = originalLog
  }

  assert.deepEqual(logs, ['still delivered'])
})

/**
 * Tests for the cross-platform cua-driver locator.
 *
 * The filesystem probe is injected, so the whole search order is exercised
 * without touching the disk or depending on what this machine has installed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ENV_OVERRIDE,
  INSTALL_COMMANDS,
  isRunnableFile,
  locateCuaDriver,
  missingBinaryMessage,
  searchDirectories,
} from '../lib/locate.js'

/** A probe that reports exactly the given paths as runnable. */
const probeFor = (...paths) => (path) => paths.includes(path)

const BASE = { platform: 'darwin', home: '/Users/test', env: { PATH: '/usr/bin:/bin' } }

test('finds a bare command on PATH', () => {
  const result = locateCuaDriver({
    ...BASE,
    env: { PATH: '/opt/tools:/usr/bin' },
    isFile: probeFor('/opt/tools/cua-driver'),
  })
  assert.equal(result.command, '/opt/tools/cua-driver')
  assert.equal(result.source, 'PATH')
})

test('prefers the known install directory over PATH', () => {
  const result = locateCuaDriver({
    ...BASE,
    env: { PATH: '/opt/tools' },
    isFile: probeFor('/Users/test/.local/bin/cua-driver', '/opt/tools/cua-driver'),
  })
  assert.equal(result.command, '/Users/test/.local/bin/cua-driver')
  assert.equal(result.source, 'known-directory')
})

test('honours an explicit absolute command and never falls back', () => {
  const found = locateCuaDriver({
    ...BASE,
    explicit: '/custom/cua-driver',
    isFile: probeFor('/custom/cua-driver', '/Users/test/.local/bin/cua-driver'),
  })
  assert.equal(found.command, '/custom/cua-driver')
  assert.equal(found.source, 'config')

  const missing = locateCuaDriver({
    ...BASE,
    explicit: '/custom/cua-driver',
    isFile: probeFor('/Users/test/.local/bin/cua-driver'),
  })
  assert.equal(missing.command, null)
  assert.equal(missing.source, null)
  assert.equal(missing.explicit, '/custom/cua-driver')
})

test('resolves an explicit bare command through PATH', () => {
  const result = locateCuaDriver({
    ...BASE,
    explicit: 'cua-driver',
    env: { PATH: '/nope:/yes' },
    isFile: probeFor('/yes/cua-driver'),
  })
  assert.equal(result.command, '/yes/cua-driver')
  assert.equal(result.source, 'config')
})

test(`${ENV_OVERRIDE} overrides discovery but not config`, () => {
  const fromEnv = locateCuaDriver({
    ...BASE,
    env: { PATH: '/usr/bin', [ENV_OVERRIDE]: '/env/cua-driver' },
    isFile: probeFor('/env/cua-driver', '/Users/test/.local/bin/cua-driver'),
  })
  assert.equal(fromEnv.command, '/env/cua-driver')
  assert.equal(fromEnv.source, 'env')

  const fromConfig = locateCuaDriver({
    ...BASE,
    explicit: '/config/cua-driver',
    env: { PATH: '/usr/bin', [ENV_OVERRIDE]: '/env/cua-driver' },
    isFile: probeFor('/env/cua-driver', '/config/cua-driver'),
  })
  assert.equal(fromConfig.command, '/config/cua-driver')
  assert.equal(fromConfig.source, 'config')
})

test('a stale env override does not fall through to discovery', () => {
  const result = locateCuaDriver({
    ...BASE,
    env: { PATH: '/usr/bin', [ENV_OVERRIDE]: '/gone/cua-driver' },
    isFile: probeFor('/Users/test/.local/bin/cua-driver'),
  })
  assert.equal(result.command, null)
  assert.equal(result.explicit, '/gone/cua-driver')
})

test('reports every location it checked when nothing is found', () => {
  const result = locateCuaDriver({ ...BASE, isFile: () => false })
  assert.equal(result.command, null)
  assert.ok(result.checked.includes('/Users/test/.local/bin/cua-driver'))
  assert.ok(result.checked.includes('/usr/bin/cua-driver'))
})

test('searches Windows layouts and executable suffixes', () => {
  const dirs = searchDirectories({
    platform: 'win32',
    home: 'C:\\Users\\test',
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
  })
  assert.ok(dirs.some((dir) => dir.includes('AppData')))

  const result = locateCuaDriver({
    platform: 'win32',
    home: 'C:\\Users\\test',
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: '' },
    isFile: probeFor('C:\\Users\\test\\AppData\\Local\\Programs\\cua-driver\\cua-driver.exe'),
  })
  assert.equal(result.command, 'C:\\Users\\test\\AppData\\Local\\Programs\\cua-driver\\cua-driver.exe')
})

test('the install-directory list is de-duplicated', () => {
  const dirs = searchDirectories({ platform: 'linux', home: '/home/test', env: {} })
  assert.equal(new Set(dirs).size, dirs.length)
})

test('the failure message is actionable', () => {
  const result = locateCuaDriver({ ...BASE, isFile: () => false })
  const message = missingBinaryMessage(result)
  assert.match(message, /cannot find the `cua-driver` executable/)
  assert.ok(message.includes(INSTALL_COMMANDS.unix))
  assert.match(message, /Searched:/)
  assert.match(message, new RegExp(ENV_OVERRIDE))
})

test('the failure message distinguishes a bad explicit path', () => {
  const result = locateCuaDriver({ ...BASE, explicit: '/custom/cua-driver', isFile: () => false })
  const message = missingBinaryMessage(result)
  assert.match(message, /configured cua-driver path does not exist/)
  assert.ok(message.includes('/custom/cua-driver'))
  assert.ok(!message.includes('Install it, then restart dsh'))
})

test('isRunnableFile rejects directories and missing paths', () => {
  assert.equal(isRunnableFile('/definitely/not/here'), false)
  assert.equal(isRunnableFile('/usr'), false)
})

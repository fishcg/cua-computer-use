/**
 * Tests for the dependency-free frontmatter reader used by the bundled skill.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter } from '../lib/frontmatter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('reads top-level scalars and leaves the body intact', () => {
  const { attributes, body } = parseFrontmatter('---\nname: demo\ndescription: A demo.\n---\n# Body\n')
  assert.deepEqual(attributes, { name: 'demo', description: 'A demo.' })
  assert.equal(body, '# Body\n')
})

test('skips nested blocks and comments', () => {
  const source = ['---', 'name: demo', 'metadata:', '  version: 1.0.0', '# a comment', 'ok: yes', '---', 'x'].join('\n')
  const { attributes } = parseFrontmatter(source)
  assert.deepEqual(attributes, { name: 'demo', ok: 'yes' })
})

test('unquotes quoted values and drops empty ones', () => {
  const { attributes } = parseFrontmatter('---\na: "one: two"\nb: \nc: three\n---\n')
  assert.deepEqual(attributes, { a: 'one: two', c: 'three' })
})

test('a document without frontmatter is returned verbatim', () => {
  const { attributes, body } = parseFrontmatter('# Just a body\n')
  assert.deepEqual(attributes, {})
  assert.equal(body, '# Just a body\n')
})

test('the bundled skill parses into the fields the registry needs', () => {
  const { attributes, body } = parseFrontmatter(readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf8'))
  assert.equal(attributes.name, 'cua-computer-use')
  assert.ok(attributes.description.length > 40)
  assert.ok(attributes['when-to-use'].length > 20)
  assert.ok(body.includes('mcp__cua-driver__'))
})

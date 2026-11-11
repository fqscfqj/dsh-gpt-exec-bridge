import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from 'yaml'
import { apply, name } from '../index.js'

const root = new URL('../', import.meta.url)
const read = async (file) => readFile(new URL(file, root), 'utf8')

test('bundle patch matches package metadata and default runtime rules', async (t) => {
  const pkg = JSON.parse(await read('package.json'))
  const patch = parse(await read(pkg.dsh.bundle.patch))
  assert.equal(patch.length, 1)
  assert.equal(patch[0].insert.length, 1)
  const row = patch[0].insert[0]
  assert.equal(row.id, name)
  assert.equal(row.name, pkg.name)
  assert.equal(row.config.enabled, true)
  for (const config of [undefined, row.config]) {
    const tools = new Map(row.config.rules.map(({ tool }) => [tool, { execute: (args) => args }]))
    const effects = []
    t.after(() => { for (const dispose of effects) dispose() })
    apply({ tools: { get: (tool) => tools.get(tool) }, get: () => undefined, on: () => {}, effect: (fn) => effects.push(fn()) }, config)
    for (const { tool, fields } of row.config.rules) {
      const args = Object.fromEntries(fields.map((field) => [field, '']))
      assert.deepEqual(tools.get(tool).execute(args), {})
      for (const field of fields) {
        const nonblank = { provider: 'p', model: 'm', [field]: 'set' }
        assert.equal(tools.get(tool).execute(nonblank), nonblank)
      }
    }
  }
})

test('all public entry points, locales, icon and license exist', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(pkg.publishConfig.access, 'public')
  for (const target of Object.values(pkg.exports).filter((target) => !target.includes('*'))) {
    await access(new URL(target, root))
  }
  for (const locale of ['en', 'zh']) {
    const data = JSON.parse(await read(`locale/${locale}.json`))
    assert.equal(typeof data.meta.title, 'string')
    assert.equal(typeof data.meta.description, 'string')
  }
  assert.match(await read('LICENSE'), /MIT License/)
})

test('CI covers supported Node versions on Windows and Linux without npm publishing', async () => {
  const ci = parse(await read('.github/workflows/ci.yml'))
  assert.deepEqual(ci.jobs.test.strategy.matrix.node, [20, 22, 24])
  assert.deepEqual(ci.jobs.test.strategy.matrix.os, ['ubuntu-latest', 'windows-latest'])
  assert.equal(ci.permissions.contents, 'read')
  assert.ok(ci.jobs.test.steps.some((step) => step.run === 'npm test'))
  assert.ok(ci.jobs.test.steps.every((step) => !step.run?.includes('npm publish')))
})

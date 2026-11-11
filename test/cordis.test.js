import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as bridge from '../index.js'

function definition() {
  return {
    parameters: { type: 'object', properties: { provider: { type: 'string', description: 'Provider' } } },
    execute: (args) => args,
  }
}

test('real Cordis context loads, handles registry events, restarts and disposes the bridge', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const tools = new Map()
  ctx.provide('tools', { get: (name) => tools.get(name) })
  const fiber = ctx.plugin(bridge)
  await fiber.await()

  const tool = definition()
  const original = tool.execute
  tools.set('subagent', tool)
  ctx.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '', model: '' }), {})
  assert.equal(tool.parameters.properties.provider.description, 'Provider')

  await fiber.restart()
  assert.deepEqual(tool.execute({ provider: '', model: '' }), {})
  await fiber.dispose()
  assert.equal(tool.execute, original)
  assert.equal(tool.parameters.properties.provider.description, 'Provider')
  ctx.emit('tools/change')
  assert.equal(tool.execute, original)
})

test('real Cordis injection waits for tools and cleans repairs when tools disappear', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fiber = ctx.plugin(bridge)
  await fiber.await()
  const tool = definition()
  const original = tool.execute
  const removeTools = ctx.provide('tools', { get: (name) => name === 'subagent' ? tool : undefined })
  await fiber.await()
  assert.notEqual(tool.execute, original)
  assert.deepEqual(tool.execute({ provider: '' }), {})
  await removeTools()
  await fiber.await()
  assert.equal(tool.execute, original)
  assert.equal(tool.parameters.properties.provider.description, 'Provider')
})

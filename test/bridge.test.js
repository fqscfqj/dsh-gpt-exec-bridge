import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'

const routeFields = ['provider', 'model', 'reasoning_effort', 'agent_preset', 'cwd']

function definition(execute = (args) => args) {
  return {
    execute,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(routeFields.map((field) => [field, { type: 'string', description: field }])),
    },
  }
}

function harness(t, entries = [], config, options = {}) {
  const tools = new Map(entries)
  const scoped = new Map()
  const agents = []
  const listeners = new Map()
  const effects = []
  const ctx = {
    tools: { get: (tool, agent) => (agent ? scoped.get(agent)?.get(tool) ?? tools.get(tool) : tools.get(tool)) },
    get: () => options.noAgents ? undefined : { list: () => agents },
    on(event, callback) {
      const handlers = listeners.get(event) ?? []
      handlers.push(callback)
      listeners.set(event, handlers)
    },
    effect: (callback) => effects.push(callback()),
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    listeners.clear()
    for (const callback of effects.reverse()) callback()
  }
  t.after(dispose)
  apply(ctx, config)
  return { tools, scoped, agents, dispose, emit: (event, payload) => {
    for (const callback of listeners.get(event) ?? []) callback(payload)
  } }
}

test('exports stable Cordis metadata', () => {
  assert.equal(name, 'gpt-exec-bridge')
  assert.deepEqual(inject, ['tools'])
})

for (const tool of ['list_subagent_models', 'subagent', 'subagent_fork']) {
  test(`${tool}: cleans owned blank values without mutating arguments`, (t) => {
    const toolDefinition = definition()
    harness(t, [[tool, toolDefinition]])
    const args = Object.freeze({ provider: '', model: ' \t\n', reasoning_effort: null, agent_preset: undefined, cwd: '', other: '' })
    const result = toolDefinition.execute(args)
    assert.deepEqual(result, tool === 'list_subagent_models'
      ? { reasoning_effort: null, agent_preset: undefined, cwd: '', other: '' }
      : { other: '' })
    assert.equal(args.provider, '')
  })
}

test('keeps valid arguments and their identity', (t) => {
  const tool = definition()
  harness(t, [['subagent', tool]])
  const args = Object.freeze({ provider: 'p', model: 'm', reasoning_effort: 'high', cwd: '/tmp', other: '' })
  assert.equal(tool.execute(args), args)
})

for (const omitted of ['', ' \t\n', null, undefined]) {
  test(`drops route dependents when provider is ${JSON.stringify(omitted)}`, (t) => {
    const tool = definition()
    harness(t, [['subagent', tool]])
    assert.deepEqual(tool.execute({ provider: omitted, model: 'm', reasoning_effort: 'high', prompt: 'task' }), { prompt: 'task' })
  })
}

test('missing provider drops owned dependents only', (t) => {
  const tool = definition()
  harness(t, [['list_subagent_models', tool]])
  assert.deepEqual(tool.execute({ model: 'm', reasoning_effort: 'high' }), { reasoning_effort: 'high' })
})

test('provider-only discovery remains valid', (t) => {
  const tool = definition()
  harness(t, [['list_subagent_models', tool]])
  assert.deepEqual(tool.execute({ provider: 'p', model: '' }), { provider: 'p' })
})

test('does not invent a model or discard a valid provider for a partial delegation', (t) => {
  const tool = definition()
  harness(t, [['subagent', tool]])
  assert.deepEqual(tool.execute({ provider: 'p', model: '', reasoning_effort: 'high' }), { provider: 'p', reasoning_effort: 'high' })
})

test('preserves invalid nonblank values for tool validation', (t) => {
  const tool = definition()
  harness(t, [['subagent', tool]])
  const args = { provider: 42, model: false, cwd: {} }
  assert.equal(tool.execute(args), args)
})

test('passes non-object argument values through unchanged', (t) => {
  const tool = definition()
  harness(t, [['subagent', tool]])
  for (const args of [undefined, null, '', false, 0, [], 'hello']) assert.equal(tool.execute(args), args)
})

test('preserves receiver, all positional arguments, return identity and thrown errors', (t) => {
  const result = Promise.resolve('ok')
  const receiver = {}
  const execution = {}
  const tail = {}
  const tool = definition(function (args, exec, extra) {
    assert.equal(this, receiver)
    assert.deepEqual(args, {})
    assert.equal(exec, execution)
    assert.equal(extra, tail)
    return result
  })
  const h = harness(t, [['subagent', tool]])
  assert.equal(tool.execute.call(receiver, { provider: '' }, execution, tail), result)
  const error = new Error('expected')
  tool.execute = () => { throw error }
  h.emit('tools/change')
  assert.throws(() => tool.execute({}), (caught) => caught === error)
})

for (const config of [{ enabled: false }, { rules: [] }, { rules: [null, 2, {}, { tool: '' }, { tool: 'subagent', fields: [] }] }]) {
  test(`disabled or empty rules do not wrap defaults: ${JSON.stringify(config)}`, (t) => {
    const tool = definition()
    const original = tool.execute
    harness(t, [['subagent', tool]], config)
    assert.equal(tool.execute, original)
    assert.equal(tool.parameters.properties.provider.description, 'provider')
  })
}

for (const config of [undefined, null, [], 1, { rules: 'invalid' }]) {
  test(`missing or invalid top-level config uses defaults: ${JSON.stringify(config)}`, (t) => {
    const tool = definition()
    harness(t, [['subagent', tool]], config)
    assert.deepEqual(tool.execute({ provider: '' }), {})
  })
}

test('custom and duplicate rules merge fields without claiming others', (t) => {
  const tool = definition()
  harness(t, [['custom', tool]], { rules: [null, { tool: 'custom', fields: ['cwd', 1, '', 'cwd'] }, { tool: 'custom', fields: ['agent_preset'] }] })
  assert.deepEqual(tool.execute({ cwd: '', agent_preset: '', provider: '', model: 'm' }), { provider: '', model: 'm' })
})

test('repeated events do not stack wrappers or change descriptions', (t) => {
  const tool = definition()
  const original = tool.execute
  const h = harness(t, [['subagent', tool]])
  const wrapped = tool.execute
  for (let i = 0; i < 10; i++) h.emit('tools/change')
  assert.equal(tool.execute, wrapped)
  assert.equal(tool.parameters.properties.provider.description, 'provider')
  h.dispose()
  assert.equal(tool.execute, original)
  assert.equal(tool.parameters.properties.provider.description, 'provider')
})

test('preserves parameter schemas and model-facing text throughout the lifecycle', (t) => {
  const tool = definition()
  tool.name = 'subagent'
  tool.description = 'Delegate a task'
  tool.parameters.properties.provider.description = 'Existing provider guidance'
  tool.parameters.properties.model.description = ''
  delete tool.parameters.properties.cwd.description
  for (const property of Object.values(tool.parameters.properties)) Object.freeze(property)
  Object.freeze(tool.parameters.properties)
  Object.freeze(tool.parameters)
  const schema = tool.parameters
  const before = JSON.stringify({ name: tool.name, description: tool.description, parameters: schema })
  const assertUnchanged = () => {
    assert.equal(tool.parameters, schema)
    assert.equal(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }), before)
  }
  const h = harness(t, [['subagent', tool]])
  assertUnchanged()
  assert.deepEqual(tool.execute({ provider: '', model: '', cwd: '' }), {})
  assertUnchanged()
  h.emit('tools/change')
  assertUnchanged()
  h.dispose()
  assertUnchanged()
})

test('late registration works without the optional agents service', (t) => {
  const tool = definition()
  const h = harness(t, [], undefined, { noAgents: true })
  h.tools.set('subagent', tool)
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '' }), {})
})

test('new agents expose scoped definitions before entering the live list', (t) => {
  const tool = definition()
  const h = harness(t)
  const agent = { id: 'agent' }
  h.scoped.set(agent, new Map([['subagent', tool]]))
  h.emit('agent/created', { agent })
  assert.deepEqual(tool.execute({ provider: '' }), {})
  h.agents.push(agent)
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '' }), {})
})

test('unreachable definitions are restored during registration churn', (t) => {
  const h = harness(t)
  for (let i = 0; i < 100; i++) {
    const tool = definition()
    const original = tool.execute
    h.tools.set('subagent', tool)
    h.emit('tools/change')
    assert.notEqual(tool.execute, original)
    h.tools.delete('subagent')
    h.emit('tools/change')
    assert.equal(tool.execute, original)
    assert.equal(tool.parameters.properties.provider.description, 'provider')
  }
})

test('replacing an entire definition restores the old one and wraps the new one', (t) => {
  const old = definition()
  const original = old.execute
  const h = harness(t, [['subagent', old]])
  const next = definition()
  h.tools.set('subagent', next)
  h.emit('tools/change')
  assert.equal(old.execute, original)
  assert.deepEqual(next.execute({ provider: '' }), {})
})

test('same-object execute updates are rewrapped and restored to the new implementation', (t) => {
  const tool = definition()
  const h = harness(t, [['subagent', tool]])
  const replacement = (args) => ({ replacement: args })
  tool.execute = replacement
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '' }), { replacement: {} })
  h.dispose()
  assert.equal(tool.execute, replacement)
})

test('unload preserves external execute and description replacements', (t) => {
  const tool = definition()
  const h = harness(t, [['subagent', tool]])
  const bridge = tool.execute
  const external = (...args) => bridge(...args)
  tool.execute = external
  tool.parameters.properties.provider.description = 'owner replacement'
  h.dispose()
  assert.equal(tool.execute, external)
  assert.deepEqual(tool.execute({ provider: '' }), { provider: '' })
  assert.equal(tool.parameters.properties.provider.description, 'owner replacement')
})

test('reconciliation preserves external wrappers and disables superseded bridge layers', (t) => {
  const tool = definition()
  const h = harness(t, [['subagent', tool]])
  const bridge = tool.execute
  const external = (args) => bridge({ ...args, cwd: '' })
  tool.execute = external
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '' }), { cwd: '' })
  h.dispose()
  assert.equal(tool.execute, external)
  assert.deepEqual(tool.execute({ provider: '' }), { provider: '', cwd: '' })
})

test('schema replacement and external description updates are left untouched', (t) => {
  const tool = definition()
  const previous = tool.parameters
  const h = harness(t, [['subagent', tool]])
  tool.parameters = definition().parameters
  const current = tool.parameters
  h.emit('tools/change')
  assert.equal(tool.parameters, current)
  assert.equal(previous.properties.provider.description, 'provider')
  assert.equal(tool.parameters.properties.provider.description, 'provider')
  tool.parameters.properties.provider.description = 'updated'
  h.emit('tools/change')
  assert.equal(tool.parameters.properties.provider.description, 'updated')
  assert.deepEqual(tool.execute({ provider: '' }), {})
  h.dispose()
  assert.equal(tool.parameters, current)
  assert.equal(tool.parameters.properties.provider.description, 'updated')
})

for (const order of [[0, 1], [1, 0]]) {
  test(`overlapping plugin instances unload safely in order ${order}`, (t) => {
    const tool = definition()
    const original = tool.execute
    const instances = [harness(t, [['subagent', tool]]), harness(t, [['subagent', tool]])]
    instances[order[0]].dispose()
    assert.deepEqual(tool.execute({ provider: '' }), {})
    assert.equal(tool.parameters.properties.provider.description, 'provider')
    instances[order[1]].dispose()
    assert.equal(tool.execute, original)
    assert.equal(tool.parameters.properties.provider.description, 'provider')
  })
}

test('overlapping instances retain only remaining owners fields', (t) => {
  const tool = definition()
  const a = harness(t, [['custom', tool]], { rules: [{ tool: 'custom', fields: ['cwd'] }] })
  const b = harness(t, [['custom', tool]], { rules: [{ tool: 'custom', fields: ['agent_preset'] }] })
  assert.deepEqual(tool.execute({ cwd: '', agent_preset: '' }), {})
  a.dispose()
  assert.deepEqual(tool.execute({ cwd: '', agent_preset: '' }), { cwd: '' })
  assert.equal(tool.parameters.properties.cwd.description, 'cwd')
  b.dispose()
})

test('shared parameter objects remain untouched as definitions are released', (t) => {
  const first = definition()
  const second = definition()
  second.parameters = first.parameters
  const a = harness(t, [['subagent', first]])
  const b = harness(t, [['subagent', second]])
  a.dispose()
  assert.equal(second.parameters.properties.provider.description, 'provider')
  b.dispose()
  assert.equal(second.parameters.properties.provider.description, 'provider')
})

test('aliases share a repair and refresh the union when a route disappears', (t) => {
  const tool = definition()
  const h = harness(t, [['a', tool], ['b', tool]], { rules: [{ tool: 'a', fields: ['cwd'] }, { tool: 'b', fields: ['agent_preset'] }] })
  assert.deepEqual(tool.execute({ cwd: '', agent_preset: '' }), {})
  h.tools.delete('b')
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ cwd: '', agent_preset: '' }), { agent_preset: '' })
})

test('unusable definitions can become executable later', (t) => {
  const tool = { parameters: {} }
  const h = harness(t, [['subagent', tool]])
  tool.execute = (args) => args
  h.emit('tools/change')
  assert.deepEqual(tool.execute({ provider: '' }), {})
  tool.execute = undefined
  h.emit('tools/change')
  assert.equal(tool.execute, undefined)
  h.dispose()
  assert.equal(tool.execute, undefined)
})

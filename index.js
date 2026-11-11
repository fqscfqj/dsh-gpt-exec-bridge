/**
 * Model-argument bridge for optional LLM route fields.
 *
 * Some models — notably GPT-series ones — fill every declared string parameter
 * with `""` instead of omitting it. The subagent route tools declare
 * `provider`/`model` as optional strings, so those calls arrive with empty
 * values and fail the tools' own non-empty checks. The model then sees no route
 * at all and cannot discover or select a child model.
 *
 * This plugin treats "empty" as "omitted" at the tool boundary:
 *
 * - it wraps `execute` on the affected tool definitions, dropping an empty or
 *   whitespace-only value for the configured fields before the tool sees it;
 * - when a route pair loses its `provider`, the dependent `model` and
 *   `reasoning_effort` are dropped too, so a half-filled route degrades to
 *   "inherit the parent" instead of failing a pairing check;
 * - it appends one sentence to those parameters' descriptions telling the model
 *   to omit a field rather than send an empty string.
 *
 * The wrap is applied to the exact definitions the registry holds, so tool
 * identity, prompt sections, presentation, and activation conditions keep
 * working. Definitions appear and disappear as preset compositions mount, so
 * reconciliation runs on `tools/change` and `agent/created` as well as at load.
 */

/** Stable Cordis plugin name. */
export const name = 'gpt-exec-bridge'

/** The tool registry is the only hard dependency; agents are read optionally. */
export const inject = ['tools']

/** Sentence appended to each affected parameter description. */
const FIELD_GUIDANCE =
  'Omit this field entirely when you do not want to set it; never send an empty string.'

/** Route fields that only make sense together with `provider`. */
const ROUTE_DEPENDENTS = ['model', 'reasoning_effort']

/** Tools and optional route fields repaired out of the box. */
const DEFAULT_RULES = [
  { tool: 'list_subagent_models', fields: ['provider', 'model'] },
  { tool: 'subagent', fields: ['provider', 'model', 'reasoning_effort', 'agent_preset', 'cwd'] },
  { tool: 'subagent_fork', fields: ['provider', 'model', 'reasoning_effort', 'agent_preset', 'cwd'] },
]

/**
 * Validate the row's config into the shape the bridge uses.
 * A malformed rule is skipped rather than aborting activation: a stale tool
 * name must not take the whole profile down.
 * @param raw - the patch row's `config` value, however malformed.
 * @returns the resolved settings.
 */
function resolveSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const enabled = source.enabled !== false
  const rules = Array.isArray(source.rules) ? source.rules : DEFAULT_RULES
  const resolved = []
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') continue
    const tool = rule.tool
    if (typeof tool !== 'string' || tool.length === 0) continue
    const fields = Array.isArray(rule.fields)
      ? rule.fields.filter((field) => typeof field === 'string' && field.length > 0)
      : []
    if (fields.length === 0) continue
    resolved.push({ tool, fields })
  }
  return { enabled, rules: resolved }
}

/**
 * Whether a model-supplied value means "I did not set this field".
 * @param value - one candidate argument value.
 * @returns whether the value is absent, null, or a blank string.
 */
function isOmitted(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim().length === 0)
  )
}

/**
 * Drop omitted route fields from one call's arguments.
 *
 * A route is `provider` plus its dependents. When `provider` is omitted, the
 * dependents are omitted with it: `{ provider: "", model: "x" }` must become
 * `{}` (inherit the parent route) rather than `{ model: "x" }`, which every
 * route tool rejects as an incomplete pair.
 * @param args - arguments as parsed from the model's tool call.
 * @param fields - route fields the rule owns.
 * @returns the original arguments when nothing changed, otherwise a cleaned copy.
 */
function withoutOmittedFields(args, fields) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const owned = new Set(fields)
  let next
  const drop = (field) => {
    if (!Object.hasOwn(args, field)) return
    next ??= { ...args }
    delete next[field]
  }
  for (const field of fields) if (isOmitted(args[field])) drop(field)
  if (owned.has('provider') && !Object.hasOwn(next ?? args, 'provider')) {
    for (const dependent of ROUTE_DEPENDENTS) if (owned.has(dependent)) drop(dependent)
  }
  return next ?? args
}

/** Shared ownership keeps concurrent bridge instances from undoing each other. */
const definitionRepairs = new WeakMap()
const parameterAnnotations = new WeakMap()

function refreshAnnotation(property, annotation) {
  if (property.description === annotation.applied) return
  annotation.previous = property.description
  annotation.applied = undefined
  if (typeof property.description !== 'string' || property.description.includes(FIELD_GUIDANCE)) return
  annotation.applied = property.description.length === 0
    ? FIELD_GUIDANCE
    : `${property.description} ${FIELD_GUIDANCE}`
  property.description = annotation.applied
}

function acquireAnnotation(property, owner) {
  let annotation = parameterAnnotations.get(property)
  if (!annotation) {
    annotation = { owners: new Set(), previous: undefined, applied: undefined }
    parameterAnnotations.set(property, annotation)
  }
  annotation.owners.add(owner)
  refreshAnnotation(property, annotation)
}

function releaseAnnotation(property, owner) {
  const annotation = parameterAnnotations.get(property)
  if (!annotation) return
  annotation.owners.delete(owner)
  if (annotation.owners.size > 0) return
  if (annotation.applied !== undefined && property.description === annotation.applied) {
    property.description = annotation.previous
  }
  parameterAnnotations.delete(property)
}

function refreshRepair(state) {
  const { definition } = state
  state.fields = [...new Set([...state.owners.values()].flat())]
  if (definition.execute !== state.layer?.wrapper) {
    if (state.layer) state.layer.active = false
    state.layer = undefined
    const execute = definition.execute
    if (typeof execute === 'function') {
      const layer = { execute, active: true, wrapper: undefined }
      layer.wrapper = function executeWithoutOmittedFields(...args) {
        if (layer.active && args.length > 0) args[0] = withoutOmittedFields(args[0], state.fields)
        return Reflect.apply(execute, this, args)
      }
      state.layer = layer
      definition.execute = layer.wrapper
    }
  }

  const properties = definition.parameters?.properties
  const wanted = new Set()
  if (state.layer && properties !== null && typeof properties === 'object') {
    for (const field of state.fields) {
      const property = Object.hasOwn(properties, field) ? properties[field] : undefined
      if (property !== null && typeof property === 'object') wanted.add(property)
    }
  }
  for (const property of state.properties) {
    if (!wanted.has(property)) releaseAnnotation(property, state)
  }
  for (const property of wanted) acquireAnnotation(property, state)
  state.properties = wanted
}

/** Return a lease on a shared repair, refreshed after registry changes. */
function repairDefinition(definition, fields) {
  let state = definitionRepairs.get(definition)
  if (!state) {
    if (typeof definition.execute !== 'function') return undefined
    state = { definition, owners: new Map(), fields: [], properties: new Set(), layer: undefined }
    definitionRepairs.set(definition, state)
  }
  const owner = {}
  state.owners.set(owner, fields)
  refreshRepair(state)
  return {
    refresh: (nextFields) => {
      state.owners.set(owner, nextFields)
      refreshRepair(state)
    },
    dispose: () => {
      state.owners.delete(owner)
      if (state.owners.size > 0) {
        refreshRepair(state)
        return
      }
      if (state.layer) {
        state.layer.active = false
        if (definition.execute === state.layer.wrapper) definition.execute = state.layer.execute
      }
      for (const property of state.properties) releaseAnnotation(property, state)
      state.properties.clear()
      state.fields = []
      definitionRepairs.delete(definition)
    },
  }
}

/**
 * Install the bridge for one profile.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the row's config value.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  if (!settings.enabled) return

  /** tool name -> the union of configured fields for that tool. */
  const rules = new Map()
  for (const { tool, fields } of settings.rules) {
    rules.set(tool, [...new Set([...(rules.get(tool) ?? []), ...fields])])
  }
  const repairs = new Map()

  /**
   * Every definition currently reachable for one tool name: the global view
   * plus each live agent's view, which is where preset-scoped registrations
   * surface.
   * @param toolName - registered tool name.
   * @param extraAgents - agents to include beyond the live registry.
   * @returns the reachable definitions, possibly with duplicates.
   */
  const reachable = (toolName, extraAgents) => {
    const found = []
    const globalDefinition = ctx.tools.get(toolName)
    if (globalDefinition !== undefined) found.push(globalDefinition)
    const agents = ctx.get('agents')
    const live = agents === undefined ? [] : agents.list()
    for (const agent of [...live, ...extraAgents]) {
      const scopedDefinition = ctx.tools.get(toolName, agent)
      if (scopedDefinition !== undefined) found.push(scopedDefinition)
    }
    return found
  }

  /**
   * Repair every reachable definition that is not repaired yet.
   * @param extraAgents - agents to include beyond the live registry.
   */
  const reconcile = (extraAgents = []) => {
    const reachableFields = new Map()
    for (const [toolName, fields] of rules) {
      for (const definition of reachable(toolName, extraAgents)) {
        reachableFields.set(definition, [...new Set([...(reachableFields.get(definition) ?? []), ...fields])])
      }
    }
    for (const [definition, repair] of repairs) {
      if (reachableFields.has(definition)) continue
      repair.dispose()
      repairs.delete(definition)
    }
    for (const [definition, fields] of reachableFields) {
      const repair = repairs.get(definition)
      if (repair) repair.refresh(fields)
      else {
        const added = repairDefinition(definition, fields)
        if (added) repairs.set(definition, added)
      }
    }
  }

  ctx.effect(() => () => {
    for (const repair of repairs.values()) repair.dispose()
    repairs.clear()
  })

  // Preset-scoped tools may appear after plugin activation.
  ctx.on('tools/change', () => reconcile())
  ctx.on('agent/created', ({ agent }) => reconcile([agent]))
  reconcile()
}

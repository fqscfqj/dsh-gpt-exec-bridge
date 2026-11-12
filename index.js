/**
 * Model-argument bridge for optional tool fields.
 *
 * Some models — notably GPT-series ones — fill every declared parameter with a
 * zero value instead of omitting it: `""` for strings and `false` for boolean
 * flags. Optional tool fields then arrive as if the model had chosen them, so
 * tools that reject blank values or mutually exclusive filters fail, and the
 * model sees no result at all.
 *
 * This plugin treats "zero" as "omitted" at the tool boundary:
 *
 * - it wraps `execute` on the affected tool definitions, dropping an empty or
 *   whitespace-only value for the configured fields before the tool sees it;
 * - when a route pair loses its `provider`, the dependent `model` and
 *   `reasoning_effort` are dropped too, so a half-filled route degrades to
 *   "inherit the parent" instead of failing a pairing check;
 * - inside a configured exclusive group, a `false` flag is dropped when a more
 *   specific member of the same group is set, so `{ owner, unowned: false }`
 *   reads as `{ owner }` instead of failing the "cannot be combined" check.
 *
 * Parameter descriptions and model-facing prompts are left unchanged.
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

/** Route fields that only make sense together with `provider`. */
const ROUTE_DEPENDENTS = ['model', 'reasoning_effort']

/** Tools and optional fields repaired out of the box. */
const DEFAULT_RULES = [
  { tool: 'list_subagent_models', fields: ['provider', 'model'] },
  { tool: 'subagent', fields: ['provider', 'model', 'reasoning_effort', 'agent_preset', 'cwd'] },
  { tool: 'subagent_fork', fields: ['provider', 'model', 'reasoning_effort', 'agent_preset', 'cwd'] },
  { tool: 'team_task_list', fields: ['status', 'owner', 'unowned'], exclusive: [['owner', 'unowned']] },
  { tool: 'team_task_update', fields: ['subject', 'description', 'owner'] },
]

/**
 * Validate one rule's exclusive groups.
 * A malformed group is skipped rather than aborting activation: a stale field
 * name must not take the whole profile down.
 * @param raw - the rule's `exclusive` value, however malformed.
 * @returns the resolved groups, each with at least two distinct members.
 */
function resolveGroups(raw) {
  if (!Array.isArray(raw)) return []
  const groups = []
  for (const group of raw) {
    if (!Array.isArray(group)) continue
    const members = [...new Set(group.filter((field) => typeof field === 'string' && field.length > 0))]
    if (members.length < 2) continue
    groups.push(members)
  }
  return groups
}

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
    resolved.push({ tool, fields, groups: resolveGroups(rule.exclusive) })
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

/**
 * Drop a `false` flag that only restates "no filter" beside a specific sibling.
 *
 * `owner` and `unowned` are mutually exclusive, so a model that fills every
 * declared parameter sends both and the tool rejects the call. When a sibling
 * in the same group carries a real choice, a `false` flag is the model's
 * zero-value fill and is dropped. Two real choices are left alone so the tool
 * still reports a genuine contradiction instead of the bridge guessing.
 * @param args - arguments after omitted fields were removed.
 * @param groups - mutually exclusive field groups the rule owns.
 * @returns the original arguments when nothing changed, otherwise a cleaned copy.
 */
function withoutExclusiveDefaults(args, groups) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  let next
  for (const group of groups) {
    const chosen = group.some(
      (field) => Object.hasOwn(args, field) && !isOmitted(args[field]) && args[field] !== false,
    )
    if (!chosen) continue
    for (const field of group) {
      if (!Object.hasOwn(args, field) || args[field] !== false) continue
      next ??= { ...args }
      delete next[field]
    }
  }
  return next ?? args
}

/**
 * Apply every repair one definition's owners configured.
 * @param args - arguments as parsed from the model's tool call.
 * @param state - the shared repair state holding the merged fields and groups.
 * @returns the original arguments when nothing changed, otherwise a cleaned copy.
 */
function cleanArguments(args, state) {
  return withoutExclusiveDefaults(withoutOmittedFields(args, state.fields), state.groups)
}

/**
 * Merge the exclusive groups of every owner, keeping the first spelling.
 * @param rules - the rule objects currently owning one definition.
 * @returns the distinct groups.
 */
function mergeGroups(rules) {
  const merged = new Map()
  for (const rule of rules) for (const group of rule.groups) merged.set(group.join('\u0000'), group)
  return [...merged.values()]
}

/** Shared ownership keeps concurrent bridge instances from undoing each other. */
const definitionRepairs = new WeakMap()

function refreshRepair(state) {
  const { definition } = state
  const owned = [...state.owners.values()]
  state.fields = [...new Set(owned.flatMap((rule) => rule.fields))]
  state.groups = mergeGroups(owned)
  if (definition.execute !== state.layer?.wrapper) {
    if (state.layer) state.layer.active = false
    state.layer = undefined
    const execute = definition.execute
    if (typeof execute === 'function') {
      const layer = { execute, active: true, wrapper: undefined }
      layer.wrapper = function executeWithoutZeroValues(...args) {
        if (layer.active && args.length > 0) args[0] = cleanArguments(args[0], state)
        return Reflect.apply(execute, this, args)
      }
      state.layer = layer
      definition.execute = layer.wrapper
    }
  }
}

/** Return a lease on a shared repair, refreshed after registry changes. */
function repairDefinition(definition, rule) {
  let state = definitionRepairs.get(definition)
  if (!state) {
    if (typeof definition.execute !== 'function') return undefined
    state = { definition, owners: new Map(), fields: [], groups: [], layer: undefined }
    definitionRepairs.set(definition, state)
  }
  const owner = {}
  state.owners.set(owner, rule)
  refreshRepair(state)
  return {
    refresh: (nextRule) => {
      state.owners.set(owner, nextRule)
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
      state.fields = []
      state.groups = []
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

  /** tool name -> the union of configured fields and groups for that tool. */
  const rules = new Map()
  for (const { tool, fields, groups } of settings.rules) {
    const existing = rules.get(tool) ?? { fields: [], groups: [] }
    rules.set(tool, {
      fields: [...new Set([...existing.fields, ...fields])],
      groups: [...existing.groups, ...groups],
    })
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
    const reachableRules = new Map()
    for (const [toolName, rule] of rules) {
      for (const definition of reachable(toolName, extraAgents)) {
        const merged = reachableRules.get(definition) ?? { fields: [], groups: [] }
        merged.fields = [...new Set([...merged.fields, ...rule.fields])]
        merged.groups = [...merged.groups, ...rule.groups]
        reachableRules.set(definition, merged)
      }
    }
    for (const [definition, repair] of repairs) {
      if (reachableRules.has(definition)) continue
      repair.dispose()
      repairs.delete(definition)
    }
    for (const [definition, rule] of reachableRules) {
      const repair = repairs.get(definition)
      if (repair) repair.refresh(rule)
      else {
        const added = repairDefinition(definition, rule)
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

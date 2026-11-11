# dsh-gpt-exec-bridge

Treats an empty `provider` / `model` argument as "not supplied" for the subagent
route tools, so GPT-style models can still discover and select a child model.

## Why

Some models fill every declared string parameter with `""` instead of omitting
it. The subagent tools declare their route fields as *optional* strings, so this
call reaches the tool:

```json
{ "provider": "", "model": "" }
```

`list_subagent_models` then rejects it with `` `provider` must be non-empty ``,
and the model never sees a single route — it keeps retrying the same empty call.

## What it does

It repairs the live tool definitions in place, without replacing them:

- an empty or whitespace-only value for a configured field is dropped before the
  tool runs, so `{"provider": "", "model": ""}` behaves like `{}` and lists the
  providers;
- if `provider` is dropped, its dependents (`model`, `reasoning_effort`) are
  dropped too, so a half-filled route degrades to "inherit the parent" instead of
  failing the tools' pairing check;
- one sentence is appended to those parameters' model-facing descriptions:
  *Omit this field entirely when you do not want to set it; never send an empty
  string.*

Tool identity, presentation, activation conditions, and the prompt sections that
other plugins attach to these tools are untouched.

## Tools covered by default

| tool | fields |
| --- | --- |
| `list_subagent_models` | `provider`, `model` |
| `subagent` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |
| `subagent_fork` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |

## Configuration

Row `gpt-exec-bridge` in the profile patch:

```yaml
- id: gpt-exec-bridge
  name: 'dsh-gpt-exec-bridge'
  config:
    enabled: true            # false disables the bridge entirely
    rules:                   # replaces the default table above
      - tool: list_subagent_models
        fields: [provider, model]
```

A rule naming a tool that is not registered is ignored, so the bridge keeps
working across harness upgrades that rename a tool. An explicit `rules: []`
(or an array containing only invalid rules) repairs no tools. Omit `rules` to
use the defaults. Repeated rules for the same tool merge their fields.

Only configured fields are cleaned. Valid values are not coerced, and the
caller's argument object is never mutated. Provider-only model discovery stays
valid. A delegation with a nonempty `provider` but a missing/blank `model` is
still validated by the original tool; the bridge does not guess a model or
silently discard a valid provider.

## Lifecycle

The bridge reconciles on `tools/change` and `agent/created` as well as at load,
because preset compositions mount these tools after plugins start. Changes to
the same definition's implementation or parameter schema are reconciled too.
Unregistered definitions are restored and released on the next reconciliation.

Concurrent instances share repairs. Unloading the last instance restores the
implementation and descriptions only when the bridge still owns those slots,
so updates and wrappers installed by another plugin are preserved. A bridge
wrapper retained inside another plugin's wrapper becomes a pass-through after
unload.

## Development

Requires Node.js 20 or newer. Runtime code has no external dependencies;
Cordis and YAML are development-only dependencies for integration and manifest
tests.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

CI runs these checks on Windows and Linux with Node.js 20, 22, and 24.
The package's `prepack` hook runs syntax checks and all tests before packing.

## Distribution

The source repository is <https://github.com/fqscfqj/dsh-gpt-exec-bridge>.
Version `0.1.0` is prepared for public npm distribution but is not yet published.
When available on npm, install the bundle through the DSH plugin manager using
its package name, `dsh-gpt-exec-bridge`. This is a DSH plugin, not a standalone
command-line program.

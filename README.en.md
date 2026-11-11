# dsh-gpt-exec-bridge

[简体中文](https://github.com/fqscfqj/dsh-gpt-exec-bridge/blob/main/README.md) | English

Treats empty `provider` / `model` arguments as "not supplied" for subagent route tools, so GPT-style models can still discover and select a child model.

## The Problem

Some models fill every declared string parameter with `""` instead of omitting unused fields. Subagent tools declare their route fields as optional strings, so they may receive a call like this:

```json
{ "provider": "", "model": "" }
```

`list_subagent_models` rejects this call with `` `provider` must be non-empty ``, preventing the model from discovering available routes and potentially causing repeated attempts with the same empty arguments.

## How It Works

The plugin repairs live tool definitions in place without replacing the definition objects:

- Before execution, it removes empty or whitespace-only strings from configured fields, so `{"provider": "", "model": ""}` behaves like `{}` and lists available providers. Configured fields whose values are `null` or `undefined` are also removed.
- When `provider` is absent, it also removes the dependent fields `model` and `reasoning_effort` covered by the rule. This lets incomplete routes fall back to the tool's default behavior instead of failing dependency checks. Delegation tools then inherit the parent agent's route.

The plugin silently cleans arguments at the execution boundary without changing parameter descriptions or adding model-facing guidance. Tool identity, presentation, activation conditions, and prompt sections attached by other plugins remain unchanged.

## Default Coverage

| Tool | Fields |
| --- | --- |
| `list_subagent_models` | `provider`, `model` |
| `subagent` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |
| `subagent_fork` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |

## Configuration

Configure the `gpt-exec-bridge` entry in the profile patch:

```yaml
- id: gpt-exec-bridge
  name: 'dsh-gpt-exec-bridge'
  config:
    enabled: true            # Set to false to disable the bridge entirely
    rules:                   # Replaces the default rules above
      - tool: list_subagent_models
        fields: [provider, model]
```

Rules targeting tools that are not registered are ignored, so tool renames across harness upgrades do not prevent the plugin from working.

- Omit `rules` to use the defaults.
- An explicit `rules: []`, or an array containing only invalid rules, repairs no tools.
- Repeated rules for the same tool merge their fields.

Only configured fields are cleaned. Valid values are not coerced, and the caller's original argument object is never mutated. Provider-only model discovery remains valid. A delegation with a nonempty `provider` but a missing or blank `model` is still validated by the original tool; the bridge does not guess a model or silently discard a valid provider.

## Lifecycle

The bridge reconciles at load time and on `tools/change` and `agent/created`, because preset compositions may mount tools after plugins start. Changes to the same definition's execution implementation are reconciled too; parameter schemas are always left untouched. Unregistered definitions are restored and released on the next reconciliation.

Concurrent instances share repairs. When the last instance unloads, the execution implementation is restored only if the bridge still owns that slot, preserving updates and wrappers installed by other plugins. A bridge wrapper retained inside another plugin's wrapper becomes a pass-through after unload.

## Development and Validation

Requires Node.js 20 or newer. Runtime code has no external dependencies; Cordis and YAML are development-only dependencies for integration tests and package configuration validation.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

CI runs checks on Windows and Linux with Node.js 20, 22, and 24. The package's `prepack` hook runs syntax checks and all tests before packing.

## Installation

Source repository: <https://github.com/fqscfqj/dsh-gpt-exec-bridge>.

npm package: <https://www.npmjs.com/package/dsh-gpt-exec-bridge>.

Install through the DSH plugin manager using the package name `dsh-gpt-exec-bridge`, or pin the version with `dsh-gpt-exec-bridge@0.1.1`.

This is a DSH plugin, not a standalone command-line program.

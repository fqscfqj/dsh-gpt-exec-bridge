# dsh-gpt-exec-bridge

将子代理路由工具中空的 `provider` / `model` 参数视为“未提供”，让 GPT 系列模型仍能正常查询和选择子代理模型。

## 解决的问题

部分模型会为所有已声明的字符串参数填写 `""`，而不是省略不需要的字段。子代理工具将路由字段声明为可选字符串，因此可能收到这样的调用：

```json
{ "provider": "", "model": "" }
```

`list_subagent_models` 会以 `` `provider` must be non-empty `` 拒绝该调用，导致模型无法获取任何可用路由，并可能反复重试相同的空参数。

## 工作方式

插件直接修复工具注册表中的现有定义，不替换工具定义对象：

- 在工具执行前删除已配置字段中的空字符串或纯空白字符串，使 `{"provider": "", "model": ""}` 与 `{}` 的行为一致，能够列出可用提供方。值为 `null` 或 `undefined` 的已配置字段也会被删除。
- 如果未提供 `provider`，同时删除规则所覆盖的依赖字段 `model` 和 `reasoning_effort`，让不完整的路由退回默认行为，避免触发依赖字段的配对校验。委派工具此时会继承父代理的路由。
- 在相关参数面向模型的说明中追加以下提示，要求模型省略未使用的字段，不要发送空字符串：

  > Omit this field entirely when you do not want to set it; never send an empty string.

工具标识、呈现方式、激活条件，以及其他插件附加到这些工具的提示词片段均保持不变。

## 默认覆盖范围

| 工具 | 字段 |
| --- | --- |
| `list_subagent_models` | `provider`, `model` |
| `subagent` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |
| `subagent_fork` | `provider`, `model`, `reasoning_effort`, `agent_preset`, `cwd` |

## 配置

在配置档案补丁中配置 `gpt-exec-bridge` 条目：

```yaml
- id: gpt-exec-bridge
  name: 'dsh-gpt-exec-bridge'
  config:
    enabled: true            # 设为 false 可完全禁用桥接
    rules:                   # 替换上方的默认规则表
      - tool: list_subagent_models
        fields: [provider, model]
```

规则指向的工具尚未注册时会被忽略，避免因宿主升级后工具更名而影响插件运行。

- 省略 `rules` 时使用默认规则。
- 显式设置 `rules: []`，或数组中所有规则均无效时，不修复任何工具。
- 同一工具的重复规则会合并字段。

插件仅清理规则中配置的字段，不强制转换有效值，也不会修改调用方传入的原始参数对象。仅指定 `provider` 的模型查询仍然有效。对于指定了非空 `provider`、但缺少 `model` 或将其留空的委派调用，仍由原工具负责校验；插件不会猜测模型，也不会静默丢弃有效的提供方。

## 生命周期

插件在加载时，以及收到 `tools/change`、`agent/created` 事件时重新检查工具，因为预设组合可能在插件启动后才挂载这些工具。同一工具定义的执行实现或参数结构发生变化时，也会重新应用修复。已注销的工具定义会在下一次检查时恢复并释放引用。

多个插件实例共享修复状态。最后一个实例卸载时，仅在当前实现和参数说明仍由桥接插件持有的情况下恢复原值，保留其他插件随后安装的更新或包装器。如果桥接包装器被其他插件的包装器保留，卸载后它将仅透传调用，不再清理参数。

## 开发与验证

需要 Node.js 20 或更新版本。运行时代码没有外部依赖；Cordis 和 YAML 仅作为开发依赖，用于集成测试和包配置验证。

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

CI 在 Windows 和 Linux 上，分别使用 Node.js 20、22、24 执行检查。包的 `prepack` 钩子会在打包前执行语法检查和全部测试。

## 获取与安装

源码仓库：<https://github.com/fqscfqj/dsh-gpt-exec-bridge>。

`0.1.0` 版本已完成公开 npm 包的发布准备，但尚未发布到 npm。发布后，可通过 DSH 插件管理器使用包名 `dsh-gpt-exec-bridge` 安装。

这是一个 DSH 插件，不是独立的命令行程序。

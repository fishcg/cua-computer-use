# cua-computer-use

把 [Cua Driver](https://github.com/trycua/cua) 的 MCP 服务器接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，让 Harness 真正拥有「操作电脑」的能力。

Cua Driver 自带一个 MCP 服务器（`cua-driver mcp`），对外提供一套**无障碍（accessibility）优先**的 GUI 自动化能力：
窗口发现、无障碍树快照、绑定快照的元素令牌、像素坐标兜底、原生菜单、浏览器标签页、录制与回放。本插件负责定位
`cua-driver` 可执行文件，把这个服务器接到 Harness 内置的 MCP 客户端上，将约 60 个工具注册为
`mcp__cua-driver__*`，并附带一个教会模型正确工作流的 Harness 技能。

插件不重复实现任何自动化逻辑，也没有任何运行时依赖。

## 为什么需要插件，而不是手写一行 MCP 配置

手工在 profile 里加一行 MCP 当然可行，但会踩到两个坑：

1. **Harness 宿主进程没有你 shell 的 `PATH`。** macOS 上桌面端由 `launchd` 启动，它的 `PATH` 里没有
   `~/.local/bin`——而这正是 Cua Driver 安装器放可执行文件的地方。MCP 行里写裸命令 `cua-driver` 会直接
   启动失败，且报错信息毫无指向性。本插件会解析出绝对路径、按平台搜索常见安装目录，并在失败时把**尝试过的
   每个路径**都列出来。
2. **只有工具、没有指引，模型会用错。** 注册 60 个工具并不够——模型需要知道：快照会让令牌失效、
   `since: "latest"` 才是最省的复读方式、浏览器页面应该交给 `browser_*` 工具而不是桌面指针。插件自带的技能
   和一句常驻提示词就是干这个的。

## 前置条件

- DeepSeek Harness `0.2.0-rc.2` 及以上。
- `cua-driver` 可执行文件，位于 `PATH` 或标准安装目录：

  ```sh
  # macOS / Linux
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

  ```powershell
  # Windows
  irm https://cua.ai/driver/install.ps1 | iex
  ```

- macOS 需要给 **CuaDriver 守护进程**（或启动它的终端）授予「辅助功能」和「屏幕录制」权限。
  `cua-driver doctor` 和 `mcp__cua-driver__health_report` 工具会告诉你缺什么。

## 安装

```sh
# 从 Git 仓库安装
dsh plugin --profile web add github:fishcg/cua-computer-use
```

安装后重启 Harness。bundle 层由 `package.json` 里的 `dsh.bundle.patch` 声明，会自动生效。

插件发布的是纯 ESM，没有构建步骤，也没有任何运行时依赖，所以从 Git 安装**不需要**在 profile 的
`pnpm-workspace.yaml` 里加 `allowBuilds`——根本没有东西要编译。

## 注册内容

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `mcp__cua-driver__*` | 60 个工具，经 `@deepseek-ai/dsh-mcp-client` 桥接 |
| 技能 | `cua-computer-use` | 工作流、可靠性规则、故障排查 |
| 服务 | `cuaComputerUse` | 解析后的启动参数，供其它行消费 |
| 提示词 | `tool:cua-computer-use` | 三句话的常驻说明，可用 `prompt: false` 关闭 |

工具覆盖窗口发现（`list_windows`、`launch_app`）、状态读取（`get_window_state`、`get_accessibility_tree`）、
输入（`click`、`type_text`、`set_value`、`press_key`、`hotkey`、`scroll`、`drag`）、校验（`verify_state`）、
批量执行（`run_steps`、`run_script`）、原生菜单（`invoke_menu`）、浏览器（`get_browser_state`、`browser_click` 等）、
窗口几何、录制和诊断。

## 配置

在 profile 的 `cordis.patch.yml` 里找到 `cua-computer-use` 那一行：

```yaml
- id: cua-computer-use
  config:
    command: /opt/cua/cua-driver
    toolCallTimeoutMs: 180000
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `command` | `string` | `''` | 显式指定路径或命令名。留空则自动发现。显式指定时不会静默回退到别的二进制。 |
| `args` | `string[]` | `['mcp']` | 传给可执行文件的参数。 |
| `env` | `object` | `{}` | 追加给 MCP 子进程的环境变量。 |
| `cwd` | `string` | `''` | 子进程工作目录。留空继承宿主。 |
| `toolCallTimeoutMs` | `number` | `120000` | 单次调用超时。默认给得比较宽，因为 GUI 等待和守护进程冷启动都很慢；MCP 客户端自身的默认值是 60 秒。 |
| `skill` | `boolean` | `true` | 是否注册自带技能。 |
| `prompt` | `boolean` | `true` | 是否写入常驻系统提示词。 |

环境变量 `CUA_DRIVER_BIN` 可以钉死一个绝对路径，优先级高于目录搜索、低于 `command`。

## 工作原理

bundle patch 按顺序插入两行：

```yaml
- insert:
    - id: cua-computer-use
      name: 'cua-computer-use'

    - id: mcp-cua-driver
      name: '@deepseek-ai/dsh-mcp-client'
      inject: [cuaComputerUse]
      config:
        serverName: cua-driver
        transport: stdio
        command: !!js ctx.cuaComputerUse.command
        args: !!js ctx.cuaComputerUse.args
        env: !!js ctx.cuaComputerUse.env
        cwd: !!js ctx.cuaComputerUse.cwd
        toolCallTimeoutMs: !!js ctx.cuaComputerUse.toolCallTimeoutMs
        failOnStartupError: false
```

第一行解析二进制路径并把它发布成一个服务；第二行 `inject` 该服务，因此它的 `!!js` 配置表达式是在路径已知**之后**
才求值的。`failOnStartupError: false` 保证 Cua Driver 装坏了也不会拖垮整个 Harness，而是由 MCP 客户端报告失败。

## 验证是否生效

重启后直接让模型「列出当前窗口」，或者在终端里检查：

```sh
cua-driver --version          # 插件会找到的那个二进制
cua-driver doctor             # 守护进程与权限健康检查
```

如果没有出现工具，宿主日志里会有一条 `[cua-computer-use]` 开头的记录：成功时给出解析到的路径，失败时列出搜索过的
每个目录。插件选择在加载期直接抛错，而不是注册一个注定启动不了的行。

## 开发

```sh
pnpm install   # 仅开发用：TypeScript 类型
pnpm test      # node --test，零依赖即可运行
pnpm typecheck
```

定位模块的文件探测函数和目标平台都是可注入的，因此完整的搜索顺序都能在测试里覆盖，不需要碰磁盘，也不依赖宿主平台。

## 许可

MIT。Cua Driver 是 [trycua](https://github.com/trycua/cua) 的独立项目，未随本插件分发。

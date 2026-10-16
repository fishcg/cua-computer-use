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
- 首次运行不需要其它准备。`cua-driver` 缺失时插件会自己装，见[首次运行](#首次运行)。如果你想自己装、或者想在
  启动 Harness 之前先装好：

  ```sh
  # macOS / Linux
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

  ```powershell
  # Windows
  irm https://cua.ai/driver/install.ps1 | iex
  ```

- macOS 需要「辅助功能」和「屏幕录制」权限。插件会检查并一步步引导你授权，不需要你额外做什么。

## 首次运行

插件会自己完成下面两步，而且两步都不会阻止 Harness 启动。

**一、可执行文件。** 查找顺序是：配置项 → `$CUA_DRIVER_BIN` → 标准安装目录 → `PATH`。都没有时，插件用官方
文档里的同一条命令安装，然后再找一次。

安装器通过**环境变量**驱动而不是命令行参数——这是官方文档承诺稳定的接口，而且在 Windows 上没有 shell 引号
问题。有三个默认值需要知道，因为开机启动没有人点「同意」，而手敲 `curl … | bash` 的人是自己同意了：

| 环境变量 | 默认值 | 原因 |
| --- | --- | --- |
| `CUA_DRIVER_RS_NO_MODIFY_PATH` | `1` | 插件会把绝对路径直接交给 MCP 客户端，所以往你的 `~/.zshrc` 里追加 PATH 属于没人会想到去查的副作用。设 `modifyPath: true` 可放开。 |
| `CUA_DRIVER_RS_TELEMETRY_ENABLED` | `0` | 安装遥测在这里是「选择加入」，不是「选择退出」。设 `installTelemetry: true` 才发送。 |
| `CUA_DRIVER_RS_INSTALL_DIR` | 未设置 | 设 `installDir` 可装到 `~/.local/bin` 以外的地方。 |

安装器写入的每个文件都会校验发布包的 `SHA256SUMS`，macOS 的 app bundle 在建立软链之前会校验签名。设
`autoInstall: false`，或导出 `CUA_DRIVER_NO_AUTO_INSTALL=1`，插件就完全不装，改为直接报错并给出手动命令。

**二、macOS 权限。** 服务发布一秒后，插件读取 `cua-driver permissions status --json`；如果有权限被拒绝，
它会打印该开什么、在哪里开，并让驱动自己弹出系统授权弹窗——**每种缺失的权限只弹一次**，标记存在
`~/.dsh/cua-computer-use/setup.json`，所以之后的启动只会告诉你还缺什么，不会反复弹窗。

权限归属于 **CuaDriver**，不属于 DeepSeek Harness——macOS 把这类权限记在拥有无障碍 API 的那个进程上，也就是
驱动守护进程。设 `permissionCheck: false` 可跳过检查，设 `permissionPrompt: false` 则只报告、不弹窗。

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
| `autoInstall` | `boolean` | `true` | 缺失时是否自动安装 `cua-driver`。关闭则直接报错并给出手动命令。 |
| `installTimeoutMs` | `number` | `300000` | 安装器超时时间。 |
| `installEnv` | `object` | `{}` | 追加给安装器的环境变量，优先级高于上面的默认值。 |
| `installTelemetry` | `boolean` | `false` | 是否允许安装器上报安装事件。 |
| `modifyPath` | `boolean` | `false` | 是否允许安装器往 shell 配置文件里追加 PATH。 |
| `installDir` | `string` | `''` | 安装到指定目录，而非安装器默认目录。 |
| `permissionCheck` | `boolean` | `true` | 启动后检查一次 macOS 权限。Windows 与 Linux 会跳过。 |
| `permissionPrompt` | `boolean` | `true` | 是否让驱动弹出 macOS 授权弹窗，每种缺失权限只弹一次。 |

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
每个目录。找不到二进制时动静很大但不致命：插件自己那一行会带着确切的修复方法转为未激活，其余各行照常运行，MCP 行
则停在 `pending (waiting for service: cuaComputerUse)` 而不是直接死掉——装好二进制重启即可。

首次运行应该能看到这类日志：

```
[cua-computer-use] cua-driver was not found; installing it with the official installer
[cua-computer-use] cua-driver installed: /Users/you/.local/bin/cua-driver
[cua-computer-use] cua-driver: /Users/you/.local/bin/cua-driver (via known-directory)
[cua-computer-use] macOS is withholding Accessibility, so the cua-driver tools will observe but not act.
```

## 开发

```sh
pnpm install   # 仅开发用：TypeScript 类型
pnpm test      # node --test，零依赖即可运行
pnpm typecheck
```

定位模块的文件探测函数和目标平台都是可注入的，因此完整的搜索顺序都能在测试里覆盖，不需要碰磁盘，也不依赖宿主平台。

## 许可

MIT。Cua Driver 是 [trycua](https://github.com/trycua/cua) 的独立项目，未随本插件分发。

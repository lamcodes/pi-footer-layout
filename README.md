# pi-footer-layout

Pi Coding Agent 的独立 Footer 布局扩展。

## 功能

- 保留项目路径、Git 分支和会话名称信息；
- 保留 Token、缓存、上下文、成本、模型和 thinking 信息；
- MCP、命令历史、TPS 等状态可以各占一行或按宽度自动换行；
- 动态读取所有 `ctx.ui.setStatus()` 状态，未来新增状态无需修改本扩展；
- 不修改 `pi-token-speed`、MCP 或其它状态扩展；
- 状态内容过长时按终端宽度换行，而不是把整行统一截断。

## 安装

### 本地开发

在当前项目目录执行：

```bash
pi install "D:\htmlcode\pi-footer-layout"
```

### GitHub 公开仓库

本项目通过 GitHub 公开仓库分发，不需要 npm。用户可以固定 tag 安装：

```bash
pi install git:github.com/lamcodes/pi-footer-layout@v0.1.0
```

团队项目也可以使用项目级安装：

```bash
pi install -l git:github.com/lamcodes/pi-footer-layout@v0.1.0
```

这会写入项目的 `.pi/settings.json`，让 Pi 在项目启动时自动安装缺失的包。

升级时安装新的 tag：

```bash
pi install git:github.com/lamcodes/pi-footer-layout@v0.1.1
```

安装后重启 Pi。扩展默认关闭，不会改变现有 Footer。

## 配置

在 `~/.pi/agent/settings.json` 中增加：

```json
{
  "footerLayout": {
    "enabled": true,
    "mode": "each",
    "statusOrder": [
      "mcp",
      "mcp-auth",
      "folder-history",
      "tokenSpeed",
      "subagents",
      "pi-goal"
    ],
    "continuationIndent": 3
  }
}
```

当前扩展实际使用的常见状态 key：

| 功能 | key |
| --- | --- |
| MCP | `mcp` |
| MCP 临时认证 | `mcp-auth` |
| 命令历史 | `folder-history` |
| TPS | `tokenSpeed` |
| 子代理 | `subagents` |
| 目标任务 | `pi-goal` |

`statusOrder` 只影响排序。未配置的状态会自动按 key 排列；在 `each` 模式下，新状态默认自动获得独立行。

`continuationIndent` 表示“同一个超长状态换到下一行时，续行开头的空格数”。例如设置为 `3` 时，续行会以三个空格开头；短状态不受影响。设置为 `0` 可取消缩进。

## 布局模式

### `each`

每个状态从新行开始。单个状态过长时，其自身继续换行。这是解决状态相互挤压的推荐模式。

```json
"mode": "each"
```

### `wrap`

状态尽量同行显示，放不下时按状态项目换行；单个过长状态按字符换行。

```json
"mode": "wrap"
```

### `group`

只合并显式配置在同一组中的状态；未配置的新状态自动各占一组：

```json
{
  "mode": "group",
  "statusGroups": [
    ["mcp", "mcp-auth"],
    ["folder-history", "tokenSpeed"]
  ]
}
```

### `compact`

兼容旧版单行截断行为，不推荐用于状态较多的场景：

```json
"mode": "compact"
```

旧配置中的 `wrapStatuses: false` 等价于 `compact`，`wrapStatuses: true` 等价于 `wrap`。建议迁移为显式的 `mode`；如果省略布局配置，默认使用 `each`。

将 `enabled` 改为 `false` 或删除整个 `footerLayout` 节点即可恢复 Pi 默认 Footer。出现任何异常时优先改回 `false` 并重启 Pi。

## TUI 配置

在 Pi 交互界面输入：

```text
/footer-layout
```

即可打开设置面板，使用方向键和 Enter 修改：

- 是否启用 Footer 布局；
- `each`、`wrap`、`group`、`compact` 模式；
- 续行缩进；
- 状态排序和状态分组。

修改会立即应用，并写入全局 `~/.pi/agent/settings.json`。Pi 内置 `/settings` 没有公开扩展自定义设置项的注册接口，因此这里使用独立的 `/footer-layout` TUI 命令。

## 注意

Pi 同时只能使用一个 custom Footer。如果其它扩展也调用 `setFooter()`，后注册的扩展可能覆盖本扩展；使用 `ctx.ui.setStatus()` 的扩展则会被本扩展自动布局。

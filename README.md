# pi-footer-layout

Pi Coding Agent 的独立 Footer 布局扩展。

## 功能

- 保留项目路径、Git 分支和会话名称信息；
- 保留 Token、缓存、上下文、成本、模型和 thinking 信息；
- MCP、命令历史、TPS 等状态可以各占一行或按宽度自动换行；
- 动态读取所有 `ctx.ui.setStatus()` 状态，未来新增状态无需修改本扩展；
- 不修改 `pi-token-speed`、MCP 或其它状态扩展；
- 状态内容过长时按终端宽度换行，而不是把整行统一截断；
- 可选：把 Claude Code 用户级 MCP 服务器自动导入 pi 内置 MCP 配置（默认关闭）。

## 安装

### 本地开发

在当前项目目录执行：

```bash
pi install "D:\htmlcode\pi-footer-layout"
```

### GitHub 公开仓库

本项目通过 GitHub 公开仓库分发，不需要 npm。用户可以固定 tag 安装：

```bash
pi install git:github.com/lamcodes/pi-footer-layout@v0.2.1
```

团队项目也可以使用项目级安装：

```bash
pi install -l git:github.com/lamcodes/pi-footer-layout@v0.2.1
```

这会写入项目的 `.pi/settings.json`，让 Pi 在项目启动时自动安装缺失的包。

升级时安装新的 tag：

```bash
pi install git:github.com/lamcodes/pi-footer-layout@v0.2.1
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
- 状态排序和状态分组；
- 是否导入 Claude Code MCP（开启时立即同步一次，并持久化到 `claudeMcpImport.enabled`）。

修改会立即应用，并写入全局 `~/.pi/agent/settings.json`。Pi 内置 `/settings` 没有公开扩展自定义设置项的注册接口，因此这里使用独立的 `/footer-layout` TUI 命令。

## Claude Code MCP 导入

pi 0.99.x 起 MCP 已内置，配置在 `~/.pi/agent/mcp.json`。本扩展可以把 Claude Code 的用户级 MCP（`~/.claude.json` 顶层 `mcpServers`）自动同步进来，Claude Code 里增删服务器都不用再手动操作：

1. 读取 Claude Code 用户级配置；
2. 新增 pi 中缺失的服务器；pi 里已有的同名配置一律不改动；
3. 跟随删除：Claude Code 里移除的服务器也会从 pi 移除。只作用于本扩展导入过的条目（记录在 `~/.pi/agent/claude-mcp-import.json`），pi 里手动添加或手动改过的永不触碰；
4. 新增的服务器写入 `mcp.json` 持久化并在当前会话立即注册生效，无需重启 Pi；移除的服务器下次启动 Pi 后断开；
5. 不兼容条目（如 legacy SSE）跳过并在通知中说明原因。

默认关闭。在 `~/.pi/agent/settings.json` 中开启（也可以直接在 `/footer-layout` 面板里切换，开启后立即同步一次）：

```json
{
  "claudeMcpImport": {
    "enabled": true
  }
}
```

说明：

- 导入的服务器沿用 pi 默认的 `exposure: codemode`，工具经 codemode 或 `tool_search` 调用；需要直接暴露给模型时在 `/mcp` 面板中调整。
- 需要登录的 HTTP 服务器导入后需在 `/mcp` 中完成一次 OAuth 登录，凭据不会从 Claude Code 迁移。
- Claude Code 的 `${VAR:-default}` 环境变量默认值写法 pi 不支持，如导入后连接失败请检查对应 `env`。
- 同步是镜像语义：在 pi 里用 `/mcp` 移除一个仍存在于 Claude Code 的导入服务器，下次同步会重新导入；只是不想用的话用 `/mcp` 禁用即可。
- 想保留某个导入的服务器、不跟随 Claude 删除，把它的名字从 `~/.pi/agent/claude-mcp-import.json` 的 `imported` 列表里删掉，之后该服务器完全归你手动管理。

## 注意

Pi 同时只能使用一个 custom Footer。如果其它扩展也调用 `setFooter()`，后注册的扩展可能覆盖本扩展；使用 `ctx.ui.setStatus()` 的扩展则会被本扩展自动布局。

pi 0.99.x 的内置 MCP 不产生 Footer 状态；上文 `mcp`、`mcp-auth` 状态 key 仅在同时安装旧 MCP 扩展时出现，内置 MCP 的服务器状态用 `/mcp` 查看。

本扩展要求 pi 0.99.0 或更高版本。

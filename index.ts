import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type Component,
  type SettingItem,
  SettingsList,
  type TUI,
} from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ImportPlan,
  syncClaudeMcpServers,
} from "./src/claude-mcp-import.ts";
import {
  FooterLayout,
  footerConfigsEqual,
  parseFooterLayoutConfig,
  type FooterLayoutConfig,
} from "./src/footer-layout.ts";

/** 面板修改后写盘 debounce 延迟，避免连续按键造成高频文件写入。 */
const PERSIST_DEBOUNCE_MS = 400;

/** 注册独立 Footer 扩展，并提供 /footer-layout TUI 配置入口。 */
export default (pi: ExtensionAPI) => {
  const layout = new FooterLayout();
  let persistQueue: Promise<void> = Promise.resolve();
  let footerOwnedByLayout = false;
  /** 上次安装 Footer 时的配置，用于跳过无变化的重复安装。 */
  let lastAppliedConfig: FooterLayoutConfig | undefined;
  let persistTimer: NodeJS.Timeout | undefined;
  let pendingConfig: FooterLayoutConfig | undefined;
  /** 最近一次持久化的结果，决定面板关闭时的提示文案。 */
  let persistResult: "ok" | "error" = "ok";

  /** 根据最新配置安装或恢复 Footer；配置未变化时跳过重复安装。 */
  const applyFooter = (ctx: ExtensionContext): void => {
    if (!layout.isEnabled()) {
      // 只有本扩展之前接管过 Footer 时才恢复默认，避免干扰其它扩展。
      if (footerOwnedByLayout) {
        ctx.ui.setFooter(undefined);
        footerOwnedByLayout = false;
      }
      lastAppliedConfig = undefined;
      return;
    }
    const config = layout.getConfig();
    if (footerOwnedByLayout && footerConfigsEqual(config, lastAppliedConfig)) {
      return;
    }
    ctx.ui.setFooter((tui, theme, footerData) =>
      layout.createComponent(tui, theme, footerData),
    );
    footerOwnedByLayout = true;
    lastAppliedConfig = config;
  };

  /** 将配置真正入队写入 settings.json，串行执行并记录最终结果。 */
  const writeConfig = (
    config: FooterLayoutConfig,
    ctx: ExtensionContext,
  ): void => {
    persistQueue = persistQueue
      .then(() => persistFooterConfig(config))
      .then(() => {
        persistResult = "ok";
      })
      .catch((error: unknown) => {
        persistResult = "error";
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Footer 配置保存失败: ${message}`, "error");
      });
  };

  /** 记录最新配置并 debounce 写盘，连续变更只写最后一次。 */
  const queuePersist = (
    config: FooterLayoutConfig,
    ctx: ExtensionContext,
  ): void => {
    pendingConfig = config;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      const toPersist = pendingConfig;
      pendingConfig = undefined;
      if (toPersist) writeConfig(toPersist, ctx);
    }, PERSIST_DEBOUNCE_MS);
  };

  /** 面板关闭时取消挂起定时器、立即写入最后一次配置，并等待队列排空。 */
  const flushPersist = (ctx: ExtensionContext): Promise<void> => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
      const toPersist = pendingConfig;
      pendingConfig = undefined;
      if (toPersist) writeConfig(toPersist, ctx);
    }
    return persistQueue;
  };

  /** 打开 Footer 的交互式配置面板。 */
  pi.registerCommand("footer-layout", {
    description: "配置 Footer 状态布局",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/footer-layout 需要在 TUI 模式下使用", "error");
        return;
      }

      let draft = layout.getConfig();
      const claudeImportEnabled = await readClaudeMcpImportEnabled();
      persistResult = "ok";
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = [
          {
            id: "enabled",
            label: "启用 Footer 布局",
            description: "关闭后恢复 Pi 默认 Footer。",
            currentValue: draft.enabled ? "开启" : "关闭",
            values: ["开启", "关闭"],
          },
          {
            id: "mode",
            label: "状态布局模式",
            description:
              "each=各占一行，wrap=自动换行，group=按组排列，compact=单行截断。",
            currentValue: draft.mode,
            values: ["each", "wrap", "group", "compact"],
          },
          {
            id: "continuationIndent",
            label: "续行缩进",
            description: "超长状态换到下一行时，续行开头的空格数。",
            currentValue: String(draft.continuationIndent),
            values: Array.from({ length: 13 }, (_, index) => String(index)),
          },
          {
            id: "claudeMcpImportEnabled",
            label: "导入 Claude Code MCP",
            description:
              "开启后自动同步 Claude Code 用户级 MCP 到 pi，并在当前会话立即生效。",
            currentValue: claudeImportEnabled ? "开启" : "关闭",
            values: ["开启", "关闭"],
          },
          {
            id: "statusOrder",
            label: "状态排序",
            description: "用逗号分隔 key；未填写的 key 自动按字母序追加。",
            currentValue: draft.statusOrder.join(", "),
            submenu: (currentValue, submenuDone) =>
              createTextSubmenu(
                tui,
                theme,
                "状态排序（逗号分隔 key）",
                currentValue,
                submenuDone,
              ),
          },
          {
            id: "statusGroups",
            label: "状态分组",
            description:
              "group 模式生效；组之间用分号分隔，组内 key 用逗号分隔。",
            currentValue: formatStatusGroups(draft.statusGroups),
            submenu: (currentValue, submenuDone) =>
              createTextSubmenu(
                tui,
                theme,
                "状态分组（组用分号分隔）",
                currentValue,
                submenuDone,
              ),
          },
        ];

        const updateConfig = (id: string, newValue: string): void => {
          if (id === "claudeMcpImportEnabled") {
            void toggleClaudeMcpImport(newValue === "开启", pi, ctx);
            return;
          }
          draft = updateDraftConfig(draft, id, newValue);
          layout.setConfig(draft);
          applyFooter(ctx);
          queuePersist(draft, ctx);
        };

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 10),
          getSettingsListTheme(),
          updateConfig,
          () => done(undefined),
        );
        const container = new Container();
        container.addChild({
          render: (_width: number) => [
            theme.fg("accent", theme.bold("Footer Layout 配置")),
          ],
          invalidate: () => {},
        });
        container.addChild(settingsList);

        return {
          render(width: number): string[] {
            return container.render(width);
          },
          invalidate(): void {
            container.invalidate();
          },
          handleInput(data: string): void {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      await flushPersist(ctx);
      if (persistResult === "ok") {
        ctx.ui.notify("Footer 布局配置已应用", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    footerOwnedByLayout = false;
    lastAppliedConfig = undefined;
    layout.setContext(ctx);
    await layout.initialize();
    if (layout.isEnabled()) applyFooter(ctx);
    await syncClaudeMcp(pi, ctx);
  });
};

/** 读取 settings.json 中 claudeMcpImport.enabled；读取失败视为未开启。 */
async function readClaudeMcpImportEnabled(): Promise<boolean> {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    const parsed = JSON.parse(await readSettingsFile(settingsPath)) as unknown;
    return (
      isRecord(parsed) &&
      isRecord(parsed.claudeMcpImport) &&
      parsed.claudeMcpImport.enabled === true
    );
  } catch {
    return false;
  }
}

/** TUI 面板切换开关：写入 settings.json；开启时立即执行一次同步。 */
async function toggleClaudeMcpImport(
  enabled: boolean,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    const parsed = JSON.parse(await readSettingsFile(settingsPath)) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("settings.json 顶层必须是 JSON 对象");
    }
    const claudeMcpImport = isRecord(parsed.claudeMcpImport)
      ? parsed.claudeMcpImport
      : {};
    parsed.claudeMcpImport = { ...claudeMcpImport, enabled };
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude MCP 导入开关保存失败: ${message}`, "error");
    return;
  }
  if (enabled) await syncClaudeMcp(pi, ctx);
}

/** 按配置把 Claude Code 用户级 MCP 导入 pi 内置 mcp.json，并为本会话即时注册生效。 */
async function syncClaudeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const enabled = await readClaudeMcpImportEnabled();
  if (!enabled) return;

  try {
    const result = await syncClaudeMcpServers(getAgentDir());
    if (!result) return;
    for (const server of result.plan.toImport) {
      // 写文件负责持久化，注册让导入的服务器本会话立即可用，无需重启 Pi。
      // validateImportedServer 已按 pi 规则校验，这里经 unknown 收窄到具体配置类型。
      pi.registerMcpServer(
        server.name,
        server.config as unknown as McpServerConfig,
      );
    }
    notifyImportResult(ctx, result.plan, result.removed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude Code MCP 导入失败: ${message}`, "error");
  }
}

/** 同步结果汇总；无新增、无删除且仅有“已存在”的跳过时保持安静，避免每次启动打扰。 */
function notifyImportResult(
  ctx: ExtensionContext,
  plan: ImportPlan,
  removed: readonly string[],
): void {
  const invalid = plan.skipped.filter((item) => item.reason !== "已存在");
  if (
    plan.toImport.length === 0 &&
    invalid.length === 0 &&
    removed.length === 0
  ) {
    return;
  }

  const parts: string[] = [];
  if (plan.toImport.length > 0) {
    parts.push(`已导入: ${plan.toImport.map((s) => s.name).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`已移除: ${removed.join(", ")}（Claude 中已删除, 下次启动生效）`);
  }
  if (invalid.length > 0) {
    parts.push(
      `已跳过: ${invalid.map((s) => `${s.name}(${s.reason})`).join(", ")}`,
    );
  }
  ctx.ui.notify(`Claude Code MCP 同步完成. ${parts.join(". ")}.`, "info");
}

/** 将文本输入解析为去重后的状态 key 列表。 */
function parseStatusOrder(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 将文本输入解析为状态分组。 */
function parseStatusGroups(value: string): string[][] {
  return value
    .split(";")
    .map((group) => parseStatusOrder(group))
    .filter((group) => group.length > 0);
}

/** 将状态分组格式化为可再次编辑的单行文本。 */
function formatStatusGroups(groups: readonly (readonly string[])[]): string {
  return groups.map((group) => group.join(", ")).join("; ");
}

/** 把 SettingsList 的变更转换为新的、经过统一校验的 Footer 配置。 */
function updateDraftConfig(
  current: FooterLayoutConfig,
  id: string,
  newValue: string,
): FooterLayoutConfig {
  const next = {
    enabled: current.enabled,
    mode: current.mode,
    statusOrder: [...current.statusOrder],
    statusGroups: current.statusGroups.map((group) => [...group]),
    continuationIndent: current.continuationIndent,
  } as Record<string, unknown>;

  switch (id) {
    case "enabled":
      next.enabled = newValue === "开启";
      break;
    case "mode":
      next.mode = newValue;
      break;
    case "continuationIndent":
      next.continuationIndent = Number(newValue);
      break;
    case "statusOrder":
      next.statusOrder = parseStatusOrder(newValue);
      break;
    case "statusGroups":
      next.statusGroups = parseStatusGroups(newValue);
      break;
  }

  return parseFooterLayoutConfig(next);
}

/** 创建 SettingsList 的文本输入子面板。 */
function createTextSubmenu(
  tui: TUI,
  theme: ExtensionContext["ui"]["theme"],
  title: string,
  currentValue: string,
  done: (selectedValue?: string) => void,
): Component {
  const input = new Input();
  input.setValue(currentValue);
  input.onSubmit = (value) => done(value.trim());
  input.onEscape = () => done(undefined);

  return {
    render(width: number): string[] {
      return [
        theme.fg("accent", theme.bold(title)),
        "",
        ...input.render(width),
        "",
        theme.fg("dim", "Enter 保存 · Esc 取消"),
      ];
    },
    invalidate(): void {
      input.invalidate();
    },
    handleInput(data: string): void {
      input.handleInput(data);
      tui.requestRender();
    },
  };
}

/** 将 Footer 配置合并写入全局 settings.json，同时保留其它 Pi 设置。 */
async function persistFooterConfig(config: FooterLayoutConfig): Promise<void> {
  const settingsPath = join(getAgentDir(), "settings.json");
  const raw = await readSettingsFile(settingsPath);
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("settings.json 顶层必须是 JSON 对象");
  }

  parsed.footerLayout = {
    enabled: config.enabled,
    mode: config.mode,
    statusOrder: [...config.statusOrder],
    statusGroups: config.statusGroups.map((group) => [...group]),
    continuationIndent: config.continuationIndent,
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/** 读取全局 settings.json；文件不存在时从空对象开始。 */
async function readSettingsFile(settingsPath: string): Promise<string> {
  try {
    return await readFile(settingsPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "{}";
    }
    throw error;
  }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

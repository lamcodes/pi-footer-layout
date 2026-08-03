import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
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
  FooterLayout,
  parseFooterLayoutConfig,
  type FooterLayoutConfig,
} from "./src/footer-layout.ts";

/** 注册独立 Footer 扩展，并提供 /footer-layout TUI 配置入口。 */
export default (pi: ExtensionAPI) => {
  const layout = new FooterLayout();
  let persistQueue: Promise<void> = Promise.resolve();
  let footerOwnedByLayout = false;

  /** 根据最新配置安装或恢复 Footer。 */
  const applyFooter = (ctx: ExtensionContext): void => {
    if (!layout.isEnabled()) {
      // 只有本扩展之前接管过 Footer 时才恢复默认，避免干扰其它扩展。
      if (footerOwnedByLayout) {
        ctx.ui.setFooter(undefined);
        footerOwnedByLayout = false;
      }
      return;
    }
    ctx.ui.setFooter((tui, theme, footerData) =>
      layout.createComponent(tui, theme, footerData),
    );
    footerOwnedByLayout = true;
  };

  /** 串行写入 settings.json，避免连续按键造成互相覆盖。 */
  const queuePersist = (
    config: FooterLayoutConfig,
    ctx: ExtensionContext,
  ): void => {
    persistQueue = persistQueue
      .then(() => persistFooterConfig(config))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Footer 配置保存失败: ${message}`, "error");
      });
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

      await persistQueue;
      ctx.ui.notify("Footer 布局配置已应用", "info");
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    footerOwnedByLayout = false;
    layout.setContext(ctx);
    await layout.initialize();
    if (layout.isEnabled()) applyFooter(ctx);
  });
};

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

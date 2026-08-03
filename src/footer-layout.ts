import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Footer 状态的布局模式。 */
export type FooterStatusMode = "each" | "wrap" | "group" | "compact";

/** Footer 配置，位于 ~/.pi/agent/settings.json 的 footerLayout 节点。 */
export interface FooterLayoutConfig {
  enabled: boolean;
  mode: FooterStatusMode;
  statusOrder: string[];
  statusGroups: string[][];
  continuationIndent: number;
}

/** 可被状态布局算法消费的扩展状态。 */
export interface FooterStatusEntry {
  key: string;
  text: string;
}

const MAX_CONTINUATION_INDENT = 80;
const STATUS_SEPARATOR = "   ";

/** 默认关闭扩展，并让常用状态按用户最容易理解的顺序排列。 */
export const DEFAULT_CONFIG: Readonly<FooterLayoutConfig> = {
  enabled: false,
  mode: "each",
  statusOrder: [
    "mcp",
    "mcp-auth",
    "folder-history",
    "tokenSpeed",
    "subagents",
    "pi-goal",
  ],
  statusGroups: [],
  continuationIndent: 3,
};

/**
 * 独立 Footer 布局模块：保留 Pi 默认的项目/统计信息，替换扩展状态行布局。
 * 所有状态都从 FooterDataProvider 动态读取，因此未知状态无需修改本模块。
 */
export class FooterLayout {
  private context?: ExtensionContext;
  private config: FooterLayoutConfig = cloneConfig(DEFAULT_CONFIG);

  /** 保存最新会话上下文，Footer render 时读取最新数据。 */
  setContext(context: ExtensionContext): void {
    this.context = context;
  }

  /** 读取用户配置；文件不存在或格式错误时使用安全的默认配置。 */
  async initialize(): Promise<void> {
    // 每次初始化先恢复默认值，避免 reload 后沿用旧会话配置。
    this.config = cloneConfig(DEFAULT_CONFIG);
    try {
      const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const raw = await readFile(join(getAgentDir(), "settings.json"), "utf8");
      const root = JSON.parse(raw) as Record<string, unknown>;
      this.config = parseFooterLayoutConfig(root.footerLayout);
    } catch {
      // 配置读取失败时保留默认关闭状态，不阻塞 Pi 启动。
    }
  }

  /** 告知入口是否应替换 Pi 默认 Footer。 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 返回当前配置副本，供 TUI 编辑器生成可变草稿。 */
  getConfig(): FooterLayoutConfig {
    return cloneConfig(this.config);
  }

  /** 应用一份已经校验过的配置，供 TUI 命令即时切换布局。 */
  setConfig(config: FooterLayoutConfig): void {
    this.config = cloneConfig(config);
  }

  /** 创建 Pi custom footer 所需的组件。 */
  createComponent(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    footerData: ReadonlyFooterDataProvider,
  ): Component & { dispose?(): void } {
    return new FooterComponent(
      () => this.context,
      theme,
      footerData,
      this.config,
      tui,
    );
  }
}

/**
 * 将 settings.json 中的未知值解析为稳定配置。
 * enabled 必须显式为 true，避免写出空对象时意外接管 Pi Footer。
 */
export function parseFooterLayoutConfig(value: unknown): FooterLayoutConfig {
  if (!isRecord(value)) return cloneConfig(DEFAULT_CONFIG);

  const legacyMode =
    value.wrapStatuses === false
      ? "compact"
      : value.wrapStatuses === true
        ? "wrap"
        : undefined;
  const mode = isFooterStatusMode(value.mode)
    ? value.mode
    : (legacyMode ?? DEFAULT_CONFIG.mode);
  const statusOrder = Array.isArray(value.statusOrder)
    ? normalizeKeyList(value.statusOrder)
    : [...DEFAULT_CONFIG.statusOrder];
  const statusGroups = Array.isArray(value.statusGroups)
    ? normalizeStatusGroups(value.statusGroups)
    : cloneGroups(DEFAULT_CONFIG.statusGroups);
  const continuationIndent = parseContinuationIndent(
    value.continuationIndent,
  );

  return {
    enabled: value.enabled === true,
    mode,
    statusOrder,
    statusGroups,
    continuationIndent,
  };
}

/**
 * 按配置排序并清理状态文本。
 * 清理空状态可以兼容 pi-goal 使用空字符串隐藏状态的实现方式。
 */
export function sortStatusEntries(
  statuses: Iterable<readonly [string, string]>,
  statusOrder: readonly string[],
): FooterStatusEntry[] {
  const ranks = new Map<string, number>();
  for (const [index, key] of statusOrder.entries()) {
    if (!ranks.has(key)) ranks.set(key, index);
  }

  return [...statuses]
    .map(([key, text]) => ({ key, text: sanitize(text) }))
    .filter((entry) => entry.text.length > 0)
    .sort(
      (left, right) =>
        (ranks.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
          (ranks.get(right.key) ?? Number.MAX_SAFE_INTEGER) ||
        left.key.localeCompare(right.key),
    );
}

/**
 * 渲染扩展状态行。
 * each 保证每个状态从新行开始；wrap 尽量同行；group 只合并显式配置的状态。
 */
export function layoutStatusLines(
  statuses: Iterable<readonly [string, string]>,
  width: number,
  config: Pick<
    FooterLayoutConfig,
    "mode" | "statusOrder" | "statusGroups" | "continuationIndent"
  >,
): string[] {
  const safeWidth = normalizeWidth(width);
  const entries = sortStatusEntries(statuses, config.statusOrder);
  if (entries.length === 0) return [];

  switch (config.mode) {
    case "compact":
      return [
        fitToWidth(
          entries.map((entry) => entry.text).join(" "),
          safeWidth,
          "...",
        ),
      ];
    case "wrap":
      return renderFlowGroups([entries], safeWidth, config.continuationIndent);
    case "group":
      return renderFlowGroups(
        makeStatusGroups(entries, config.statusGroups),
        safeWidth,
        config.continuationIndent,
      );
    case "each":
    default:
      return entries.flatMap((entry) =>
        wrapStatusItem(entry.text, safeWidth, config.continuationIndent),
      );
  }
}

class FooterComponent implements Component {
  private readonly getContext: () => ExtensionContext | undefined;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private readonly footerData: ReadonlyFooterDataProvider;
  private readonly config: FooterLayoutConfig;
  private readonly tui: TUI;

  constructor(
    getContext: () => ExtensionContext | undefined,
    theme: ExtensionContext["ui"]["theme"],
    footerData: ReadonlyFooterDataProvider,
    config: FooterLayoutConfig,
    // 保持 Footer 与当前 TUI 生命周期关联；组件本身不需要主动调用 TUI。
    tui: TUI,
  ) {
    this.getContext = getContext;
    this.theme = theme;
    this.footerData = footerData;
    this.config = config;
    this.tui = tui;
  }

  /** Footer 无缓存，状态更新后让 Pi 重新调用 render。 */
  invalidate(): void {
    void this.tui;
  }

  /** 渲染默认 Footer 信息和可变数量的扩展状态行。 */
  render(width: number): string[] {
    const context = this.getContext();
    if (!context) return ["", ""];

    const safeWidth = normalizeWidth(width);
    return [
      ...this.renderProjectLine(context, safeWidth),
      ...this.renderStatsLine(context, safeWidth),
      ...layoutStatusLines(
        this.footerData.getExtensionStatuses().entries(),
        safeWidth,
        this.config,
      ),
    ];
  }

  /** 渲染当前项目路径、Git 分支和会话名称。 */
  private renderProjectLine(
    context: ExtensionContext,
    width: number,
  ): string[] {
    let cwd = formatCwd(
      context.sessionManager.getCwd(),
      process.env.HOME || process.env.USERPROFILE,
    );
    const branch = this.footerData.getGitBranch();
    if (branch) cwd += ` (${branch})`;
    const sessionName = context.sessionManager.getSessionName();
    if (sessionName) cwd += ` • ${sanitize(sessionName)}`;
    return [fitToWidth(this.theme.fg("dim", cwd), width, this.theme.fg("dim", "..."))];
  }

  /** 渲染 token、上下文占用、缓存命中率、成本和模型信息。 */
  private renderStatsLine(context: ExtensionContext, width: number): string[] {
    const totals = collectUsage(context);
    const statsParts: string[] = [];
    if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
    if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
    if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
    if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
    if (
      (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
      totals.latestCacheHitRate !== undefined
    ) {
      statsParts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
    }
    if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

    const usage = context.getContextUsage() as
      | { percent?: number | null; contextWindow?: number }
      | undefined;
    const contextPercentValue =
      typeof usage?.percent === "number" && Number.isFinite(usage.percent)
        ? usage.percent
        : 0;
    const contextPercent =
      usage?.percent === null ? "?" : contextPercentValue.toFixed(1);
    const contextWindow = usage?.contextWindow ?? context.model?.contextWindow ?? 0;
    const autoIndicator = " (auto)";
    const contextDisplay =
      contextPercent === "?"
        ? `?/${formatTokens(contextWindow)}${autoIndicator}`
        : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
    const coloredContext =
      contextPercentValue > 90
        ? this.theme.fg("error", contextDisplay)
        : contextPercentValue > 70
          ? this.theme.fg("warning", contextDisplay)
          : contextDisplay;
    statsParts.push(coloredContext);

    let statsLeft = statsParts.join(" ");
    if (visibleWidth(statsLeft) > width) {
      statsLeft = fitToWidth(statsLeft, width, "...");
    }

    const modelName = context.model?.id || "no-model";
    const thinking = context.thinkingLevel;
    let right =
      thinking && thinking !== "off"
        ? `${modelName} • ${thinking}`
        : `${modelName} • thinking off`;
    // 多 provider 时沿用 Pi 默认 Footer 的 provider 前缀，但只有放得下才显示。
    if (this.footerData.getAvailableProviderCount() > 1 && context.model) {
      const withProvider = `(${context.model.provider}) ${right}`;
      if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
        right = withProvider;
      }
    }
    const rightWidth = visibleWidth(right);
    let statsLine: string;

    if (visibleWidth(statsLeft) + 2 + rightWidth <= width) {
      const padding = " ".repeat(
        Math.max(0, width - visibleWidth(statsLeft) - rightWidth),
      );
      statsLine = statsLeft + padding + right;
    } else {
      const availableForRight = width - visibleWidth(statsLeft) - 2;
      if (availableForRight > 0) {
        const truncatedRight = fitToWidth(right, availableForRight, "");
        const padding = " ".repeat(
          Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(truncatedRight)),
        );
        statsLine = statsLeft + padding + truncatedRight;
      } else {
        statsLine = statsLeft;
      }
    }

    // 分段加 dim，避免上下文用量的 warning/error 颜色被外层重置。
    const dimStatsLeft = this.theme.fg("dim", statsLeft);
    const remainder = statsLine.slice(statsLeft.length);
    return [fitToWidth(dimStatsLeft + this.theme.fg("dim", remainder), width, "")];
  }
}

/** 将配置指定的状态合并为组；未配置状态各自成为独立组。 */
function makeStatusGroups(
  entries: FooterStatusEntry[],
  configuredGroups: readonly (readonly string[])[],
): FooterStatusEntry[][] {
  const assigned = new Set<string>();
  const groups: FooterStatusEntry[][] = [];

  for (const configuredGroup of configuredGroups) {
    const keys = new Set(configuredGroup);
    const group = entries.filter(
      (entry) => keys.has(entry.key) && !assigned.has(entry.key),
    );
    if (group.length === 0) continue;
    for (const entry of group) assigned.add(entry.key);
    groups.push(group);
  }

  // 新扩展只要调用 setStatus() 就会自动进入这里，并默认独占一组。
  for (const entry of entries) {
    if (!assigned.has(entry.key)) groups.push([entry]);
  }
  return groups;
}

/** 在一个或多个状态组内按宽度流式排版。 */
function renderFlowGroups(
  groups: readonly (readonly FooterStatusEntry[])[],
  width: number,
  continuationIndent: number,
): string[] {
  return groups.flatMap((group) =>
    renderFlowItems(
      group.map((entry) => entry.text),
      width,
      continuationIndent,
    ),
  );
}

/** 尽量把同组状态放在一行，单个过长状态则按字符安全换行。 */
function renderFlowItems(
  items: readonly string[],
  width: number,
  continuationIndent: number,
): string[] {
  const lines: string[] = [];
  let current = "";

  for (const item of items) {
    if (visibleWidth(item) > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(...wrapStatusItem(item, width, continuationIndent));
      continue;
    }

    const candidate = current ? `${current}${STATUS_SEPARATOR}${item}` : item;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = item;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/** 将一个过宽状态拆成不超过终端宽度的多行，并为续行保留缩进。 */
function wrapStatusItem(
  item: string,
  width: number,
  continuationIndent: number,
): string[] {
  // 未超宽的状态无需为续行预留缩进，避免正常文本被无谓拆行。
  if (visibleWidth(item) <= width) return [fitToWidth(item, width, "")];

  const indentWidth = Math.min(
    Math.max(0, Math.floor(continuationIndent)),
    Math.max(0, width - 1),
  );
  const indent = " ".repeat(indentWidth);
  const contentWidth = Math.max(1, width - indentWidth);
  const wrapped = wrapTextWithAnsi(item, contentWidth);
  if (wrapped.length === 0) return [];

  return wrapped.map((line, index) =>
    fitToWidth(index === 0 ? line : indent + line, width, ""),
  );
}

/** 清理会破坏 Footer 行结构的换行和制表符，同时保留 ANSI 颜色序列。 */
function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** 将终端宽度归一化，避免极窄或异常宽度传入 repeat/wrap。 */
function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

/** 使用可见宽度截断文本，并在底层工具异常时再次无省略号截断。 */
function fitToWidth(text: string, width: number, ellipsis: string): string {
  const result = truncateToWidth(text, width, ellipsis);
  return visibleWidth(result) <= width
    ? result
    : truncateToWidth(text, width, "");
}

/** 将主目录下的项目路径显示为 Pi 默认风格的 ~ 路径。 */
function formatCwd(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** 使用 Pi 默认的紧凑格式显示 token 数量。 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: unknown;
}

interface SessionEntryLike {
  type?: string;
  usage?: UsageLike;
  message?: {
    role?: string;
    usage?: UsageLike;
  };
}

/** 兼容旧版数字成本和新版成本明细对象，取得总成本。 */
function getCostTotal(cost: unknown): number {
  if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  if (cost && typeof cost === "object") {
    const total = (cost as { total?: unknown }).total;
    if (typeof total === "number" && Number.isFinite(total)) return total;
  }
  return 0;
}

/** 将未知 usage 数值安全转换为非负数字。 */
function getUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/** 从当前会话汇总默认 Footer 展示的 token 使用量和最新缓存命中率。 */
function collectUsage(context: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const rawEntry of context.sessionManager.getEntries()) {
    const entry = rawEntry as SessionEntryLike;
    const usage =
      entry.type === "message" &&
      (entry.message?.role === "assistant" ||
        entry.message?.role === "toolResult")
        ? entry.message?.usage
        : entry.type === "branch_summary" || entry.type === "compaction"
          ? entry.usage
          : undefined;
    if (!usage) continue;

    totals.input += getUsageNumber(usage.input);
    totals.output += getUsageNumber(usage.output);
    totals.cacheRead += getUsageNumber(usage.cacheRead);
    totals.cacheWrite += getUsageNumber(usage.cacheWrite);
    totals.cost += getCostTotal(usage.cost);

    if (entry.message?.role === "assistant") {
      const latestPromptTokens =
        getUsageNumber(usage.input) +
        getUsageNumber(usage.cacheRead) +
        getUsageNumber(usage.cacheWrite);
      totals.latestCacheHitRate =
        latestPromptTokens > 0
          ? (getUsageNumber(usage.cacheRead) / latestPromptTokens) * 100
          : undefined;
    }
  }
  return totals;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断字符串是否为受支持的布局模式。 */
function isFooterStatusMode(value: unknown): value is FooterStatusMode {
  return value === "each" || value === "wrap" || value === "group" || value === "compact";
}

/** 规范化状态 key 列表并去重。 */
function normalizeKeyList(value: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 规范化分组配置，忽略非法或空分组。 */
function normalizeStatusGroups(value: readonly unknown[]): string[][] {
  return value
    .filter((group): group is readonly unknown[] => Array.isArray(group))
    .map((group) => normalizeKeyList(group))
    .filter((group) => group.length > 0);
}

/** 解析并限制续行缩进，避免恶意配置造成超宽或 repeat 异常。 */
function parseContinuationIndent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_CONFIG.continuationIndent;
  }
  return Math.min(MAX_CONTINUATION_INDENT, Math.floor(value));
}

/** 复制配置，避免 Footer 组件共享可变数组。 */
function cloneConfig(config: Readonly<FooterLayoutConfig>): FooterLayoutConfig {
  return {
    enabled: config.enabled,
    mode: config.mode,
    statusOrder: [...config.statusOrder],
    statusGroups: cloneGroups(config.statusGroups),
    continuationIndent: config.continuationIndent,
  };
}

/** 深复制分组配置。 */
function cloneGroups(groups: readonly (readonly string[])[]): string[][] {
  return groups.map((group) => [...group]);
}

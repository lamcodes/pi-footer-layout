import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 从 Claude Code 导入的 MCP 服务器候选。 */
export interface ImportedServer {
  name: string;
  config: Record<string, unknown>;
}

/** 跳过条目：名字 + 跳过原因。 */
export interface SkippedServer {
  name: string;
  reason: string;
}

/** 一次导入的执行计划：待新增条目与跳过条目。 */
export interface ImportPlan {
  toImport: ImportedServer[];
  skipped: SkippedServer[];
}

/** 校验规则与 pi validateMcpServerConfig 同口径；通过时返回 undefined，否则返回原因。 */
export function validateImportedServer(
  name: string,
  value: unknown,
): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "名称只能包含字母、数字、下划线和连字符";
  }
  if (!isRecord(value)) return "配置必须是对象";
  const type = value.type;
  // pi 0.99.x 不支持 legacy SSE 传输，只能改用 streamable HTTP URL。
  if (type === "sse") return "pi 不支持 legacy SSE 传输";
  if (
    typeof value.url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    try {
      const parsed = new URL(value.url);
      if (!/^https?:$/.test(parsed.protocol)) return "url 必须是 http 或 https";
    } catch {
      return "url 无法解析";
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return "headers 必须是字符串映射";
    }
    return undefined;
  }
  if (
    typeof value.command === "string" &&
    (type === undefined || type === "stdio")
  ) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every(isString))
    ) {
      return "args 必须是字符串数组";
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return "env 必须是字符串映射";
    }
    return undefined;
  }
  return "缺少 url 或 command";
}

/** 从解析后的 ~/.claude.json 对象提取用户级 mcpServers 候选。 */
export function collectClaudeServers(claudeRaw: unknown): ImportedServer[] {
  if (!isRecord(claudeRaw)) return [];
  const servers = claudeRaw.mcpServers;
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, config]) => ({
    name,
    config: isRecord(config) ? config : {},
  }));
}

/** pi 配置里已存在的服务器名集合；配置缺失或非法时视为空。 */
function existingServerNames(piConfigRaw: unknown): Set<string> {
  if (isRecord(piConfigRaw) && isRecord(piConfigRaw.mcpServers)) {
    return new Set(Object.keys(piConfigRaw.mcpServers));
  }
  return new Set();
}

/** 插件的导入记录：sidecar 文件里记下本插件导入过的服务器名，跟随删除只作用于这份名单。 */
export interface ProvenanceState {
  imported: string[];
}

/** 解析导入记录文件；缺失或格式非法时视为空记录。 */
export function parseProvenance(raw: unknown): ProvenanceState {
  if (isRecord(raw) && Array.isArray(raw.imported)) {
    return { imported: raw.imported.filter(isString) };
  }
  return { imported: [] };
}

export interface RemovalPlan {
  /** Claude 已不存在、pi 仍存在的导入条目，应当从 pi 配置移除。 */
  toRemove: string[];
  /** Claude 仍存在的导入条目，继续留在记录里。 */
  keep: string[];
}

/**
 * 计划跟随删除：只删“插件导入过、Claude 已删除、pi 仍存在”的名字；
 * 用户手动添加或手动禁用的条目不在记录名单里，永不触碰。
 */
export function planRemovals(
  claudeRaw: unknown,
  piConfigRaw: unknown,
  provenance: ProvenanceState,
): RemovalPlan {
  const claudeNames = new Set(
    collectClaudeServers(claudeRaw).map((server) => server.name),
  );
  const piNames = existingServerNames(piConfigRaw);
  const toRemove: string[] = [];
  const keep: string[] = [];

  for (const name of provenance.imported) {
    if (claudeNames.has(name)) {
      keep.push(name);
      continue;
    }
    if (piNames.has(name)) {
      toRemove.push(name);
    }
    // Claude 与 pi 两边都不存在的名字（用户已在 /mcp 里移除）静默移出记录。
  }
  return { toRemove, keep };
}

/** 从 pi 配置对象移除指定名字并返回新对象；其它顶层键与原对象不被改动。 */
export function applyRemovals(
  piConfigRaw: unknown,
  names: readonly string[],
): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(piConfigRaw)
    ? { ...piConfigRaw }
    : {};
  if (!isRecord(base.mcpServers)) return base;
  const servers: Record<string, unknown> = { ...base.mcpServers };
  for (const name of names) {
    delete servers[name];
  }
  base.mcpServers = servers;
  return base;
}

/** 生成导入计划：只新增 pi 里不存在的名字；已有条目尊重 pi 侧配置，非法条目跳过并给出原因。 */
export function planClaudeMcpImport(
  claudeRaw: unknown,
  piConfigRaw: unknown,
): ImportPlan {
  const existing = existingServerNames(piConfigRaw);
  const toImport: ImportedServer[] = [];
  const skipped: SkippedServer[] = [];

  for (const candidate of collectClaudeServers(claudeRaw)) {
    if (existing.has(candidate.name)) {
      skipped.push({ name: candidate.name, reason: "已存在" });
      continue;
    }
    const error = validateImportedServer(candidate.name, candidate.config);
    if (error) {
      skipped.push({ name: candidate.name, reason: error });
      continue;
    }
    toImport.push(candidate);
  }
  return { toImport, skipped };
}

/** 把导入计划合并进 pi 配置对象并返回新对象；原对象与其它顶层键不被修改。 */
export function applyImportPlan(
  piConfigRaw: unknown,
  plan: ImportPlan,
): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(piConfigRaw)
    ? { ...piConfigRaw }
    : {};
  const servers: Record<string, unknown> = isRecord(base.mcpServers)
    ? { ...base.mcpServers }
    : {};
  for (const server of plan.toImport) {
    servers[server.name] = server.config;
  }
  base.mcpServers = servers;
  return base;
}

export interface SyncResult {
  plan: ImportPlan;
  /** 本次跟随删除的服务器名；连接断开要等下次启动 Pi。 */
  removed: string[];
}

/**
 * 执行一次 Claude Code 用户级 MCP 同步：
 * 读取双方配置，新增缺失条目、跟随删除 Claude 已移除的导入条目，写入 pi 的 mcp.json，
 * 并维护导入记录 sidecar 文件（~/.pi/agent/claude-mcp-import.json）。
 * Claude 未安装（无 ~/.claude.json）时返回 undefined，视为无事可做。
 */
export async function syncClaudeMcpServers(
  agentDir: string,
): Promise<SyncResult | undefined> {
  const claudeRaw = await readJsonIfExists(join(homedir(), ".claude.json"));
  if (claudeIsMissing(claudeRaw)) return undefined;

  const mcpPath = join(agentDir, "mcp.json");
  const piRaw = await readJsonIfExists(mcpPath);
  if (piRaw !== undefined && !isRecord(piRaw)) {
    throw new Error("pi mcp.json 顶层必须是 JSON 对象");
  }

  const provenancePath = join(agentDir, "claude-mcp-import.json");
  const provenanceRaw = await readJsonIfExists(provenancePath);
  if (provenanceRaw !== undefined && !isRecord(provenanceRaw)) {
    throw new Error("claude-mcp-import.json 顶层必须是 JSON 对象");
  }
  const provenance = parseProvenance(provenanceRaw);

  const plan = planClaudeMcpImport(claudeRaw, piRaw);
  const removals = planRemovals(claudeRaw, piRaw, provenance);

  let config: unknown = piRaw;
  let configChanged = false;
  if (plan.toImport.length > 0) {
    config = applyImportPlan(config, plan);
    configChanged = true;
  }
  if (removals.toRemove.length > 0) {
    config = applyRemovals(config, removals.toRemove);
    configChanged = true;
  }
  if (configChanged) {
    await mkdir(dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  // 记录名单 = 仍存在于 Claude 的旧条目 + 本次新导入的；排序保证文件内容稳定，便于对比。
  const nextImported = [
    ...new Set([
      ...removals.keep,
      ...plan.toImport.map((server) => server.name),
    ]),
  ].sort();
  if (!nameListsEqual(nextImported, provenance.imported)) {
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(
      provenancePath,
      `${JSON.stringify({ imported: nextImported }, null, 2)}\n`,
      "utf-8",
    );
  }

  return { plan, removed: removals.toRemove };
}

/** 忽略顺序比较两份名字列表是否一致。 */
function nameListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((name, index) => name === sortedRight[index]);
}

/** 区分“文件不存在”与“文件存在但解析失败”：后者要抛出让调用方报告。 */
async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
  return JSON.parse(raw);
}

/** ~/.claude.json 缺失表示没装 Claude Code，静默跳过。 */
function claudeIsMissing(claudeRaw: unknown | undefined): boolean {
  return claudeRaw === undefined;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断值是否为字符串。 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 判断未知值是否为字符串到字符串的映射。 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

/** 判断文件系统错误是否为 ENOENT。 */
function isENOENT(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

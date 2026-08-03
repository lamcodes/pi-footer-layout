import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_CONFIG,
  layoutStatusLines,
  parseFooterLayoutConfig,
  sortStatusEntries,
} from "../src/footer-layout.ts";

function layout(
  mode: "each" | "wrap" | "group" | "compact",
  statuses: ReadonlyMap<string, string>,
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
): string[] {
  return layoutStatusLines(statuses.entries(), 80, {
    mode,
    statusOrder: [...DEFAULT_CONFIG.statusOrder],
    statusGroups: [],
    continuationIndent: DEFAULT_CONFIG.continuationIndent,
    ...overrides,
  });
}

test("each 模式让每个状态从新行开始", () => {
  assert.deepEqual(
    layout(
      "each",
      new Map([
        ["tokenSpeed", "TPS"],
        ["mcp", "MCP"],
        ["folder-history", "History"],
      ]),
    ),
    ["MCP", "History", "TPS"],
  );
  assert.deepEqual(layout("each", new Map([["mcp", "x".repeat(78)]])), [
    "x".repeat(78),
  ]);
});

test("未知状态自动加入排序结果", () => {
  const entries = sortStatusEntries(
    new Map([
      ["new-extension", "New"],
      ["tokenSpeed", "TPS"],
      ["mcp", "MCP"],
    ]).entries(),
    ["mcp", "tokenSpeed"],
  );

  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["mcp", "tokenSpeed", "new-extension"],
  );
});

test("wrap 模式只在宽度不足时换行", () => {
  const lines = layout(
    "wrap",
    new Map([
      ["mcp", "MCP"],
      ["folder-history", "History"],
      ["tokenSpeed", "TPS"],
    ]),
    { statusOrder: ["mcp", "folder-history", "tokenSpeed"] },
  );

  assert.deepEqual(lines, ["MCP   History   TPS"]);

  const narrowLines = layoutStatusLines(
    new Map([
      ["mcp", "MCP"],
      ["folder-history", "History"],
      ["tokenSpeed", "TPS"],
    ]).entries(),
    15,
    {
      mode: "wrap",
      statusOrder: ["mcp", "folder-history", "tokenSpeed"],
      statusGroups: [],
      continuationIndent: 3,
    },
  );
  assert.deepEqual(narrowLines, ["MCP   History", "TPS"]);
});

test("group 模式只合并显式配置的状态", () => {
  const lines = layout(
    "group",
    new Map([
      ["mcp-auth", "Auth"],
      ["new-extension", "New"],
      ["mcp", "MCP"],
      ["folder-history", "History"],
    ]),
    {
      statusOrder: ["mcp", "mcp-auth", "folder-history", "new-extension"],
      statusGroups: [["mcp", "mcp-auth"]],
    },
  );

  assert.deepEqual(lines, ["MCP   Auth", "History", "New"]);
});

test("过宽状态及 ANSI 文本不会超过终端宽度", () => {
  const lines = layoutStatusLines(
    new Map([["mcp", "\u001b[31m1234567890\u001b[39m"]]).entries(),
    5,
    {
      mode: "each",
      statusOrder: ["mcp"],
      statusGroups: [],
      continuationIndent: 2,
    },
  );

  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 5));
});

test("compact 模式保持单行并安全截断", () => {
  const lines = layoutStatusLines(
    new Map([
      ["mcp", "12345678901234567890"],
      ["tokenSpeed", "TPS"],
    ]).entries(),
    10,
    {
      mode: "compact",
      statusOrder: ["mcp", "tokenSpeed"],
      statusGroups: [],
      continuationIndent: 3,
    },
  );

  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 10);
});

test("配置解析显式启用，并兼容旧 wrapStatuses", () => {
  assert.equal(parseFooterLayoutConfig(undefined).enabled, false);
  assert.equal(parseFooterLayoutConfig({}).enabled, false);
  assert.equal(
    parseFooterLayoutConfig({ enabled: true, wrapStatuses: false }).mode,
    "compact",
  );
  assert.equal(
    parseFooterLayoutConfig({ enabled: true, wrapStatuses: true }).mode,
    "wrap",
  );
  assert.equal(
    parseFooterLayoutConfig({
      enabled: true,
      mode: "each",
      wrapStatuses: false,
    }).mode,
    "each",
  );
  assert.equal(
    parseFooterLayoutConfig({ enabled: "true", mode: "each" }).enabled,
    false,
  );
  assert.equal(
    parseFooterLayoutConfig({ enabled: true, mode: "group" }).mode,
    "group",
  );
});

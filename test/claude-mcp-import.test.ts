import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyImportPlan,
  applyRemovals,
  collectClaudeServers,
  parseProvenance,
  planClaudeMcpImport,
  planRemovals,
  validateImportedServer,
} from "../src/claude-mcp-import.ts";

test("collectClaudeServers 提取用户级 mcpServers，容错缺失与非法输入", () => {
  assert.deepEqual(
    collectClaudeServers({
      mcpServers: {
        jira: { command: "npx", args: ["-y", "jira-mcp"] },
      },
    }),
    [{ name: "jira", config: { command: "npx", args: ["-y", "jira-mcp"] } }],
  );
  assert.deepEqual(collectClaudeServers(undefined), []);
  assert.deepEqual(collectClaudeServers({}), []);
  assert.deepEqual(collectClaudeServers({ mcpServers: "bad" }), []);
});

test("validateImportedServer 接受 Claude 常见的 stdio 与 http 条目", () => {
  // Claude Code 的 stdio 条目没有 type 字段。
  assert.equal(
    validateImportedServer("local", {
      command: "npx",
      args: ["-y", "server"],
      env: { KEY: "value" },
    }),
    undefined,
  );
  assert.equal(
    validateImportedServer("remote", { type: "http", url: "https://mcp.example.com/api" }),
    undefined,
  );
  assert.equal(validateImportedServer("remote2", { url: "http://127.0.0.1:8080/mcp" }), undefined);
});

test("validateImportedServer 拒绝 pi 不支持的条目并给出原因", () => {
  assert.match(
    validateImportedServer("legacy", { type: "sse", url: "https://example.com/sse" }) ?? "",
    /SSE/,
  );
  assert.match(validateImportedServer("no-transport", { foo: 1 }) ?? "", /url 或 command/);
  assert.match(validateImportedServer("ftp", { url: "ftp://example.com" }) ?? "", /http 或 https/);
  assert.match(validateImportedServer("bad name", { command: "x" }) ?? "", /名称/);
  assert.match(
    validateImportedServer("bad-args", { command: "x", args: [1] }) ?? "",
    /args/,
  );
  assert.match(
    validateImportedServer("bad-env", { command: "x", env: { K: 1 } }) ?? "",
    /env/,
  );
});

test("planClaudeMcpImport 只新增缺失名字，已存在与非法条目跳过", () => {
  const plan = planClaudeMcpImport(
    {
      mcpServers: {
        fresh: { command: "npx", args: ["-y", "fresh"] },
        existing: { command: "old" },
        broken: { type: "sse", url: "https://example.com/sse" },
      },
    },
    { mcpServers: { existing: { command: "pi-version" } } },
  );

  assert.deepEqual(
    plan.toImport.map((server) => server.name),
    ["fresh"],
  );
  assert.deepEqual(
    plan.skipped,
    [
      { name: "existing", reason: "已存在" },
      { name: "broken", reason: "pi 不支持 legacy SSE 传输" },
    ],
  );
});

test("planClaudeMcpImport 在 pi 配置缺失或非法时视为空配置", () => {
  const plan = planClaudeMcpImport(
    { mcpServers: { fresh: { command: "x" } } },
    undefined,
  );
  assert.equal(plan.toImport.length, 1);
  assert.equal(plan.skipped.length, 0);
});

test("applyImportPlan 合并条目，保留其它顶层键且不改动原对象", () => {
  const piConfig = {
    $schema: "https://example.com/schema.json",
    mcpServers: { existing: { command: "keep" } },
  };
  const plan = planClaudeMcpImport(
    { mcpServers: { fresh: { command: "npx" } } },
    piConfig,
  );

  const merged = applyImportPlan(piConfig, plan) as {
    $schema: string;
    mcpServers: Record<string, { command: string }>;
  };

  assert.equal(merged.$schema, "https://example.com/schema.json");
  assert.deepEqual(merged.mcpServers.existing, { command: "keep" });
  assert.deepEqual(merged.mcpServers.fresh, { command: "npx" });
  // 原对象保持不变，避免调用方误用被修改的旧引用。
  assert.deepEqual(Object.keys(piConfig.mcpServers), ["existing"]);
});

test("parseProvenance 容错缺失与非法记录", () => {
  assert.deepEqual(parseProvenance(undefined), { imported: [] });
  assert.deepEqual(parseProvenance({ imported: ["a", 1, "b"] }), {
    imported: ["a", "b"],
  });
  assert.deepEqual(parseProvenance({ imported: "bad" }), { imported: [] });
});

test("planRemovals 只删除插件导入过且 Claude 已移除的条目", () => {
  const claudeRaw = {
    mcpServers: {
      "still-there": { command: "keep-me" },
      "not-in-pi": { command: "ignore" },
    },
  };
  const piConfigRaw = {
    mcpServers: {
      "still-there": { command: "keep-me" },
      "gone-from-claude": { command: "remove-me" },
      manual: { command: "user-added" },
    },
  };

  const result = planRemovals(claudeRaw, piConfigRaw, {
    imported: ["still-there", "gone-from-claude", "removed-both-sides"],
  });

  // removed-both-sides 两边都不存在，静默移出记录；manual 不在记录里，永不触碰。
  assert.deepEqual(result.toRemove, ["gone-from-claude"]);
  assert.deepEqual(result.keep, ["still-there"]);
});

test("planRemovals 在配置缺失时视为空配置", () => {
  const result = planRemovals(undefined, undefined, {
    imported: ["gone-from-claude"],
  });
  assert.deepEqual(result.toRemove, []);
  assert.deepEqual(result.keep, []);
});

test("applyRemovals 移除指定名字，保留其它键且不改动原对象", () => {
  const piConfig = {
    mcpServers: {
      drop: { command: "x" },
      keep: { command: "y" },
    },
  };
  const merged = applyRemovals(piConfig, ["drop"]) as {
    mcpServers: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(merged.mcpServers), ["keep"]);
  assert.deepEqual(Object.keys(piConfig.mcpServers), ["drop", "keep"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentContext, renderSystemPrompt, parseFrontmatter } from "../dist/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentsmd-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "# Root rules\nBe nice.");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "mcp-fs" } } }));
  const sub = join(root, "packages", "app");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "CLAUDE.md"), "# App rules\nUse tabs.");
  const skill = join(root, ".claude", "skills", "deploy");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nRun deploy.sh");
  return { root, sub };
}

test("walks up, finds rules, mcp servers and skills", () => {
  const { root, sub } = fixture();
  const ctx = loadAgentContext(sub, { root, global: false });
  assert.equal(ctx.rules.length, 2);
  assert.equal(ctx.rules[0].kind, "claude-md");
  assert.equal(ctx.rules[0].depth, 0);
  assert.equal(ctx.rules[1].kind, "agents-md");
  assert.equal(ctx.mcpServers.fs.command, "mcp-fs");
  assert.equal(ctx.skills[0].name, "deploy");
  assert.equal(ctx.skills[0].description, "Deploy the app");
});

test("renderSystemPrompt puts nearest rules last and lists skills", () => {
  const { root, sub } = fixture();
  const ctx = loadAgentContext(sub, { root, global: false });
  const prompt = renderSystemPrompt(ctx, { baseDir: root });
  assert.ok(prompt.indexOf("Root rules") < prompt.indexOf("App rules"));
  assert.ok(prompt.includes("- deploy: Deploy the app"));
});

test("renderSystemPrompt respects budget", () => {
  const { root, sub } = fixture();
  const ctx = loadAgentContext(sub, { root, global: false });
  const prompt = renderSystemPrompt(ctx, { budget: 50, baseDir: root });
  assert.ok(prompt.length <= 120);
});

test("parseFrontmatter handles missing frontmatter", () => {
  const { frontmatter, body } = parseFrontmatter("just text");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "just text");
});

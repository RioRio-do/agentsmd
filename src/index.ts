/**
 * agentsmd — load every agent context file (AGENTS.md, CLAUDE.md,
 * .cursorrules, MCP configs, skills) with one call. Zero dependencies.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";

export interface RuleFile {
  /** Which convention this file follows, e.g. "agents-md", "claude-md". */
  kind: string;
  /** Absolute path of the file. */
  path: string;
  /** Raw file content. */
  content: string;
  /** Directory depth relative to the start dir (0 = start dir, 1 = parent…). */
  depth: number;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Skill body (markdown after frontmatter). */
  content: string;
}

export interface AgentContext {
  /** All rule/instruction files found, nearest first. */
  rules: RuleFile[];
  /** Merged MCP server definitions (nearest file wins per server name). */
  mcpServers: Record<string, McpServerConfig>;
  /** Skills discovered under .claude/skills/ or .agents/skills/. */
  skills: Skill[];
  /** Every file path that contributed to this context. */
  sources: string[];
}

export interface LoadOptions {
  /** Stop walking up at this directory (default: git root, else home). */
  root?: string;
  /** Also include user-global files like ~/.claude/CLAUDE.md (default: true). */
  global?: boolean;
}

const RULE_FILES: Array<[kind: string, name: string]> = [
  ["agents-md", "AGENTS.md"],
  ["claude-md", "CLAUDE.md"],
  ["cursorrules", ".cursorrules"],
  ["windsurfrules", ".windsurfrules"],
  ["copilot", ".github/copilot-instructions.md"],
  ["gemini-md", "GEMINI.md"],
];

const MCP_FILES = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"];
const SKILL_DIRS = [".claude/skills", ".agents/skills"];

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isRoot(dir: string, explicitRoot?: string): boolean {
  if (explicitRoot && resolve(dir) === resolve(explicitRoot)) return true;
  if (existsSync(join(dir, ".git"))) return true;
  return dir === homedir() || dirname(dir) === dir;
}

/** Walk from `dir` up to the project root and collect agent context. */
export function loadAgentContext(
  dir: string = process.cwd(),
  options: LoadOptions = {}
): AgentContext {
  const rules: RuleFile[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const skills: Skill[] = [];
  const sources: string[] = [];

  let current = resolve(dir);
  let depth = 0;
  for (;;) {
    collectDir(current, depth, rules, mcpServers, skills, sources);
    if (isRoot(current, options.root)) break;
    current = dirname(current);
    depth++;
  }

  if (options.global !== false) {
    for (const p of [
      join(homedir(), ".claude", "CLAUDE.md"),
      join(homedir(), ".config", "AGENTS.md"),
    ]) {
      const content = tryRead(p);
      if (content !== null) {
        rules.push({ kind: "global", path: p, content, depth: depth + 1 });
        sources.push(p);
      }
    }
  }

  return { rules, mcpServers, skills, sources };
}

function collectDir(
  dir: string,
  depth: number,
  rules: RuleFile[],
  mcpServers: Record<string, McpServerConfig>,
  skills: Skill[],
  sources: string[]
): void {
  for (const [kind, name] of RULE_FILES) {
    const path = join(dir, name);
    const content = tryRead(path);
    if (content !== null) {
      rules.push({ kind, path, content, depth });
      sources.push(path);
    }
  }

  // Cursor project rules: .cursor/rules/*.mdc
  const cursorRules = join(dir, ".cursor", "rules");
  if (existsSync(cursorRules)) {
    for (const f of safeReaddir(cursorRules)) {
      if (!f.endsWith(".mdc") && !f.endsWith(".md")) continue;
      const path = join(cursorRules, f);
      const content = tryRead(path);
      if (content !== null) {
        rules.push({ kind: "cursor-rule", path, content, depth });
        sources.push(path);
      }
    }
  }

  for (const name of MCP_FILES) {
    const path = join(dir, name);
    const content = tryRead(path);
    if (content === null) continue;
    try {
      const parsed = JSON.parse(content);
      const servers = parsed.mcpServers ?? parsed.servers ?? {};
      for (const [key, value] of Object.entries(servers)) {
        // nearest config wins
        if (!(key in mcpServers)) mcpServers[key] = value as McpServerConfig;
      }
      sources.push(path);
    } catch {
      /* malformed JSON: skip */
    }
  }

  for (const skillDir of SKILL_DIRS) {
    const base = join(dir, skillDir);
    if (!existsSync(base)) continue;
    for (const entry of safeReaddir(base)) {
      const skillPath = join(base, entry, "SKILL.md");
      const content = tryRead(skillPath);
      if (content === null) continue;
      const { frontmatter, body } = parseFrontmatter(content);
      skills.push({
        name: frontmatter.name ?? entry,
        description: frontmatter.description ?? "",
        path: skillPath,
        content: body,
      });
      sources.push(skillPath);
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)) !== null;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Minimal YAML frontmatter parser (string values only). */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

export interface RenderOptions {
  /** Max total characters of rule content to include (default: unlimited). */
  budget?: number;
  /** Base dir used to print relative paths in headers. */
  baseDir?: string;
}

/**
 * Render a loaded context into a single system-prompt string,
 * nearest rules last (so they take precedence with most models).
 */
export function renderSystemPrompt(
  context: AgentContext,
  options: RenderOptions = {}
): string {
  const base = options.baseDir ?? process.cwd();
  const parts: string[] = [];
  let used = 0;

  // farthest (global) first, nearest last
  const ordered = [...context.rules].sort((a, b) => b.depth - a.depth);
  for (const rule of ordered) {
    let chunk = `<!-- source: ${relative(base, rule.path)} -->\n${rule.content.trim()}`;
    if (options.budget !== undefined) {
      if (used >= options.budget) break;
      chunk = chunk.slice(0, options.budget - used);
      used += chunk.length;
    }
    parts.push(chunk);
  }

  if (context.skills.length > 0) {
    const list = context.skills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    parts.push(`## Available skills\n${list}`);
  }

  return parts.join("\n\n");
}

export default loadAgentContext;

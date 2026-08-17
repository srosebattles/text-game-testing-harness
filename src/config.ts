/**
 * Config loading: test-case YAML + game-adapter YAML + persona markdown,
 * validated with zod so a typo fails loudly at startup instead of surfacing
 * as weird agent behavior twenty paid turns later.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SaveBlockSchema = z.object({
  header: z.string(),
  footer: z.string(),
  fields: z.array(z.string()),
});

// checks: is declared by game adapters now but only consumed in M2.
const GameConfigSchema = z.object({
  name: z.string(),
  skill: z.string(),
  resume: z.enum(["refuses", "save-block"]),
  defaultOpening: z.string(),
  saveBlock: SaveBlockSchema.optional(),
  checks: z.array(z.string()).default([]),
});

const TestConfigSchema = z.object({
  game: z.string(),
  persona: z.string(),
  maxTurns: z.number().int().min(1).max(100),
  gmModel: z.string(),
  playerModel: z.string(),
  opening: z.string().optional(),
  /** "auto" picks messages-api when ANTHROPIC_API_KEY is set, else agent-sdk. */
  playerTransport: z.enum(["auto", "messages-api", "agent-sdk"]).default("auto"),
});

export type GameConfig = z.infer<typeof GameConfigSchema>;
export type TestConfig = z.infer<typeof TestConfigSchema>;

export interface ResolvedConfig {
  testName: string;
  test: TestConfig;
  game: GameConfig;
  personaName: string;
  personaText: string;
  opening: string;
  skillsDir: string;
  repoRoot: string;
}

export function loadTestCase(testPath: string): ResolvedConfig {
  const repoRoot = findRepoRoot(path.dirname(path.resolve(testPath)));
  const test = parseFile(testPath, TestConfigSchema);
  const gamePath = path.join(repoRoot, "games", `${test.game}.yaml`);
  const game = parseFile(gamePath, GameConfigSchema);

  const personaPath = path.join(repoRoot, "personas", `${test.persona}.md`);
  if (!fs.existsSync(personaPath)) {
    throw new Error(`persona not found: ${personaPath}`);
  }
  const personaText = fs.readFileSync(personaPath, "utf8");

  // Default to the current user's synced skills. Resolved from homedir rather
  // than hardcoded so the same default works on a laptop and in a container.
  const skillsDir =
    process.env.SKILLS_DIR ?? path.join(os.homedir(), ".claude", "skills", "synced");
  const skillPath = path.join(skillsDir, game.skill);
  if (!fs.existsSync(path.join(skillPath, "SKILL.md"))) {
    throw new Error(
      `skill "${game.skill}" not found at ${skillPath} — set SKILLS_DIR to your synced skills directory`,
    );
  }

  return {
    testName: path.basename(testPath).replace(/\.ya?ml$/, ""),
    test,
    game,
    personaName: test.persona,
    personaText,
    opening: test.opening ?? game.defaultOpening,
    skillsDir,
    repoRoot,
  };
}

function parseFile<T>(filePath: string, schema: z.ZodType<T>): T {
  if (!fs.existsSync(filePath)) throw new Error(`config not found: ${filePath}`);
  const parsed = schema.safeParse(parseYaml(fs.readFileSync(filePath, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid config ${filePath}:\n${issues}`);
  }
  return parsed.data;
}

function findRepoRoot(from: string): string {
  let dir = from;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root (no package.json found)");
    dir = parent;
  }
  return dir;
}

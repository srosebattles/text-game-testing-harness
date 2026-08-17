/**
 * M0 spike: prove the Agent SDK can load a real game skill and run the GM
 * for two turns, with session continuity between them.
 *
 * Throwaway code — learnings feed src/gm.ts in M1, then this file dies.
 *
 * Run: npm run spike
 * Env: SKILLS_DIR (default /root/.claude/skills/synced), GM_MODEL
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "fools-errand";
const SKILLS_SOURCE = process.env.SKILLS_DIR ?? "/root/.claude/skills/synced";
const GM_MODEL = process.env.GM_MODEL ?? "claude-opus-5";

// The GM runs inside a scratch workspace whose .claude/skills/ symlinks to the
// real synced skill — we test the shipped artifact, never a copy that drifts.
const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const skillsDir = path.join(workspace, ".claude", "skills");
fs.mkdirSync(skillsDir, { recursive: true });
const link = path.join(skillsDir, SKILL_NAME);
if (!fs.existsSync(link)) {
  fs.symlinkSync(path.join(SKILLS_SOURCE, SKILL_NAME), link);
}

interface TurnResult {
  sessionId: string | undefined;
  text: string;
  toolCalls: string[];
  costUsd: number | undefined;
}

async function gmTurn(playerText: string, resumeId?: string): Promise<TurnResult> {
  console.log(`\n>>> PLAYER: ${playerText}`);

  let sessionId = resumeId;
  let finalText = "";
  const toolCalls: string[] = [];
  let costUsd: number | undefined;

  const q = query({
    prompt: playerText,
    options: {
      cwd: workspace,
      resume: resumeId,
      settingSources: ["project"],
      skills: [SKILL_NAME],
      // The GM may only invoke the skill and read its reference files.
      // dontAsk resolves permissions without prompting: allowedTools pass,
      // everything else is denied. (bypassPermissions is refused when the
      // process runs as root, as this container does.)
      permissionMode: "dontAsk",
      allowedTools: ["Skill", "Read", "Glob"],
      disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Task", "TodoWrite"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      model: GM_MODEL,
    },
  });

  for await (const raw of q) {
    // Spike-grade handling: the point is to observe real message shapes,
    // so log liberally and treat everything as loosely typed.
    const msg = raw as any;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          console.log(`[init] session=${msg.session_id} model=${msg.model}`);
          console.log(`[init] tools=${(msg.tools ?? []).join(",")}`);
          if (msg.skills !== undefined) console.log(`[init] skills=${JSON.stringify(msg.skills)}`);
        } else {
          console.log(`[system:${msg.subtype}]`);
        }
        break;
      case "assistant":
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") {
            const summary = `${block.name}(${JSON.stringify(block.input).slice(0, 140)})`;
            toolCalls.push(summary);
            console.log(`[tool] ${summary}`);
          }
        }
        break;
      case "result":
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") finalText = msg.result;
        else console.log(`[result:ERROR] ${JSON.stringify(msg).slice(0, 400)}`);
        console.log(`[result] ${msg.subtype} turns=${msg.num_turns} cost=$${costUsd?.toFixed(4)}`);
        break;
      default:
        console.log(`[${msg.type}]`);
    }
  }

  console.log(`<<< GM:\n${finalText}`);
  return { sessionId, text: finalText, toolCalls, costUsd };
}

// The one mechanically checkable Fool's Errand rule: the stat line, every turn.
const STAT_LINE = /\*\*Gold:\*\*\s*\d+\s*\|\s*\*\*Dignity:\*\*\s*-?\d+\s*\|\s*\*\*Cheese:\*\*\s*\d+/;

const turn1 = await gmTurn("I'd like to play A Fool's Errand.");
if (!turn1.sessionId) throw new Error("Turn 1 produced no session id — cannot resume.");
const turn2 = await gmTurn("B", turn1.sessionId);

const skillInvoked = turn1.toolCalls.some((t) => t.startsWith("Skill("));
const forbidden = ["Bash(", "Write(", "Edit(", "WebSearch(", "WebFetch("];
const cleanTools = [...turn1.toolCalls, ...turn2.toolCalls].filter((t) =>
  forbidden.some((f) => t.startsWith(f)),
);

console.log("\n=== SPIKE VERDICT ===");
console.log(`skill invoked on turn 1:   ${skillInvoked ? "PASS" : "MISS"}`);
console.log(`stat line in turn 1:       ${STAT_LINE.test(turn1.text) ? "PASS" : "MISS"}`);
console.log(`stat line in turn 2:       ${STAT_LINE.test(turn2.text) ? "PASS" : "MISS"}`);
console.log(`session resumed in turn 2: ${turn2.sessionId === turn1.sessionId ? "PASS" : `MISS (${turn2.sessionId})`}`);
console.log(`no forbidden tool calls:   ${cleanTools.length === 0 ? "PASS" : `MISS (${cleanTools.join("; ")})`}`);
console.log(`total cost: $${((turn1.costUsd ?? 0) + (turn2.costUsd ?? 0)).toFixed(4)}`);

/**
 * M1 env probe: find the minimal child environment for the SDK-spawned GM
 * that still authenticates, and confirm it no longer inherits the host
 * Claude Code session (session id, tool roster, skill list).
 *
 * The Agent SDK's `env` option REPLACES the subprocess env entirely, so this
 * is an allowlist experiment: run the same cheap GM turn under increasingly
 * generous env tiers and compare what the init message reports.
 *
 * Run: npx tsx spike/env-probe.ts <tier>   (tier: t1 | t2 | inherit)
 * Throwaway code — the winning tier graduates into src/gm.ts as childEnv().
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "fools-errand";
const SKILLS_SOURCE =
  process.env.SKILLS_DIR ?? path.join(os.homedir(), ".claude", "skills", "synced");
const MODEL = "claude-haiku-4-5-20251001"; // cheapest thing that can say OK

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "workspace");
const skillsDir = path.join(workspace, ".claude", "skills");
fs.mkdirSync(skillsDir, { recursive: true });
const link = path.join(skillsDir, SKILL_NAME);
if (!fs.existsSync(link)) fs.symlinkSync(path.join(SKILLS_SOURCE, SKILL_NAME), link);

/** Copy only the named vars (and prefix matches) from process.env. */
function pick(names: string[], prefixes: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (names.includes(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

// Tier 1: process basics + TLS/proxy plumbing + Anthropic vars. No CLAUDE*.
const t1 = pick(
  ["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG",
   "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
   "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"],
  ["ANTHROPIC_"],
);

// Tier 2: t1 + the cloud-container auth glue observed in the host env.
const t2 = {
  ...t1,
  ...pick([
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  ]),
};

// Tier 0: t1 minus the proxy vars — if this fails auth, the agent proxy is
// confirmed as the credential path in this container.
const t0 = Object.fromEntries(
  Object.entries(t1).filter(([k]) => !/proxy/i.test(k)),
);

// Tier 3: t1 but HOME pointed at an empty scratch dir — tests whether the
// host's ~/.claude/skills leak into the child's skill list via HOME.
const scratchHome = path.join(here, "workspace-home");
fs.mkdirSync(scratchHome, { recursive: true });
const t3 = { ...t1, HOME: scratchHome };

const tiers: Record<string, Record<string, string> | undefined> = {
  t0,
  t1,
  t2,
  t3,
  inherit: undefined, // control: SDK default = full process.env (M0 behavior)
};

const tierName = process.argv[2] ?? "t1";
if (!(tierName in tiers)) throw new Error(`unknown tier ${tierName}`);
const env = tiers[tierName];
const hostSessionId = process.env.CLAUDE_CODE_SESSION_ID;

console.log(`=== tier ${tierName}: ${env ? Object.keys(env).length + " vars" : "full inherit"} ===`);
if (env) console.log(`vars: ${Object.keys(env).sort().join(", ")}`);

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 180_000);

let sessionId: string | undefined;
let tools: string[] = [];
let skills: unknown;
let resultSubtype = "(no result message)";
let resultText = "";
let costUsd: number | undefined;
let errorText = "";

try {
  const q = query({
    prompt: 'Reply with the single word "OK" and nothing else.',
    options: {
      cwd: workspace,
      env,
      abortController: abort,
      settingSources: ["project"],
      skills: [SKILL_NAME],
      permissionMode: "dontAsk",
      allowedTools: ["Skill", "Read", "Glob"],
      disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Task", "TodoWrite"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      model: MODEL,
    },
  });
  for await (const raw of q) {
    const msg = raw as any;
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
      tools = msg.tools ?? [];
      skills = msg.skills;
    } else if (msg.type === "result") {
      resultSubtype = msg.subtype;
      costUsd = msg.total_cost_usd;
      if (msg.subtype === "success") resultText = msg.result;
      else errorText = JSON.stringify(msg).slice(0, 500);
    }
  }
} catch (e) {
  errorText = String(e).slice(0, 500);
} finally {
  clearTimeout(timer);
}

console.log(`\n--- verdict (tier ${tierName}) ---`);
console.log(`auth/result:       ${resultSubtype}${resultText ? ` ("${resultText.slice(0, 40)}")` : ""}`);
if (errorText) console.log(`error:             ${errorText}`);
console.log(`session id:        ${sessionId}`);
console.log(`fresh session:     ${sessionId && sessionId !== hostSessionId ? "YES" : `NO — matches host ${hostSessionId}`}`);
console.log(`tool count:        ${tools.length}`);
console.log(`tools:             ${tools.join(", ")}`);
console.log(`skills:            ${JSON.stringify(skills)}`);
console.log(`cost:              $${costUsd?.toFixed(4)}`);

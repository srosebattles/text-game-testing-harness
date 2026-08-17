/**
 * GM session wrapper: the game skill running under the Claude Agent SDK,
 * one query() per turn with `resume` for continuity (the M0-proven pattern).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTurn, GameAgent, ToolCallRecord } from "./types.js";

/**
 * Curated environment for SDK-spawned children.
 *
 * The SDK's `env` option REPLACES the subprocess environment, so this is an
 * explicit allowlist. Resolved by the M1 env probe: a child given the host's
 * full env inherits the host Claude Code session identity (session id, tool
 * roster) via CLAUDE* vars. The allowlist keeps only what a child needs to
 * run and authenticate anywhere:
 *  - process basics (PATH, HOME, ...) — HOME also carries ~/.claude OAuth
 *    credentials on developer machines
 *  - TLS/proxy plumbing for containers that route egress through a proxy
 *  - ANTHROPIC_* (API key, base URL)
 * Never anything matching CLAUDE* — that is host-session state, not config.
 */
export function childEnv(): Record<string, string> {
  const names = new Set([
    "PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR",
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
    "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (names.has(k) || k.startsWith("ANTHROPIC_"))) out[k] = v;
  }
  return out;
}

export interface GmInitInfo {
  sessionId: string;
  model: string;
  toolCount: number;
  skills: unknown;
}

export interface GmOptions {
  workspaceDir: string;
  skillsDir: string;
  skillName: string;
  model: string;
  /** Called once with the first turn's init message, for hygiene recording. */
  onInit?: (info: GmInitInfo) => void;
}

export class GmSession implements GameAgent {
  private sessionId: string | undefined;
  private initSeen = false;

  constructor(private readonly opts: GmOptions) {
    // Per-run workspace: the skill enters via symlink so the run always
    // exercises the real synced artifact, never a copy that can drift.
    const skillsDir = path.join(opts.workspaceDir, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const link = path.join(skillsDir, opts.skillName);
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.join(opts.skillsDir, opts.skillName), link);
    }
  }

  async sendTurn(incoming: string): Promise<AgentTurn> {
    let text = "";
    const toolCalls: ToolCallRecord[] = [];
    let costUsd: number | undefined;
    const rawMessages: unknown[] = [];

    const q = query({
      prompt: incoming,
      options: {
        cwd: this.opts.workspaceDir,
        env: childEnv(),
        resume: this.sessionId,
        settingSources: ["project"],
        skills: [this.opts.skillName],
        // dontAsk: allowlisted tools pass, everything else is denied without
        // prompting (bypassPermissions is refused when running as root).
        permissionMode: "dontAsk",
        allowedTools: ["Skill", "Read", "Glob"],
        disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Task", "TodoWrite"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        model: this.opts.model,
      },
    });

    for await (const raw of q) {
      const msg = raw as any;
      if (msg.type === "stream_event") continue; // partial deltas; final text arrives in `result`
      rawMessages.push(msg);
      if (msg.type === "system" && msg.subtype === "init") {
        this.sessionId = msg.session_id;
        if (!this.initSeen) {
          this.initSeen = true;
          this.opts.onInit?.({
            sessionId: msg.session_id,
            model: msg.model,
            toolCount: (msg.tools ?? []).length,
            skills: msg.skills,
          });
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls.push({
              name: block.name,
              inputSummary: JSON.stringify(block.input).slice(0, 200),
            });
          }
        }
      } else if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") {
          text = msg.result;
        } else {
          throw new Error(`GM turn failed (${msg.subtype}): ${JSON.stringify(msg).slice(0, 400)}`);
        }
      }
    }

    if (!this.sessionId) throw new Error("GM produced no session id — cannot resume next turn");
    return { text, toolCalls, costUsd, rawMessages };
  }
}

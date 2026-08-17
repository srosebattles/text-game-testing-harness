/**
 * Player session wrapper: a persona system prompt over a bare conversation.
 *
 * Two transports behind the same GameAgent interface:
 *
 * - "messages-api" (the design default): plain @anthropic-ai/sdk, no tools,
 *   no harness — the deliberate contrast to the GM's Agent SDK side. We keep
 *   the message history ourselves and place cache_control breakpoints by
 *   hand; everything the Agent SDK does invisibly is explicit here.
 * - "agent-sdk": the same conversation run through a tool-less Agent SDK
 *   session. Exists because some environments (e.g. Claude Code cloud
 *   containers) authenticate only through the Claude Code path and expose no
 *   raw API key. Selected automatically when ANTHROPIC_API_KEY is absent.
 */
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import { childEnv } from "./gm.js";
import type { AgentTurn, GameAgent } from "./types.js";

export type PlayerTransport = "messages-api" | "agent-sdk";

export function resolvePlayerTransport(requested: "auto" | PlayerTransport): PlayerTransport {
  if (requested !== "auto") return requested;
  return process.env.ANTHROPIC_API_KEY ? "messages-api" : "agent-sdk";
}

export interface PlayerOptions {
  personaText: string;
  model: string;
  transport: PlayerTransport;
  /** Scratch cwd for the agent-sdk transport (kept out of the repo). */
  workspaceDir: string;
}

export function createPlayer(opts: PlayerOptions): GameAgent {
  return opts.transport === "messages-api"
    ? new MessagesApiPlayer(opts)
    : new AgentSdkPlayer(opts);
}

class MessagesApiPlayer implements GameAgent {
  private readonly client = new Anthropic();
  private readonly history: { role: "user" | "assistant"; text: string }[] = [];

  constructor(private readonly opts: PlayerOptions) {}

  async sendTurn(incoming: string): Promise<AgentTurn> {
    this.history.push({ role: "user", text: incoming });

    // Rebuild request content each call so exactly two cache_control
    // breakpoints exist: the persona (stable prefix) and the latest turn
    // (extends the cache incrementally). Reusing stored blocks would
    // accumulate stale breakpoints past the API's limit of 4.
    const messages = this.history.map((m, i) => ({
      role: m.role,
      content: [
        i === this.history.length - 1
          ? { type: "text" as const, text: m.text, cache_control: { type: "ephemeral" as const } }
          : { type: "text" as const, text: m.text },
      ],
    }));

    const response = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: this.opts.personaText,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    this.history.push({ role: "assistant", text });

    return {
      text,
      toolCalls: [],
      costUsd: undefined, // Messages API reports tokens, not dollars; usage lands in the raw log
      rawMessages: [{ sent: incoming, response }],
    };
  }
}

class AgentSdkPlayer implements GameAgent {
  private sessionId: string | undefined;

  constructor(private readonly opts: PlayerOptions) {
    // A nonexistent cwd makes spawn fail with an ENOENT the SDK misreports
    // as a broken binary.
    fs.mkdirSync(opts.workspaceDir, { recursive: true });
  }

  async sendTurn(incoming: string): Promise<AgentTurn> {
    let text = "";
    let costUsd: number | undefined;
    const rawMessages: unknown[] = [];

    const q = query({
      prompt: incoming,
      options: {
        cwd: this.opts.workspaceDir,
        env: childEnv(),
        resume: this.sessionId,
        // Fully custom system prompt (the persona), no filesystem settings,
        // no tools: as close to a bare conversation as the SDK gets.
        systemPrompt: this.opts.personaText,
        settingSources: [],
        tools: [],
        permissionMode: "dontAsk",
        model: this.opts.model,
      },
    });

    for await (const raw of q) {
      const msg = raw as any;
      if (msg.type === "stream_event") continue;
      rawMessages.push(msg);
      if (msg.type === "system" && msg.subtype === "init") {
        this.sessionId = msg.session_id;
      } else if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") {
          text = msg.result.trim();
        } else {
          throw new Error(`player turn failed (${msg.subtype}): ${JSON.stringify(msg).slice(0, 400)}`);
        }
      }
    }

    if (!this.sessionId) throw new Error("player produced no session id — cannot resume next turn");
    return { text, toolCalls: [], costUsd, rawMessages };
  }
}

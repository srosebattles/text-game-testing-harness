/**
 * Run recording. JSONL logs are appended live (a crashed run still leaves
 * evidence); transcript.md and meta.json are rendered at the end. Runs are
 * the ground truth — anything odd in a summary traces back to the JSONL.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as toYaml } from "yaml";
import type { ResolvedConfig } from "./config.js";
import type { AgentTurn, SessionResult } from "./types.js";
import type { GmInitInfo } from "./gm.js";

interface TranscriptEntry {
  turn: number;
  speaker: "player" | "gm";
  text: string;
  toolCalls: string[];
}

export class RunRecorder {
  private readonly entries: TranscriptEntry[] = [];
  private readonly notes: string[] = [];
  private gmInit: GmInitInfo | undefined;
  private readonly startedAt = new Date();

  constructor(
    readonly runDir: string,
    private readonly config: ResolvedConfig,
  ) {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "config.yaml"),
      toYaml({
        test: config.test,
        game: config.game,
        persona: config.personaName,
        opening: config.opening,
        skillsDir: config.skillsDir,
      }),
    );
  }

  onGmInit(info: GmInitInfo): void {
    this.gmInit = info;
  }

  recordPlayerTurn(turn: number, view: AgentTurn): void {
    this.entries.push({ turn, speaker: "player", text: view.text, toolCalls: [] });
    this.appendJsonl("player.jsonl", turn, view);
  }

  recordGmTurn(turn: number, view: AgentTurn): void {
    this.entries.push({
      turn,
      speaker: "gm",
      text: view.text,
      toolCalls: view.toolCalls.map((t) => `${t.name}(${t.inputSummary})`),
    });
    this.appendJsonl("gm.jsonl", turn, view);
  }

  recordNote(note: string): void {
    this.notes.push(note);
  }

  finish(result: SessionResult): void {
    fs.writeFileSync(path.join(this.runDir, "transcript.md"), this.renderTranscript(result));
    fs.writeFileSync(
      path.join(this.runDir, "meta.json"),
      JSON.stringify(
        {
          test: this.config.testName,
          game: this.config.game.name,
          persona: this.config.personaName,
          gmModel: this.config.test.gmModel,
          playerModel: this.config.test.playerModel,
          startedAt: this.startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          turnsCompleted: result.turnsCompleted,
          stopReason: result.stopReason,
          totalCostUsd: Number(result.totalCostUsd.toFixed(4)),
          gmInit: this.gmInit,
          notes: this.notes,
        },
        null,
        2,
      ),
    );
  }

  private appendJsonl(file: string, turn: number, view: AgentTurn): void {
    const lines = view.rawMessages
      .map((m) => JSON.stringify({ turn, message: m }))
      .join("\n");
    fs.appendFileSync(path.join(this.runDir, file), lines + "\n");
  }

  private renderTranscript(result: SessionResult): string {
    const c = this.config;
    const lines: string[] = [
      `# ${c.game.name} — ${c.personaName}`,
      "",
      `- test: \`${c.testName}\``,
      `- GM: \`${c.test.gmModel}\` (Agent SDK) · player: \`${c.test.playerModel}\``,
      `- started: ${this.startedAt.toISOString()}`,
      `- stopped after turn ${result.turnsCompleted}: ${result.stopReason.kind} — ${result.stopReason.detail}`,
      "",
    ];
    let currentTurn = 0;
    for (const e of this.entries) {
      if (e.turn !== currentTurn) {
        currentTurn = e.turn;
        lines.push(`## Turn ${currentTurn}`, "");
      }
      lines.push(`**${e.speaker === "player" ? "Player" : "GM"}:**`, "", e.text, "");
      for (const t of e.toolCalls) lines.push(`> tool: \`${t}\``, "");
    }
    if (this.notes.length > 0) {
      lines.push("## Harness notes", "", ...this.notes.map((n) => `- ${n}`), "");
    }
    return lines.join("\n");
  }
}

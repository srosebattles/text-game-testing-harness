/**
 * The relay loop. Deterministic code coordinating two agents that never talk
 * directly: the player's text is delivered to the GM as an incoming (user)
 * message and vice versa — each agent's "conversation" is an illusion this
 * loop maintains. One turn = one player message + the GM's reply.
 */
import type { AgentTurn, GameAgent, SessionResult, StopReason } from "./types.js";

/** `[[STOP]]` or `[[STOP: reason]]` anywhere in the player's message. */
const STOP_SENTINEL = /\[\[STOP(?::\s*([^\]]*))?\]\]/;

export interface OrchestratorEvents {
  onPlayerTurn(turn: number, view: AgentTurn): void;
  onGmTurn(turn: number, view: AgentTurn): void;
  onNote(note: string): void;
}

export interface SessionOptions {
  gm: GameAgent;
  player: GameAgent;
  opening: string;
  maxTurns: number;
  events: OrchestratorEvents;
}

export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const { gm, player, maxTurns, events } = opts;
  let totalCostUsd = 0;
  let turn = 0;
  let stopReason: StopReason | undefined;

  // The kickoff is harness→player instruction, not game text: it never
  // reaches the GM. The opening line is prescribed so the run reliably
  // exercises the skill description's triggering.
  let toPlayer =
    `Begin the session now. Your first message must ask to play the game ` +
    `using this line (you may lead into it naturally, in your persona's voice): ` +
    `"${opts.opening}"`;

  try {
    while (turn < maxTurns) {
      turn += 1;

      const playerTurn = await player.sendTurn(toPlayer);
      events.onPlayerTurn(turn, playerTurn);
      totalCostUsd += playerTurn.costUsd ?? 0;

      // Strip the sentinel BEFORE relaying: protocol text is for the
      // harness, and leaking it would contaminate the GM's context.
      const match = playerTurn.text.match(STOP_SENTINEL);
      const relayText = playerTurn.text.replace(STOP_SENTINEL, "").trim();

      if (match) {
        stopReason = { kind: "player-stop", detail: match[1]?.trim() || "player ended session" };
        if (relayText.length > 0) {
          // Relay the player's farewell so the GM can close the scene; its
          // reply is recorded but the loop ends here.
          const gmTurn = await gm.sendTurn(relayText);
          events.onGmTurn(turn, gmTurn);
          totalCostUsd += gmTurn.costUsd ?? 0;
        } else {
          events.onNote("player message was sentinel-only; nothing relayed to GM");
        }
        break;
      }

      const gmTurn = await gm.sendTurn(relayText);
      events.onGmTurn(turn, gmTurn);
      totalCostUsd += gmTurn.costUsd ?? 0;

      toPlayer = gmTurn.text;
    }
  } catch (e) {
    stopReason = { kind: "error", detail: String(e).slice(0, 500) };
    events.onNote(`stopping on error: ${stopReason.detail}`);
  }

  stopReason ??= { kind: "max-turns", detail: `reached maxTurns=${maxTurns}` };
  return { turnsCompleted: turn, stopReason, totalCostUsd };
}

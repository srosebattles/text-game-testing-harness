/**
 * The uniform agent contract. The orchestrator relays text between two
 * GameAgents and never knows what harness sits behind either one — the GM
 * runs on the Agent SDK, the player on the plain Messages API (or an SDK
 * fallback when no API key exists). Swapping a transport, model, or whole
 * agent implementation must never require touching the relay loop.
 */
export interface GameAgent {
  /** Deliver one incoming message; resolve with the agent's reply. */
  sendTurn(incoming: string): Promise<AgentTurn>;
}

export interface AgentTurn {
  text: string;
  toolCalls: ToolCallRecord[];
  costUsd?: number;
  /** Raw provider messages for this turn, appended verbatim to the JSONL log. */
  rawMessages: unknown[];
}

export interface ToolCallRecord {
  name: string;
  /** JSON-stringified input, truncated for logging. */
  inputSummary: string;
}

export type StopReason =
  | { kind: "player-stop"; detail: string }
  | { kind: "max-turns"; detail: string }
  | { kind: "error"; detail: string };

export interface SessionResult {
  turnsCompleted: number;
  stopReason: StopReason;
  totalCostUsd: number;
}

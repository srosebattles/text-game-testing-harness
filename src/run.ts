/**
 * CLI entry: run one test case.
 *
 *   npm run harness -- tests/fools-errand-smoke.yaml
 *
 * Streams the session to the console live; full artifacts land in
 * runs/<timestamp>-<test-name>/.
 */
import * as path from "node:path";
import { loadTestCase } from "./config.js";
import { GmSession } from "./gm.js";
import { createPlayer, resolvePlayerTransport } from "./player.js";
import { runSession } from "./orchestrator.js";
import { RunRecorder } from "./transcript.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main(): Promise<void> {
  const testPath = process.argv[2];
  if (!testPath) {
    console.error("usage: npm run harness -- <tests/some-test.yaml>");
    process.exit(2);
  }

  const config = loadTestCase(testPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(config.repoRoot, "runs", `${stamp}-${config.testName}`);
  const recorder = new RunRecorder(runDir, config);

  const transport = resolvePlayerTransport(config.test.playerTransport);
  console.log(bold(`▶ ${config.testName}`));
  console.log(dim(`  game=${config.game.name} persona=${config.personaName} maxTurns=${config.test.maxTurns}`));
  console.log(dim(`  gm=${config.test.gmModel} player=${config.test.playerModel} (${transport})`));
  console.log(dim(`  run dir: ${runDir}\n`));

  const gm = new GmSession({
    workspaceDir: path.join(runDir, "workspace"),
    skillsDir: config.skillsDir,
    skillName: config.game.skill,
    model: config.test.gmModel,
    onInit: (info) => {
      recorder.onGmInit(info);
      console.log(dim(`  [gm session ${info.sessionId} · ${info.toolCount} tools]\n`));
    },
  });

  const player = createPlayer({
    personaText: config.personaText,
    model: config.test.playerModel,
    transport,
    workspaceDir: path.join(runDir, "player-workspace"),
  });

  const result = await runSession({
    gm,
    player,
    opening: config.opening,
    maxTurns: config.test.maxTurns,
    events: {
      onPlayerTurn: (turn, view) => {
        recorder.recordPlayerTurn(turn, view);
        console.log(`${bold(`[${turn}] PLAYER:`)} ${view.text}\n`);
      },
      onGmTurn: (turn, view) => {
        recorder.recordGmTurn(turn, view);
        for (const t of view.toolCalls) console.log(dim(`  [tool] ${t.name}(${t.inputSummary})`));
        console.log(`${bold(`[${turn}] GM:`)} ${view.text}\n`);
      },
      onNote: (note) => {
        recorder.recordNote(note);
        console.log(dim(`  [note] ${note}`));
      },
    },
  });

  recorder.finish(result);
  console.log(bold(`■ ${result.stopReason.kind}`) + ` — ${result.stopReason.detail}`);
  console.log(`  turns: ${result.turnsCompleted} · agent-reported cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  artifacts: ${runDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

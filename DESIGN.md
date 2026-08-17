# Design: Text-Game Testing Harness

A harness that plays the text-based games defined in my Claude skills by pitting
two AI agents against each other — one running the game as **Game Master (GM)**,
one playing it as a **persona-driven player** — while plain TypeScript code
orchestrates, records, and checks the session.

**Goals, in priority order:**

1. Speed up checking game behavior and edge cases (no more manual play sessions
   for every scenario I want to probe).
2. Serve as a learning project for multi-agent patterns — this is my first
   system that coordinates more than one agent.

**Settled decisions:**

| Decision | Choice |
|---|---|
| Language / runtime | TypeScript on Node 20+ |
| GM agent | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with the real skill files loaded |
| Player agent | Plain Messages API (`@anthropic-ai/sdk`), no tools |
| Evaluation in V1 | Deterministic checks + human-readable transcripts only; **no LLM judge in V1** (judge is a V2 candidate, see Future work) |
| Fidelity target | Playing these games in Claude chat in the browser |

---

## 1. The system under test

The games are Claude skills (`SKILL.md` + optional `references/` files):
A Fool's Errand, New Vinland, Ecclesiastical Politics, and The Emperor of the
United States. Reading them, they share conventions the harness can exploit:

- **Turn-based plain-text chat loop.** Every game explicitly forbids
  interactive tools/widgets during play.
- **Mechanically checkable output rules.** Fool's Errand requires a stat line
  in an exact format every turn (`**Gold:** X | **Dignity:** X | **Cheese:** X`);
  New Vinland, Emperor, and Ecclesiastical Politics define canonical save-state
  blocks with fixed field lists.
- **Hidden state.** Secret check difficulties, pre-commitment strings, and NPC
  knowledge limits — information the GM holds that the player must never see.
  This single fact drives the whole architecture (see §2).
- **Explicit edge-case rules.** Anachronistic technology, impossible actions,
  genre violations, out-of-character behavior — each skill prescribes the GM's
  response, so a test can deliberately trigger them and check the reaction.
- **One intentional behavioral difference.** Fool's Errand must *refuse* to
  resume old sessions; the other three resume from pasted save blocks. Both
  behaviors are testable.

The skills are effectively specs. The harness's job is to exercise them and
report where behavior drifts from the spec.

Skill files live outside this repo (synced Claude skills directory). The
harness takes a `skillsDir` config value pointing at them, so it always tests
the artifact actually being shipped — no copies that can drift.

---

## 2. Architecture: one orchestrator, two private contexts

```
              ┌───────────── harness (plain code, the "orchestrator") ─────────────┐
              │  relay messages · count turns · log everything · decide when to stop │
              └────────────┬──────────────────────────────────────┬────────────────┘
                           │                                      │
                relays player's text                    relays GM's narration
                           ▼                                      ▼
            ┌───────────────────────────┐          ┌───────────────────────────┐
            │  GM agent                 │          │  Player agent             │
            │  (Claude Agent SDK)       │          │  (plain Messages API)     │
            │  · game skill loaded      │          │  · persona + mission      │
            │  · reads era/scenario     │          │  · sees ONLY what a       │
            │    reference files        │          │    human player would     │
            │  · hidden state lives here│          └───────────────────────────┘
            └───────────────────────────┘
```

Core properties:

- **The agents never talk to each other directly.** The orchestrator copies the
  GM's output into the player's conversation as an incoming (user-role) message,
  and vice versa. Each agent's history shows the other's text as user turns and
  its own replies as assistant turns — the "conversation" is an illusion the
  relay loop maintains.
- **Each agent believes it's talking to a human.** Neither prompt announces
  that the counterpart is an AI; the GM behaving naturally depends on this.
- **The separation is the point.** The games rely on information asymmetry
  (secret difficulties, pre-commitments). One model role-playing both sides in
  a single context would contaminate the player with GM-only knowledge and stop
  resembling a real session. Two isolated contexts is *why* this is multi-agent.
- **The orchestrator is deterministic code, not an AI.** A dumb loop
  coordinating smart agents is the standard shape; nothing about coordination
  requires intelligence.

Two different Anthropic libraries, on purpose:

- **GM → Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): the Claude Code
  harness as a library. It gives the GM real file tools, so multi-file skills
  work the way they do in production — New Vinland's SKILL.md tells the GM to
  read an era file and a scenario file at startup, and with the Agent SDK it
  actually does. Prompt-stuffing the files into one big system prompt would
  test a paraphrase of the skill instead of the skill.
- **Player → plain Messages API** (`@anthropic-ai/sdk`): a bare conversation
  loop with a persona system prompt. No tools, no harness — deliberately the
  simplest thing that works, and a useful contrast for learning what the Agent
  SDK adds.

---

## 3. Repository layout

```
text-game-testing-harness/
  DESIGN.md
  package.json
  tsconfig.json
  src/
    run.ts             # CLI entry point: run one test case
    orchestrator.ts    # the relay loop + stop conditions
    gm.ts              # GM session wrapper (Agent SDK)
    player.ts          # player session wrapper (Messages API)
    transcript.ts      # recording + markdown rendering
    checks/            # tier-1 deterministic checks, one module per check
    config.ts          # YAML loading + validation (zod)
  games/               # per-game adapter config (see §6)
    fools-errand.yaml
    new-vinland.yaml
    ecclesiastical-politics.yaml
    emperor-of-the-united-states.yaml
  personas/            # player persona prompts (see §5)
    cooperative-newbie.md
    chaos-gremlin.md
    ...
  tests/               # test-case configs (see §7)
    fools-errand-smoke.yaml
    ...
  runs/                # per-run output, gitignored
```

---

## 4. The turn loop and message protocol

A **turn** is one player message plus the GM's reply. The loop:

1. Harness asks the player agent for its opening message. The player's history
   starts with its persona system prompt plus a kickoff instruction from the
   harness ("Begin the session now — send your opening message"). The default
   opening names the game explicitly ("I'd like to play A Fool's Errand"),
   which per the skills' descriptions should always trigger the skill.
2. Harness sends the player's text to the GM session; GM responds (possibly
   reading skill reference files first — those tool calls are logged, not
   relayed).
3. Harness relays the GM's text back to the player as an incoming message.
4. Repeat until a stop condition fires.

**Stop conditions** (checked in order):

- Player's message ends with the sentinel line `[[STOP]]` (or
  `[[STOP: reason]]`) — the persona prompt tells the player to emit this when
  its mission is complete or the game reaches an ending. The harness strips the
  sentinel before relaying, so the GM never sees it.
- `maxTurns` from the test config is reached (the hard cost cap).
- An unrecoverable API error.

**Protocol rules** — small but load-bearing, and a recurring theme when code
orchestrates LLMs:

- The persona prompt instructs the player to output *only* what it would type
  into the chat window — no meta-commentary, no notes to the harness other
  than the sentinel.
- The harness strips known sentinels and relays everything else verbatim. It
  never rewrites either agent's text.
- Defensive parsing over trust: a `player-leakage` check (see §8) flags any
  meta-text or sentinel fragments that slip through, because a protocol
  violation by one agent otherwise silently corrupts the other's context.

**GM tool policy:** the GM session gets read-only file access (enough to read
`SKILL.md` and `references/`) plus skill invocation, with everything else
denied and permissions set so nothing prompts. Every tool call is recorded.
During play — after the setup reads — the skills say the GM should call no
tools at all, which becomes a check.

---

## 5. Personas

A persona is a markdown file used as the player agent's system prompt. Three
parts:

1. **Identity & style** — who this player is and how they write. Instructing
   the persona to write like a real player matters: short messages, imperfect
   phrasing, occasional questions. An unstyled model "player" writes long,
   polished paragraphs no human types.
2. **Mission** (optional) — specific probes to attempt, turning one-off
   edge-case experiments into repeatable tests.
3. **Protocol** — the output rules from §4 (only chat text; `[[STOP]]` when
   done).

Example, `personas/chaos-gremlin.md` (abridged):

```markdown
You are playtesting a text adventure game by playing it. Stay fully in the
role of a mischievous human player. Write like a person typing in a chat:
1–3 sentences, casual.

Mission — over the course of the session:
- Mid-game, attempt an anachronism (try to check your phone).
- Later, attempt something impossible (fly to your destination).
- Near the end, ask the GM directly what the secret difficulty of your last
  check was, before it resolved.

Play along normally between probes. When all probes have run (or the game
ends), end your final message with a line containing only: [[STOP]]

Output only what you would type into the game chat. Never mention that you
are an AI, a tester, or that this is a test.
```

Starter library: `cooperative-newbie` (baseline happy path),
`chaos-gremlin` (world-integrity probes), `rules-lawyer` (interrogates
mechanics, checks stat math), `secret-prober` (tries to extract hidden state),
`speedrunner` (terse, pushes pacing), `quitter` (stops early and asks for a
save block — feeds the save/resume flow in §9).

---

## 6. Game adapters

The engine stays game-agnostic; everything game-specific lives in one small
YAML per game:

```yaml
# games/fools-errand.yaml
name: fools-errand
skill: fools-errand          # directory name under skillsDir
resume: refuses              # "refuses" | "save-block"
defaultOpening: "I'd like to play A Fool's Errand."
checks:
  - stat-line-every-turn     # the **Gold:** | **Dignity:** | **Cheese:** line
  - no-tools-during-play
  - skill-invoked
```

```yaml
# games/new-vinland.yaml
name: new-vinland
skill: new-vinland
resume: save-block
defaultOpening: "I'd like to play New Vinland — the cartographer scenario."
saveBlock:
  header: "=== NEW VINLAND SAVE STATE ==="
  footer: "=== END SAVE STATE ==="
  fields: [Scenario, Act, "Day & season", Location, Character, Stats, Money,
           Inventory, Relationships, "Pre-committed decisions",
           "Scenario state", "Key decisions", "Open threads"]
checks:
  - save-block-format
  - no-tools-during-play
  - skill-invoked
```

Adding a game to the harness = writing one of these files, no engine changes.

---

## 7. Test cases and runs

A test case is a YAML file combining a game, a persona, models, and limits:

```yaml
# tests/new-vinland-anachronism.yaml
game: new-vinland
persona: chaos-gremlin
maxTurns: 15
gmModel: claude-opus-5        # match whatever model I actually play with
playerModel: claude-sonnet-5  # player can be cheaper; haiku for smoke tests
# opening: override games/<game>.yaml defaultOpening if needed
```

Running it:

```
npm run harness -- tests/new-vinland-anachronism.yaml
```

The transcript streams to the console live (so a run can be watched like a
spectator), then everything lands in `runs/<timestamp>-<test-name>/`:

| File | Contents |
|---|---|
| `config.yaml` | The fully resolved config this run used |
| `transcript.md` | Human-readable interleaved transcript with turn numbers |
| `gm.jsonl` | The GM's full message history, including tool calls |
| `player.jsonl` | The player's full message history |
| `checks.json` | Machine-readable tier-1 check results |
| `meta.json` | Models used, token usage, duration, stop reason |

Runs are the ground truth. Anything odd in a summary can be traced back to the
raw JSONL.

---

## 8. Checks (V1 evaluation)

Deterministic code over the recorded run — no AI judgment involved. Each check
is a small TypeScript function `(run) => CheckResult[]`, registered by id;
game adapters declare which apply. Severities: `fail` (spec violation),
`warn` (suspicious), `info` (measurement).

| Check id | Applies to | Severity | What it verifies |
|---|---|---|---|
| `skill-invoked` | all | fail | The GM actually loaded the target skill (fails fast if triggering missed — which is itself a real finding about the skill's description) |
| `no-tools-during-play` | all | fail | After setup reads, the GM called no tools mid-game |
| `stat-line-every-turn` | fools-errand | fail | The exact stat line appears in every GM turn |
| `save-block-format` | resume: save-block games | fail | Emitted save blocks have the canonical header/footer and every required field |
| `refuses-resume` | fools-errand resume tests | fail | The GM honestly declines to resume rather than inventing a reconstruction |
| `player-leakage` | all | warn | No sentinel fragments or meta-text were relayed into the GM's context (protocol integrity) |
| `turn-length` | all | info | Words per GM turn — a drift signal for pacing rules like Fool's Errand's "2–4 sentences ideal" |

Tone, paced disclosure, NPC non-omniscience, and other judgment-dependent
rules are **out of scope for V1** — that's what reading `transcript.md` is
for, and what a future judge could automate (see Future work).

---

## 9. The save/resume flow

The capability manual play makes tedious, and the harness makes trivial:

1. Run a session with the `quitter` persona (or any persona whose mission ends
   with requesting a save) for N turns.
2. Player asks to stop; GM emits the save-state block; harness extracts it
   from the transcript (`save-block-format` check validates it).
3. Harness **discards the GM session entirely** and starts a brand-new one —
   fresh context, same skill. This mirrors a real user opening a new chat days
   later.
4. Player opens the new session with "I'd like to continue my game" and pastes
   the block.
5. A short scripted probe follows: the player asks a question whose answer is
   in the save block ("what are my stats and where am I?"), and a check
   compares the GM's answer against the values parsed from the block.

For Fool's Errand the same flow asserts the opposite: the new GM session must
decline the resume and offer a fresh adventure (`refuses-resume`).

This is a two-session test case (`type: save-resume` in the test YAML) and is
its own milestone (M3) because it adds session-lifecycle plumbing.

---

## 10. Fidelity notes — known gaps vs. browser chat

The production surface is Claude chat in the browser; the harness is the Agent
SDK. Close, not identical. Writing the gaps down so future-me doesn't mistake
a harness artifact for a game bug (or vice versa):

- **Different system prompt and tool surface.** claude.ai has its own system
  prompt and tools (web search, artifacts, widgets). The "don't call
  interactive tools during play" rules target those tools, which don't exist
  in the harness. We test the observable half — the GM calls *no* tools during
  play — but "GM resisted popping an artifact" is untestable here.
- **No claude.ai memory or chat history.** Rules like New Vinland's "don't
  search past chats" can't be exercised.
- **Player rhythm differs.** An AI player never typos, never idles, and
  replies instantly. Personas mitigate style; timing behavior is out of reach.
- **Skill triggering is approximated.** The Agent SDK's skill loading is
  mechanically similar but not guaranteed byte-identical to claude.ai's.
  `skill-invoked` verifies the outcome we care about.

A behavior confirmed broken in the harness is near-certainly broken in the
browser; a behavior that only misbehaves in the browser needs a manual check.

---

## 11. Cost and practical notes

- A run costs roughly `maxTurns × 2` model calls plus overhead. `maxTurns` is
  the budget lever; smoke tests at 5–8 turns, full probes at 15–25.
- **Prompt caching matters.** The GM's context (skill text + growing
  transcript) is a textbook multi-turn caching case. The Agent SDK handles
  caching for the GM; the player loop should set a `cache_control` breakpoint
  on the latest turn. With caching, a 20-turn run should land in the
  tens-of-cents to low-dollars range depending on models.
- **Model choice per role:** GM on the model actually used for play (that's
  what's being tested); player one tier cheaper by default; haiku-tier player
  for cheap smoke tests. All config, nothing hardcoded.
- **No determinism, by design.** The same config produces a different story
  every run. That's correct — the harness tests whether behavior stays inside
  the rules, not that output is identical. Confidence comes from run count and
  kept transcripts, not seeds. (Current models also removed the `temperature`
  parameter, so persona variety comes from prompts, not sampling knobs.)

---

## 12. Milestones

- **M0 — Spike.** Repo scaffold + a throwaway script proving the Agent SDK can
  load one game skill and complete two GM turns. Retires the only real
  technical risk (exact skill-loading mechanics) before any structure is built.
- **M1 — The loop.** Orchestrator, GM/player wrappers, personas, test-case
  configs, live console output, full run artifacts. *Usable from here:* run a
  session, read the transcript.
- **M2 — Checks.** Game adapters, the tier-1 check registry, `checks.json` +
  console summary.
- **M3 — Save/resume.** Two-session test cases, block extraction, resume
  probes, `refuses-resume`.

**Future work (V2+ candidates, deliberately not committed):**

- **LLM judge** — a third agent grading transcripts against per-game rubrics
  derived from the SKILL.md rules (tone, disclosure pacing, NPC knowledge
  limits). Excluded from V1 on purpose; revisit after enough transcripts have
  been read to know what rubrics should ask.
- **Repeat runs** — `--repeat N` and an aggregate report, since single runs of
  a stochastic system prove little.
- **Parallel execution** of independent test cases.
- **CI** — a smoke suite on skill changes.

---

## 13. What this project teaches (the learning map)

| Harness concept | General multi-agent principle |
|---|---|
| GM and player never share context | Context isolation — the reason multi-agent architectures exist at all (information asymmetry, independent perspectives) |
| Relay loop flips roles when copying messages | Message routing: "A talks to B" is always an orchestrator moving text between histories with roles inverted |
| Orchestrator is plain TypeScript | Coordinators don't need to be smart; deterministic code coordinating model calls is the default shape |
| `[[STOP]]` sentinel + defensive stripping | Agent I/O protocols: when code parses model output, define a narrow contract and enforce it, because agents drift |
| Persona files | Prompt-as-configuration: swapping behavior by swapping a file, not editing code |
| GM on Agent SDK, player on raw API | Right-sizing the harness per agent: full tool-using harness only where tools are needed |
| Checks vs. (future) judge | The evaluator split: deterministic checks for everything checkable, model judgment only for what genuinely needs it |

---

## 14. Open questions (resolve during implementation)

- **Player verbosity tuning** — how much persona instruction it takes before
  transcripts read like real play; adjust after the first few runs.
- **Per-run spend guard** — whether a token-budget abort is needed on top of
  `maxTurns`, once real usage numbers exist in `meta.json`.
- **Child environment hygiene** (found in M0, fix in M1) — the SDK-spawned GM
  process inherits the host Claude Code environment: the init message showed
  the host's full tool roster and skill list visible to the GM, and the child
  even reused the host's session id from an inherited env var. Narrative
  continuity still worked, but a clean harness should spawn the GM with a
  curated env. The wrinkle: auth also flows through that environment, so M1
  needs to find the minimal env that still authenticates.

### Resolved by the M0 spike (2026-08-17)

- **Skill loading works, and simply.** A scratch workspace whose
  `.claude/skills/<name>` is a *symlink* to the real synced skill, plus
  `settingSources: ["project"]` and the SDK's first-class `skills: [name]`
  option (which auto-enables the Skill tool). The GM invoked the skill on
  turn 1 unprompted from the player's opening line alone — so every run also
  exercises the skill description's triggering.
- **Session continuity: one `query()` per turn with `resume: sessionId`.**
  Turn 2 continued turn 1's story coherently (honored a labeled choice,
  carried NPCs and stat changes forward).
- **Permissions: `permissionMode: "dontAsk"`, not `bypassPermissions`** —
  the CLI refuses bypass when running as root (which cloud containers do),
  and dontAsk is the better policy anyway: allowlisted tools pass, everything
  else is denied instead of prompting.
- **Fool's Errand spec held for two turns**: exact stat line present in both
  GM replies, zero forbidden tool calls.
- **Cost shape**: ~$0.33 for turn 1 (skill load + opening scene) and ~$0.05
  for turn 2, on an Opus-class GM — so a 20-turn run lands under ~$2, in line
  with §11's estimate.
- **Message stream contains ignorable extras** (`stream_event`,
  `system:thinking_tokens`, `rate_limit_event`, `system:post_turn_summary`);
  the orchestrator consumes `system:init`, `assistant`, and `result` and
  skips the rest.

---
name: playpilot
description: Playtest a mobile game (iOS simulator or Android) as an agent with the playpilot CLI - play it step by step, look at every frame, find crashes, softlocks, broken UI and game bugs, and leave a report with frames, video and a replay. Use when asked to playtest, QA, smoke test, explore or "play" a mobile game or app, reproduce a game bug on a simulator, or check a build before release.
---

# PlayPilot: agent playtesting

You play the game one step at a time through `playpilot agent`. Each command acts, waits for the screen to settle, and prints the next observation: the screen id, a frame path, facts, new findings and the options on this screen. You decide what to do by **looking at the frame**, not only the option list.

## Before you start

1. `playpilot doctor` must pass. If it reports a stale device daemon, run the fix it prints.
2. Know the booted simulator: `xcrun simctl list devices booted`. Use its UDID with `--udid`.
3. The game must be a development build installed on that simulator.
4. Find the scenario (`playpilot/*.json` in the repo). If there is none, run `playpilot init --app <bundle-id>` and use `playpilot/explore.json`. See [references/scenarios.md](references/scenarios.md) to write one for the user's goal.
5. If the scenario has a `slim` profile, run `playpilot sim prepare <udid> --profile <profile>` once (about five seconds when already slim; `playpilot run` and `agent start` also do it).

## The loop

```bash
playpilot agent start playpilot/explore.json --udid <udid>
```

Then repeat:

1. **Read the frame** with your image tool (the `frame` path). Its pixels are screen points, so a control at pixel (612, 340) is tapped with `--tap 612,340`.
2. **Pick one action:**
   - an option by number or name: `playpilot agent act 3` or `playpilot agent act ui:Play`
   - a control you see that is not listed: `playpilot agent act --tap 612,340`
   - a gesture: `--swipe x,y,dx,dy[,ms]`, `--hold x,y,ms`, `--type <text>`, `--back`
   - a game action from the probe: `playpilot agent act game:<id>` or `--game <id> --args '{"seconds":20}'`
3. **Wait after anything that loads** (new scene, match, level, ad): `playpilot agent act --wait 3000`. A tap that starts a load can look like "no change" until the next step.
4. **Note what is wrong** as soon as you see it, with the step it happened on:
   `playpilot agent note "Score shows 3-1 but the round was lost" --severity high --step 7`
5. Stop when the goal is met, nothing new is reachable, or a crash ends the session.

```bash
playpilot agent finish --outcome achieved --summary "Reached level 2; 1 high finding"
```

Outcomes: `achieved`, `not_achieved`, `explored`. Then read `report.md` in the session folder and tell the user the findings, each with its frame path.

Full details, including what each output line means: [references/agent-loop.md](references/agent-loop.md).

## Rules

- **Never press options marked RISKY** (purchases, subscriptions, deletes, sign-out, resets) unless the user asked for that exact flow.
- **Look before you judge.** Do not report a bug from the option list alone. Open the frame. Report what a player would see.
- **Findings PlayPilot already raised** (crash, exception, softlock, error_log) are in the report. Do not repeat them with `note`; add a note only if you saw more (for example, what the player was doing).
- **Prefer real controls over grid taps.** `grid:` options are blind. If you can see the button in the frame, tap its pixel.
- **One session at a time per simulator.** Do not run two agents on one device.
- **Keep it lean.** Use `playpilot agent observe` only when you need to look again without acting.

## Severity guide

| Severity | Use for |
| --- | --- |
| critical | Crash, data loss, progress lost, payment flow broken |
| high | Player is stuck, a core rule is wrong, a main flow fails |
| medium | Wrong text or numbers, broken layout, missing art, confusing flow |
| low | Polish: alignment, small timing, wording |
| info | Observations worth knowing, not bugs |

## After the run

- Reproduce a finding without a model: `playpilot replay <run-dir> --to-step <n>`.
- Keep it as a regression: `playpilot promote <run-dir> --to-step <n> --out playpilot/regressions/<name>.json`, then `playpilot regress playpilot/regressions` in CI.
- For engine games with no accessibility, suggest the probe: [references/probe.md](references/probe.md).

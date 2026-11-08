# Architecture

PlayPilot is a TypeScript CLI with no runtime dependencies. It drives devices through other command-line tools and keeps all of its own state in plain files, so an agent can call it one step at a time and think as long as it likes between steps.

```text
            agent (Claude Code skill)            seeded explorer (CI)
                       \                          /
                  playpilot agent ...        playpilot run
                         \                      /
                          Playtest engine (src/playtest.ts)
            observe -> options -> decide -> act -> detect -> record
             /          |            |              \
     agent-device    simctl       probe files      simslim
   (tree, input,   (fast frames,  (state, targets, (lean simulator)
    video, logs,    app data)      actions, errors)
    memory)
```

## The step

**Observe** (`Playtest.observe`)

1. If the probe says the game is busy, wait for it (up to 10 s).
2. In parallel: the accessibility snapshot (`agent-device snapshot -i --no-record`), a screenshot (`xcrun simctl io screenshot` on simulators, about three times faster than going through the UI test runner) and the probe's `state.json`.
3. Shrink retina frames to screen points and save `frames/step-NNN.png`. Pixel coordinates in a frame are tap coordinates.
4. Identify the screen (below) and decide whether the last action changed anything.
5. Run the detectors and collect evidence for the step that caused it.
6. List the options and check the stop conditions (crash, success, step and time limits).

**Act** (`Playtest.act`)

Device actions (press, tap, pan, fill, wait) go to `agent-device batch` in one call. Game actions go to the probe's inbox and finish when the game acks them. Each step is recorded with its timing and a replayable form: element refs are turned into selectors or coordinates, so replays do not depend on refs that change between runs.

## Options

`src/harness/options.ts` lists everything a player could do on this screen, in this order:

| Source | From | Name |
| --- | --- | --- |
| probe | the game's own hit areas | `ui:<label>` |
| game | the game's registered actions | `game:<id>` |
| a11y | accessible controls (layout containers and full-screen nodes filtered out) | `<type>:<label>` |
| custom | the scenario's macros whose `when` matches | the macro's name |
| grid | a tap grid, only when there is nothing else to press or the scenario declares a `canvas` | `grid:rRcC` |
| fine | a denser, offset grid once every coarse cell was tried (explorer only) | `fine:rRcC` |

`isRisky` marks options that match the scenario's `avoid` patterns. The explorer never chooses them; agents see them marked.

## Deciders

- **Explorer** (`ExploreDecider`): prefers options never tried on this screen in any run, then real controls over grid taps, then options that changed the screen before. Options that always failed are skipped. Ties break with a seeded random generator, so a run with the same seed and the same game makes the same choices.
- **Scripted** (`ScriptedDecider`): follows the scenario's `script` by option name.
- **Agent**: the model, through `playpilot agent act`.

## Screen identity and change

A screen's id comes from, in order:

1. the probe's `scene` and `screen` names;
2. the set of accessible labels, with digits masked so scores and timers do not split screens;
3. a 64-bit perceptual hash of the frame (dHash), matched to the nearest known screen within 10 bits.

A step "changed" the game when the screen id changed, or when more than 3% of a 32x32 greyscale thumbnail moved by more than a set brightness. That catches a small popup while ignoring compression noise.

## Memory

`.playpilot/memory/<app>.json` records every screen ever seen and, per screen, how often each option was tried, failed and changed something. It is written atomically after each run. The explorer uses it to go where earlier runs did not; agents see it as `(new)`, `(visit N)` and `tried Nx`.

## Detectors

| Detector | Signal | Notes |
| --- | --- | --- |
| Crash | OS crash report for the process, fatal log lines, the process gone | All evidence of one crash is merged into one finding at the step that caused it. A missed memory sample alone is not a crash. |
| Log scan | New app-log lines | iOS lines are judged by their type (error, fault) and subsystem; harness and OS subsystems are ignored; repeats are reported once. |
| Probe events | `events.jsonl` | Exceptions, errors and the game's own invariant findings. |
| Softlock | Several different real controls with no visible change | Grid-only screens need every cell tried first and report at medium severity. |
| Blank screen | A flat frame twice in a row | One flat frame is usually a transition. |
| Memory growth | Resident memory samples | Over 50% and over 150 MB, from at least three samples. |
| Slow step | Step duration | Over `slowStepMs`. |

## Files a run writes

| File | Contents |
| --- | --- |
| `session.json` | Engine state between agent commands (resumable) |
| `scenario.json` | The resolved scenario |
| `frames/step-NNN.png` | One frame per observation, in screen points |
| `run.mp4`, `contact-sheet.png` | The recording |
| `steps.json` | Replayable steps (`playpilot replay`, `promote`) |
| `replay.ad` | The same steps as an agent-device script |
| `report.json`, `report.md` | Findings, steps and evidence |

## Lean simulators

`playpilot sim prepare` runs `simslim verify` with the profile and only runs `simslim on` when the simulator drifted, so it is cheap to call before every run. Slim simulators use about a quarter of the memory, which lets several agents play at once on one Mac.

## Credits

- [agent-device](https://github.com/callstack/agent-device) (MIT): device control, video, logs, memory sampling and `.ad` replays.
- [simslim](https://github.com/MobAI-App/simslim) (MIT): lean iOS simulators.
- [Aura Autopilot](https://github.com/ramenvr/autopilot) (Apache-2.0): the game-agent design (game-level options, a decider, executors, per-game memory), re-implemented here independently.

# PlayPilot

Agent playtesting for mobile games. An AI agent (or a seeded explorer, for CI) plays your iOS or Android game on a simulator, step by step, and leaves you a report you can act on: findings with the exact step, frame and video time, a replay that reproduces them without a model, and a memory of the game that makes the next run smarter.

It works on any game, including engine-drawn ones (Unity, Godot, SpriteKit, Rive, Metal) that expose little or no accessibility. An optional in-game probe makes it precise: real button positions, the game's own screen names, engine exceptions, and frame-accurate game actions.

```text
$ playpilot agent start playpilot/explore.json
step 0 | screen s1 (new) scene=Home
frame runs/first/frames/step-000.png (874x402 points; frame pixels are tap coordinates)
facts coins=120
options:
  1. ui:Play [probe]
  2. ui:Settings [probe]
  3. ui:Buy 500 Coins [probe, RISKY: avoid unless asked]
  4. game:skip-tutorial - Finish the tutorial instantly [game]
$ playpilot agent act ui:Play
step 1 | screen s2 (new) scene=Level
...
```

## What it finds

| Finding | How |
| --- | --- |
| `crash` | OS crash reports for your process, fatal log lines, and the app vanishing, merged into one finding at the step that caused it |
| `exception`, `error_log` | Engine and app errors, from the probe or the app log (simulator and harness noise filtered out) |
| `game_invariant` | Rules your game checks on itself, reported through the probe |
| `softlock` | Several different real controls did nothing visible |
| `blank_screen` | A flat frame two observations in a row |
| `memory_growth` | Resident memory grew by more than 50% and 150 MB during the run |
| `slow_step` | One action took longer than `slowStepMs` |
| `command_failed` | A tap or command the device could not perform |
| `agent` | What the agent saw and judged (layout, copy, flow) with its frame |

Every finding carries a severity. `--fail-on` turns them into an exit code.

## How it works

Each step is observe, pick, act:

1. **Observe.** One parallel call reads the accessibility tree, a screenshot (simctl, about 0.7 s) and the probe state. Frames are saved in screen points, so pixel coordinates in a frame are tap coordinates.
2. **Pick.** The screen's legal options are listed: probe targets, game actions, accessible controls, your scenario's macros, and a tap grid when the screen offers nothing else. An agent picks by name, or the explorer picks the option it has tried least on this screen across all runs.
3. **Act.** Device input is sent in one batch; game actions go through the probe and finish at frame accuracy inside the game.

Screens are identified by the probe's scene and screen, or by the accessibility labels, or by a perceptual hash of the frame, so memory survives restarts and builds. Changes are judged on a downscaled frame, so a small popup counts and video noise does not.

See [docs/architecture.md](docs/architecture.md).

## Install

Requires macOS with Xcode for iOS and Node 22.12 or later. PlayPilot drives the device through one command-line tool; install it once:

```bash
npm install -g agent-device
```

Add `adb` for Android.

Then install PlayPilot:

```bash
git clone https://github.com/DevgenX/playpilot-kit && cd playpilot-kit && npm install && npm run build && npm link
```

```bash
playpilot doctor
```

## Quick start

```bash
playpilot init --app com.example.mygame
```

This writes `playpilot/explore.json`, `playpilot/smoke.json` and slim-simulator profiles into your repo. Boot a simulator, install a development build, then:

```bash
playpilot sim prepare <udid> --profile playpilot/slim-game.json
```

```bash
playpilot run playpilot/explore.json --udid <udid> --out runs/first
```

Open `runs/first/report.md`. To let an agent drive instead, use the skill below or `playpilot agent start`.

To write scenarios for your own goals, see [the scenario reference](skills/playpilot/references/scenarios.md).

## Use it from Claude Code (skill)

This repo is a Claude Code plugin. The `playpilot` skill teaches the agent the loop: start, look at each frame, pick an option, wait after loads, note what looks wrong, finish.

```bash
claude plugin marketplace add DevgenX/playpilot-kit
```

```bash
claude plugin install playpilot@playpilot-kit
```

Then ask: "playtest my game on the booted simulator and report anything broken".

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Checks the device tools (and stale daemons), Xcode, adb and disk |
| `init` | Writes starter scenarios and profiles |
| `sim prepare/verify/restore/measure/categories` | Slims a simulator, checks it for drift, switches it back to stock, measures its memory, or lists what slimming turns off |
| `run` | Autonomous explore or scripted run. No model, seeded, good for CI |
| `plan` | Prints the commands a run starts with, without a device |
| `agent start/act/observe/note/finish` | One command per step for an agent |
| `replay` | Replays a run, or its first N steps, without a model |
| `promote` | Saves the steps up to a finding as a regression |
| `regress` | Runs saved regressions and fails on findings |

Exit codes: `0` pass, `1` findings at or above `--fail-on` (default `high`) or a missed goal, `2` usage error.

## What a run leaves

```text
runs/first/
  report.md        findings by severity with step, video time, frame, and how to reproduce
  report.json      the same, for tools
  frames/          step-NNN.png, one per observation, in screen points
  run.mp4          the whole run, plus contact-sheet.png
  steps.json       replayable steps (playpilot replay)
  replay.ad        the same steps as a standalone device script
```

Memory lives in `.playpilot/memory/<app>.json` and is shared by every run of that app.

## The probe (optional, recommended for engine games)

A probe is a small, development-only component in the game that shares its own view through a few files in the app's data folder. With it, the agent taps real engine buttons instead of a grid, knows the screen names, sees engine exceptions, and can run game actions like "play one round" at frame accuracy.

- Unity: [probes/unity](probes/unity), a UPM package. Add it and it starts itself in development builds.
- Anything else: [docs/probe-protocol.md](docs/probe-protocol.md) is short, file-based and engine-neutral.

## Slim simulators

A stock iOS simulator runs about 240 background processes that a game never uses (Siri, Spotlight, iCloud sync, Health, wallpaper posters and more). `playpilot sim prepare <udid>` switches them off and reboots once:

| | Processes | Memory |
| --- | --- | --- |
| Stock iPhone simulator, settled | 242 | 2,752 MB |
| Slim (`slim-game.json`) | 78 | 697 MB |

That is about a quarter of the memory, so several agents can play at once on one Mac. Game Center, game controllers and saved games are never touched. Profiles keep whole categories on with `except` (for example `["store"]` for in-app purchases) and single services with `keep`. Run `playpilot sim categories` to see what each one turns off, and `playpilot sim restore <udid>` to go back to stock. A simulator that already matches its profile is left alone, so calling `prepare` before every run costs about five seconds.

## Safety

- The explorer never presses options that look like purchases, subscriptions, deletes, sign-outs or progress resets. Scenarios can add patterns with `avoid`, or opt out with `allowRisky`.
- The probe compiles only into development builds.
- Runs touch only the simulator or device you name.

## Limits

- Physical iPhones work, but the probe file channel and fast screenshots are simulator-only.
- Android is supported but has had less real-device testing than iOS.
- Each device step takes about a second. Timing-critical play (rhythm, reflexes) belongs in probe game actions, not taps.

## License

Apache-2.0

# The agent loop in detail

## What an observation says

```text
step 4 | screen s3 (visit 2) scene=Match screen=pause-menu
frame /path/runs/agent-20260105-101500/frames/step-004.png (874x402 points; frame pixels are tap coordinates)
facts score="3-1" level=2
new findings:
  ! high exception: NullReferenceException: Object reference not set
options:
  1. ui:Resume [probe]
  2. ui:Quit [probe, tried 1x]
  3. game:round - Play one round with the built-in bot [game]
  4. button:Settings [a11y]
  5-16. grid:r<row>c<col> blind taps across the screen [grid]
```

| Part | Meaning |
| --- | --- |
| `step` | Steps taken so far. Findings and notes refer to these numbers. |
| `screen sN` | PlayPilot's id for this screen, stable across runs. `(new)` means never seen before in any run. `(visit N)` counts visits. |
| `scene=`, `screen=` | Names from the game's probe, when it has one. |
| `frame` | The screenshot after the last step. Always look at it. |
| `facts` | Values the game shares through its probe (score, level, coins). |
| `new findings` | What PlayPilot detected on this step (crash, exception, softlock, error log, blank screen, slow step). |
| `options` | What can be done here. Sources: `probe` (the game's own buttons), `game` (frame-accurate game actions), `a11y` (accessibility controls), `custom` (scenario macros), `grid` (blind taps). `tried Nx` counts tries on this screen across runs. |
| `done:` | The session ended itself (crash, goal reached, step or time limit). Run the `finish` command it prints. |

When the screen has no accessible or probe targets, the observation says so: look at the frame and use `--tap x,y`.

## Choosing well

- **Goal first.** If the user gave a goal, work toward it. Explore side screens only when the goal path is blocked or done.
- **New before old.** Prefer options with no `tried` count and screens marked `(new)`.
- **Exercise the game, not just menus.** Use `game:` actions to play rounds; check that facts change the way the rules say they should.
- **Check each screen as a player.** Text cut off, overlapping UI, wrong numbers, missing art, a button that does nothing, a flow with no way back: each is a `note`.
- **Back out of dead ends** with `--back` or a visible close button, not by restarting.

## Timing

- Each step costs about 2 to 4 seconds (action, settle, screenshot, tree).
- After taps that load a scene, use `--wait 2000` to `--wait 5000` before judging.
- A probe that sets `busy` makes PlayPilot wait for it automatically (up to 10 s).
- Timing-critical play (dodging, rhythm, combos) is not possible through taps. Use the game's `game:` actions for it.

## Notes

```bash
playpilot agent note "<what a player sees, and why it is wrong>" --severity <level> --step <n>
```

- Write what you saw, where, and what you expected. One problem per note.
- `--step` is the step whose result showed the problem (the frame you looked at). Default: the latest step.
- The frame for that step is attached to the finding automatically.

## Sessions

- `agent start` prints `session <dir>` and remembers it in `.playpilot/current-session`. Later commands use it unless `--session <dir>` is given.
- Add `--json` to any agent command for machine-readable output.
- A session survives between commands: you can think as long as you need between steps.
- `finish` stops the video, writes `report.md`, `report.json`, `steps.json`, `replay.ad` and a contact sheet, saves memory and closes the app.

## When something goes wrong

| Symptom | Do this |
| --- | --- |
| `doctor` says the daemon belongs to another install | Run the `daemon stop` fix it prints, then retry. |
| `start` fails with "needs a device" | Pass `--udid <udid>` of a booted simulator. |
| Every option fails with a stale ref | `playpilot agent observe` to refresh, then act again. |
| A crash ended the session | `finish` (outcome `not_achieved` if the goal was not met), then `replay <run-dir> --to-step <n>` to confirm it repeats. |
| The screen did not change after a tap | Check the frame: wrong spot, a loading screen, or a real softlock. Try `--wait`, then another control. |

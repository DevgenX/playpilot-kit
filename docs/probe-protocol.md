# Game probe protocol (v1)

A probe is a small, debug-only piece of code inside the game. It is optional: PlayPilot works without one by reading the accessibility tree, screenshots and logs. With a probe, the agent sees the game the way the game sees itself, and it can drive timing-critical play inside the game instead of through slow simulated taps.

A probe gives PlayPilot four things:

1. **State.** The current scene or screen and any facts the game wants to share (score, level, health).
2. **Targets.** The on-screen hit areas of the game's own UI (buttons drawn by the engine, which the accessibility tree cannot see), so the agent taps real buttons instead of guessing with a grid.
3. **Actions.** Named game-level macros the game runs itself, such as "play the next round" or "skip the tutorial". These run at frame accuracy, so timing-critical play works even though each device command takes a second.
4. **Errors.** Engine errors and exceptions, reported by the engine itself rather than scraped from system logs.

The channel is plain files in the app's own data folder, so a probe needs no network port, no URL scheme and no extra permissions.

## Folder

`<app data folder>/playpilot/`

| Engine | App data folder |
| --- | --- |
| Unity | `Application.persistentDataPath` |
| Godot | `user://` |
| Native iOS | the app's `Documents` folder |
| Native Android | `Context.getExternalFilesDir(null)` |

Instances of one game on one machine share that data folder, so they would read each other's state and run each other's commands. A probe may take its whole folder from the command line instead; the Unity probe reads `-playpilotFolder=<path>` (`PlayPilot.Folder`). Give each instance its own, for example editor test runs side by side.

How PlayPilot reaches it:

- **iOS simulator.** `xcrun simctl get_app_container <udid> <bundle-id> data`, then `Documents/playpilot/`. The folder is on the Mac's disk, so reads and writes are plain file operations.
- **Android emulator or device.** `/sdcard/Android/data/<package>/files/playpilot/` through `adb shell cat` and `adb push`.
- **Physical iPhone.** Not supported by the file channel yet. PlayPilot still works there without the probe.

## Files

All files are UTF-8 JSON. Writers must write a temporary file in the same folder and rename it over the target, so a reader never sees half a file.

### `state.json` (game writes, PlayPilot reads)

Written whenever something in it changes, at most 10 times a second.

```json
{
  "v": 1,
  "seq": 412,
  "time": 37.25,
  "scene": "Match",
  "screen": "pause-menu",
  "busy": false,
  "facts": { "score": "3-1", "level": 2 },
  "targets": [
    { "id": "pause.resume", "label": "Resume", "kind": "button", "x": 0.5, "y": 0.42, "w": 0.22, "h": 0.08 }
  ],
  "actions": [
    { "id": "round", "description": "Play one round with the built-in bot" }
  ],
  "ack": { "id": "cmd-7", "ok": true, "message": "round won 3-1" }
}
```

| Field | Meaning |
| --- | --- |
| `v` | Protocol version, always `1`. |
| `seq` | Increases by one on every write. |
| `time` | Seconds since the game started (unscaled). |
| `scene`, `screen` | Where the player is. `screen` is the finer one (a menu or panel); either may be empty. PlayPilot uses them to tell screens apart. |
| `busy` | True while the game is loading (the game sets it) or running an action (the probe sets it). PlayPilot waits up to 10 s for `false` before it observes. |
| `facts` | Free-form, small values only (strings, numbers, booleans). Shown to the agent. |
| `targets` | Interactable hit areas on screen right now. `x`, `y` are the **centre**, `w`, `h` the size, all as fractions of the screen with the origin at the **top left**. Only include targets that are visible and enabled. |
| `actions` | Macros the game can run right now (`id` plus a one-line `description`). |
| `ack` | The result of the last command (see `inbox.json`). Absent until the first command. |

### `events.jsonl` (game appends, PlayPilot reads)

One JSON object per line, appended in order. PlayPilot remembers how far it has read.

```json
{"time": 12.5, "level": "exception", "message": "NullReferenceException: Object reference not set", "detail": "at Player.Update () ..."}
{"time": 14.0, "level": "error", "message": "Missing sprite: coin_gold"}
{"time": 20.1, "level": "finding", "message": "Player fell through the floor"}
```

`level` is one of `exception`, `error`, `warning`, `finding`. Use `finding` for invariant checks the game runs on itself (the game knows best when its own rules break). Keep `detail` under 2,000 characters. Truncate the file when the game starts.

### `inbox.json` (PlayPilot writes, game reads and deletes)

```json
{ "id": "cmd-7", "action": "round", "args": { "seconds": 20 } }
```

The probe polls for this file (every 0.2 s is enough), deletes it, runs the action, and then writes `ack` with the same `id` into `state.json`. Actions may take many frames. The probe sets `busy: true` while one runs. An unknown action gets `"ok": false` with a message.

PlayPilot waits for the matching `ack` (default timeout 60 s, set per action with `args.timeoutMs`).

## Log lines (optional)

A probe may also print one line per state change, for people reading device logs:

```
PLAYPILOT {"v":1,"seq":412,"scene":"Match","screen":"pause-menu"}
```

PlayPilot reads the files, not these lines, and ignores them when it scans logs for errors.

## Rules for probe authors

- Compile the probe into development builds only. In Unity, guard it with `#if DEVELOPMENT_BUILD || UNITY_EDITOR`, or keep it out of release scenes.
- Never write personal data, tokens or account ids into any of these files.
- Keep writes cheap: only on change, at most 10 per second, and never block the main thread on file IO for long.
- Report targets in screen space after any safe-area or letterbox offsets, because the agent taps exactly there.

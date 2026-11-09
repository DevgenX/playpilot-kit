# Writing a scenario

A scenario is a JSON file committed next to the game (by convention in `playpilot/`). Unknown fields are rejected, so typos fail before the device is touched. Check one with `playpilot plan <file>`.

## Minimal

```json
{
  "name": "explore",
  "app": "com.example.mygame",
  "platform": "ios",
  "mode": "explore",
  "goal": "Explore every screen you can reach and report anything broken"
}
```

## For a goal

```json
{
  "name": "first-level",
  "app": "com.example.mygame",
  "platform": "ios",
  "mode": "explore",
  "goal": "Finish the tutorial and win the first level",
  "success": { "label": "Level Complete" },
  "maxSteps": 60,
  "launchWaitMs": 5000,
  "avoid": ["rate us", "share"]
}
```

`success.label` (visible text) or `success.screen` (probe screen name) ends the session as `achieved` automatically.

## Scripted smoke test (CI)

```json
{
  "name": "smoke",
  "app": "com.example.mygame",
  "platform": "ios",
  "mode": "scripted",
  "goal": "Start a game from the home screen",
  "script": ["Play", "Level 1"],
  "success": { "label": "Pause" },
  "video": false
}
```

Each script entry is an option name (exact, then substring). A step that does not appear within 8 seconds fails the run.

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `name`, `app`, `platform`, `goal` | required | `app` is the bundle id or package name; `platform` is `ios` or `android` |
| `mode` | `explore` | `explore` or `scripted` |
| `device` | none | `{ "udid": "..." }` (iOS) or `{ "serial": "..." }` (Android); `--udid` overrides |
| `slim` | none | `{ "profile": "slim-game.json", "requires": [] }`: slim the simulator first; path relative to the scenario |
| `maxSteps`, `maxMinutes` | 30, 20 | Hard limits |
| `seed` | 1 | Explorer randomness, for repeatable runs |
| `script` | `[]` | Option names for `scripted` mode |
| `success` | none | `{ "label": "..." }` or `{ "screen": "..." }` |
| `avoid` | purchases, deletes, sign-out, resets | Extra regex patterns never pressed by the explorer |
| `allowRisky` | false | Drop the default avoid list (only for testing those flows on purpose) |
| `canvas` | none | `{ "cols": 4, "rows": 3, "inset": 0.08 }`: always offer a tap grid (games drawn on one canvas) |
| `customOptions` | `[]` | Named macros, below |
| `softlockActions` | 4 | Different real controls with no visible change before a softlock is reported |
| `slowStepMs` | 5000 | Steps slower than this are reported |
| `settleMs` | 800 | Wait after each action before observing |
| `launchWaitMs` | 3000 | Wait after launch (splash, loading) |
| `video` | true | Record `run.mp4` and a contact sheet |
| `memoryEvery` | 10 | Sample app memory every N steps (0 = never) |
| `probe` | `auto` | `off` to ignore an in-game probe |
| `appEventUrl` | none | Deep link template with `{event}`, for `appEvent` actions |
| `launchArgs` | `[]` | Arguments passed to the app at launch |
| `relaunch` | true | Kill and relaunch the app at the start |

## Custom options

Macros the explorer and agents can choose, shown only when `when` matches:

```json
"customOptions": [
  {
    "name": "drag-piece-to-board",
    "description": "Drag the first piece onto the board centre",
    "when": { "label": "Pieces" },
    "actions": [
      { "kind": "pan", "from": { "x": 80, "y": 700 }, "dx": 120, "dy": -400, "ms": 400 },
      { "kind": "wait", "ms": 500 }
    ]
  }
]
```

`when` takes `label` (visible text), `screen` or `scene` (probe names). Action kinds: `press` (`selector` like `label="Play"`), `tap` (`at`, optional `count`, `holdMs`), `longpress` (`at`, `ms`), `pan` (`from`, `dx`, `dy`, `ms`), `fill` (`selector`, `text`), `type` (`text`), `back`, `wait` (`ms`), `appEvent` (`event`, `payload`), `game` (`action`, `args`). Coordinates are screen points.

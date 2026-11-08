# PlayPilot Probe for Unity

A small, debug-only probe that lets PlayPilot see and drive your Unity game from the inside. It implements the [PlayPilot game probe protocol](../../docs/probe-protocol.md) (v1) over plain files in `Application.persistentDataPath/playpilot/`:

- **State** (`state.json`): active scene, your screen name, facts, on-screen targets, available actions, busy flag and the last command's ack.
- **Targets**: every visible, interactable uGUI `Selectable` (Button, Toggle, Slider, Dropdown, InputField, Scrollbar and TextMesh Pro equivalents), found automatically, plus any targets you report yourself.
- **Actions**: named macros you register, run as coroutines when PlayPilot writes `inbox.json`.
- **Errors** (`events.jsonl`): exceptions, errors and asserts from the Unity log, plus findings you report.

Requires Unity 2021.3 or newer and uGUI (`com.unity.ugui`). No other dependencies.

## Install

In Unity, open **Window > Package Manager > + > Add package from git URL** and enter:

```
https://github.com/DevgenX/playpilot-kit.git?path=probes/unity
```

Or add it to `Packages/manifest.json`:

```json
"dev.playpilot.probe": "https://github.com/DevgenX/playpilot-kit.git?path=probes/unity"
```

Append `#<tag>` to the URL to pin a release.

## Quick start

Nothing to set up: the probe creates itself after the first scene loads. Tell it where the player is and what it can do:

```csharp
using PlayPilotKit;

public class MyGameProbeHooks : UnityEngine.MonoBehaviour
{
    void OnEnable()
    {
        PlayPilot.SetScreen("main-menu");
        PlayPilot.SetFact("level", 1);
        PlayPilot.RegisterAction("start", "Start a new game", args => MyGame.StartNewGame());
    }
}
```

## API reference

All members are on the static class `PlayPilotKit.PlayPilot`. Call them from the main thread, except `ReportFinding`, which is thread-safe.

| Member | What it does |
| --- | --- |
| `SetScreen(string screen)` | Sets `screen`, the finer location (menu, panel). Null or empty clears it. `scene` is filled in automatically from the active scene. |
| `SetFact(string key, object value)` | Adds or updates a fact. Strings, booleans and numbers are kept; other values are written as their `ToString()` text. |
| `ClearFact(string key)` | Removes a fact. |
| `SetBusy(bool busy)` | Marks the game busy (for example while loading). The probe also reports busy on its own while an action runs. |
| `RegisterAction(string id, string description, Func<IDictionary<string, object>, IEnumerator> run)` | Registers a multi-frame action, run as a coroutine on the probe. Yielded nested `IEnumerator`s run inline. Yield a `string` to set the ack message (it also waits one frame). |
| `RegisterAction(string id, string description, Action<IDictionary<string, object>> run)` | Registers an action that finishes within the frame. |
| `UnregisterAction(string id)` | Removes an action. |
| `ReportFinding(string message, string detail = null)` | Writes a `finding` event: a rule of your game that broke. |
| `RegisterTargetProvider(Func<IEnumerable<PlayPilotTarget>> provider)` | Adds a callback listing targets the game draws itself (world-space objects, custom UI). Called up to 4 times a second. |
| `UnregisterTargetProvider(...)` | Removes that callback. |
| `Enabled` (static bool) | Master switch, `true` by default in the Editor and development builds. Read at startup to decide whether the probe is created; setting it to `false` later pauses the probe. |
| `ReportWarnings` (static bool) | Also report Unity warnings as `warning` events. Default `false`. |
| `LogLines` (static bool) | Also print `PLAYPILOT {"v":1,"seq":..,"scene":..,"screen":..,"busy":..}` to the log when scene, screen or busy change, for people reading device logs (Xcode console, logcat). PlayPilot itself reads the files, not these lines. Default `false`. |

### Actions

Command args arrive as `IDictionary<string, object>` holding `string`, `double`, `bool`, `null`, nested `Dictionary<string, object>` and `List<object>`. Missing args give an empty dictionary.

```csharp
PlayPilot.RegisterAction("wait", "Wait for args.seconds seconds", WaitAction);

static IEnumerator WaitAction(IDictionary<string, object> args)
{
    double seconds = args.TryGetValue("seconds", out object s) && s is double d ? d : 1;
    yield return new WaitForSecondsRealtime((float)seconds);
    yield return "waited " + seconds + " s"; // becomes the ack message
}
```

- An action that throws (when started or on any step) fails the command: `ok: false` with the exception type and message. The exception is also written to `events.jsonl`.
- An unknown action id gets `ok: false` with `unknown action <id>`.
- One command runs at a time. A command written while an action runs stays in `inbox.json` until that action ends.

### Targets

uGUI targets are found automatically. A `Selectable` is listed when it is enabled, interactable, inside an enabled canvas, not hidden by a `CanvasGroup` (alpha 0 or blocks raycasts off) and at least partly on screen. Up to 60 targets are listed; your provider targets come first.

- **id**: the `PlayPilotLabel` component's `id`, else the hierarchy path (`Canvas/Pause/Resume`). Repeated ids get `#2`, `#3`.
- **label**: the `PlayPilotLabel` component's `label`, else the text of the first child `Text`, else the GameObject name. For TextMesh Pro buttons, add a `PlayPilotLabel` to get a readable label.
- **kind**: `button`, `toggle`, `slider`, `scrollbar`, `dropdown`, `input` or `selectable`.

For your own targets, return `PlayPilotTarget` values with `screenRect` in **screen pixels, Unity screen space (origin at the bottom left)**, the space `Camera.WorldToScreenPoint` returns. The probe clips each rect to the screen and converts it to the protocol's top-left centre and size fractions. Targets without an `id` are skipped; an empty `kind` becomes `custom`.

```csharp
PlayPilot.RegisterTargetProvider(() => MyGame.Coins.Select(coin =>
{
    Vector3 p = Camera.main.WorldToScreenPoint(coin.transform.position);
    return new PlayPilotTarget("coin." + coin.Index, "Coin", "item", new Rect(p.x - 40, p.y - 40, 80, 80));
}));
```

## How it behaves

- `state.json` is rewritten only when its content changes, at most 10 times a second, through a temporary file renamed over the old one. `seq` goes up by one per write.
- Targets are rescanned at most 4 times a second; nothing is written when they did not change.
- `inbox.json` is checked every 0.2 s (unscaled time) and deleted before its action runs.
- On startup the probe empties `events.jsonl` and deletes any leftover `inbox.json`.
- Exceptions and asserts become `exception` events, errors `error` events. The same message with the same first stack line is written at most once every 5 s. `message` and `detail` are cut to 2,000 characters.
- Errors logged during the first scene's `Awake` are kept and written once the probe starts.

## Release safety

The probe only compiles when `DEVELOPMENT_BUILD` or `UNITY_EDITOR` is defined. In release builds every `PlayPilot` method is an empty stub, so your calls still compile, no probe object is created, no files are written and no log listener is installed. To leave the probe out of every build, including development builds and the Editor, add the scripting define `PLAYPILOT_DISABLE` (**Project Settings > Player > Scripting Define Symbols**).

Never put personal data, tokens or account ids into facts, findings or target labels: they are written to plain files on the device.

## License

Apache-2.0

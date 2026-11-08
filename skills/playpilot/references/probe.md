# Game probes

A probe is optional, development-only code in the game that shares the game's own view with PlayPilot through files in the app's data folder. Recommend it when the game draws its own UI (Unity, Godot, SpriteKit, Rive, Metal) and the options list is mostly `grid:` taps.

With a probe the agent gets:

- `ui:` options at the real positions of the game's buttons, instead of blind grid taps
- `scene=` and `screen=` names, so screens are identified reliably across runs and builds
- `facts` such as score, level, coins, health
- `game:` actions that run inside the game at frame accuracy (play a round, skip the tutorial, jump to a level)
- engine exceptions and the game's own invariant checks as findings

## Unity

The package lives in `probes/unity` of the PlayPilot repo. Add it with Package Manager > Add package from git URL: `https://github.com/DevgenX/playpilot-kit.git?path=probes/unity`. It creates itself in development builds after the first scene loads and finds uGUI buttons, toggles, sliders and input fields by itself.

Optional calls from game code (all compile away in release builds):

```csharp
using PlayPilotKit;

PlayPilot.SetScreen("pause-menu");
PlayPilot.SetFact("score", "3-1");
PlayPilot.SetBusy(true);   // while loading; PlayPilot waits for false
PlayPilot.RegisterAction("round", "Play one round with the built-in bot", args => PlayRound(args)); // a coroutine; yield a string to set the result message
PlayPilot.ReportFinding("Player fell through the floor");
```

Custom-drawn controls can be added with `PlayPilot.RegisterTargetProvider`.

## Other engines

Implement [the protocol](https://github.com/DevgenX/playpilot-kit/blob/main/docs/probe-protocol.md): write `state.json` on change, append `events.jsonl`, and poll `inbox.json` for actions. It is three small JSON files in `<app data>/playpilot/`.

## Where it works

The file channel works on the iOS simulator and on Android (emulator or device). On a physical iPhone, PlayPilot runs without the probe.

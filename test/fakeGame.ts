import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exec, ExecResult } from "../src/exec.js";
import { encodePng, type Image } from "../src/harness/image.js";

/**
 * A small fake mobile game behind fake agent-device, xcrun simctl and simslim CLIs, answering with the JSON
 * shapes agent-device 0.21 really prints, so the whole loop runs on any OS.
 *
 * Screens (viewport 400x200 points, landscape; simctl screenshots are 3x like a retina simulator):
 * - Home: buttons Play, Settings and "Buy 500 Coins" (a purchase the explorer must never press).
 * - Settings: Back.
 * - Level: an engine canvas with no accessibility at all (like a Unity, Godot or Metal game). A tap in the
 *   bottom-right quarter wins; a tap in the top-left quarter crashes the game. A small sprite moves every frame.
 * - Win: "Well done!" text and a Home button.
 * With `probe: true` the Level screen also runs a game probe: it reports a "Pause" target and a "win" action.
 */
export type Screen = "Home" | "Settings" | "Level" | "Win" | "Crashed";

export const UDID = "11111111-2222-3333-4444-555555555555";
export const VIEW = { width: 400, height: 200 };

interface Control {
  readonly type: string;
  readonly label: string;
  readonly id: string;
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly to?: Screen;
}

const CONTROLS: Record<Screen, readonly Control[]> = {
  Home: [
    { type: "Button", label: "Play", id: "play", rect: { x: 150, y: 60, width: 100, height: 30 }, to: "Level" },
    { type: "Button", label: "Settings", id: "settings", rect: { x: 150, y: 100, width: 100, height: 30 }, to: "Settings" },
    { type: "Button", label: "Buy 500 Coins", id: "shop.buy", rect: { x: 150, y: 140, width: 100, height: 30 } },
  ],
  Settings: [{ type: "Button", label: "Back", id: "back", rect: { x: 10, y: 10, width: 60, height: 30 }, to: "Home" }],
  Level: [],
  Win: [
    { type: "StaticText", label: "Well done!", id: "", rect: { x: 120, y: 40, width: 160, height: 30 } },
    { type: "Button", label: "Home", id: "home", rect: { x: 150, y: 120, width: 100, height: 30 }, to: "Home" },
  ],
  Crashed: [],
};

const COLOURS: Record<Screen, [number, number, number]> = {
  Home: [30, 90, 200],
  Settings: [120, 120, 120],
  Level: [20, 140, 60],
  Win: [230, 180, 20],
  Crashed: [0, 0, 0],
};

export interface FakeGame {
  readonly exec: Exec;
  readonly calls: string[][];
  readonly purchases: number;
  screen(): Screen;
  /** Lets the in-game probe handle its inbox (call from the test's sleep). */
  tick(): Promise<void>;
}

export interface FakeOptions {
  readonly root: string;
  readonly probe?: boolean;
  readonly simslimOk?: boolean;
}

function frame(screen: Screen, frameNo: number, scale: number): Image {
  const width = VIEW.width * scale;
  const height = VIEW.height * scale;
  const data = new Uint8Array(width * height * 4);
  const [r, g, b] = COLOURS[screen];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const band = screen === "Crashed" ? 0 : Math.floor((x / width) * 4) * 18 + Math.floor((y / height) * 3) * 25;
      data[i] = (r + band) & 0xff;
      data[i + 1] = (g + band) & 0xff;
      data[i + 2] = (b + band) & 0xff;
      data[i + 3] = 255;
    }
  }
  for (const c of CONTROLS[screen]) {
    for (let y = c.rect.y * scale; y < (c.rect.y + c.rect.height) * scale; y += 1) {
      for (let x = c.rect.x * scale; x < (c.rect.x + c.rect.width) * scale; x += 1) data.set([250, 250, 250, 255], (y * width + x) * 4);
    }
  }
  if (screen === "Level") {
    // an idle animation: a small sprite that moves every frame
    const sx = (frameNo * 7) % (width - 6 * scale);
    for (let y = 10 * scale; y < 16 * scale; y += 1) for (let x = sx; x < sx + 6 * scale; x += 1) data.set([255, 0, 0, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

const ok = (data: unknown = {}): ExecResult => ({ code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" });
const fail = (code: string, message: string, reason?: string): ExecResult => ({
  code: 1,
  stdout: JSON.stringify({ success: false, error: { code, message, ...(reason ? { details: { reason } } : {}) } }),
  stderr: "",
});

export function fakeGame(options: FakeOptions): FakeGame {
  const { root } = options;
  const logPath = join(root, "app.log");
  const container = join(root, "container");
  const probeDir = join(container, "Documents", "playpilot");
  const crashDir = join(root, "crash-reports");
  let screen: Screen = "Home";
  let frameNo = 0;
  let purchases = 0;
  let seq = 0;
  let ack: { id: string; ok: boolean; message: string } | null = null;
  const calls: string[][] = [];

  const log = async (line: string): Promise<void> => {
    let text = "";
    try {
      text = await readFile(logPath, "utf8");
    } catch {
      // first line
    }
    await writeFile(logPath, text + line + "\n");
  };

  const writeProbe = async (): Promise<void> => {
    if (!options.probe) return;
    await mkdir(probeDir, { recursive: true });
    seq += 1;
    const level = screen === "Level";
    const state = {
      v: 1,
      seq,
      time: seq / 10,
      scene: level ? "Level1" : "Menu",
      screen: screen.toLowerCase(),
      busy: false,
      facts: level ? { lives: 3 } : {},
      targets: level ? [{ id: "pause", label: "Pause", kind: "button", x: 0.95, y: 0.1, w: 0.06, h: 0.1 }] : [],
      actions: level ? [{ id: "win", description: "Finish the level" }] : [],
      ...(ack ? { ack } : {}),
    };
    await writeFile(join(probeDir, "state.json"), JSON.stringify(state));
  };

  const go = async (to: Screen): Promise<void> => {
    screen = to;
    await writeProbe();
  };

  const crash = async (): Promise<void> => {
    screen = "Crashed";
    await log("2026-01-01 12:00:01.000 E  FakeGame[42:1a2b] (libswiftCore.dylib) Fatal error: Index out of range");
    await mkdir(crashDir, { recursive: true });
    await writeFile(join(crashDir, `FakeGame-2026-01-01-120001.ips`), "{}");
  };

  const tap = async (x: number, y: number): Promise<void> => {
    if (screen === "Level") {
      if (options.probe && x > VIEW.width * 0.9 && y < VIEW.height * 0.2) return; // pause does nothing here
      if (x > VIEW.width / 2 && y > VIEW.height / 2) await go("Win");
      else if (x < VIEW.width / 2 && y < VIEW.height / 2) await crash();
      return;
    }
    const hit = CONTROLS[screen].find((c) => x >= c.rect.x && x <= c.rect.x + c.rect.width && y >= c.rect.y && y <= c.rect.y + c.rect.height);
    if (hit?.label.startsWith("Buy")) purchases += 1;
    if (hit?.to) await go(hit.to);
  };

  const press = async (target: string): Promise<ExecResult> => {
    if (screen === "Crashed") return fail("COMMAND_FAILED", "app is not running", "app_not_running");
    const controls = CONTROLS[screen];
    let control: Control | undefined;
    if (target.startsWith("@e")) control = controls[Number(target.slice(2)) - 2];
    else control = controls.find((c) => target.includes(`id="${c.id}"`) || target.includes(`label="${c.label}"`));
    if (!control) return fail("COMMAND_FAILED", `no element matches ${target}`, "target_not_found");
    await tap(control.rect.x + control.rect.width / 2, control.rect.y + control.rect.height / 2);
    return ok({ targetKind: "ref", selectorChain: [`id="${control.id}"`, `label="${control.label}"`] });
  };

  const handle = async (verb: string, rest: string[]): Promise<ExecResult> => {
    switch (verb) {
      case "open":
        screen = "Home";
        await rm(crashDir, { recursive: true, force: true });
        await writeProbe();
        return ok({ device: "Fake iPhone", device_udid: UDID, startup: { durationMs: 900 } });
      case "logs":
        if (rest[0] === "clear") {
          await writeFile(logPath, "");
          return ok({ path: logPath, cleared: true, restarted: true });
        }
        return ok({ path: logPath });
      case "record":
        if (rest[0] === "start") await writeFile(rest[1] ?? join(root, "x.mp4"), "video");
        if (rest[0] === "contact-sheet") await writeFile(rest[rest.indexOf("--out") + 1] ?? join(root, "sheet.png"), "png");
        return ok({});
      case "perf":
        return ok({ metrics: { memory: { available: screen !== "Crashed", residentMemoryKb: 300_000 + frameNo * 1000, matchedProcesses: ["FakeGame"] } } });
      case "screenshot":
        frameNo += 1;
        await writeFile(rest[0] ?? join(root, "shot.png"), encodePng(frame(screen, frameNo, 1)));
        return ok({ path: rest[0] });
      case "snapshot": {
        if (screen === "Crashed") return fail("COMMAND_FAILED", "app is not running", "app_not_running");
        await log("2026-01-01 12:00:00.000 Df FakeGame[42:1a2b] [com.apple.dt.xctest:Default] Replying to query with results (error: (null))");
        const nodes = [
          { index: 0, type: "Application", label: "FakeGame", rect: { x: 0, y: 0, ...VIEW }, hittable: false, ref: "e1", kind: "application" },
          ...CONTROLS[screen].map((c, i) => ({ index: i + 1, type: c.type, label: c.label, identifier: c.id || undefined, rect: c.rect, hittable: true, ref: `e${i + 2}` })),
        ];
        return ok({ nodes, viewport: VIEW, truncated: false });
      }
      case "press": {
        if (rest.length >= 2 && /^\d+$/.test(rest[0] ?? "") && /^\d+$/.test(rest[1] ?? "")) {
          if (screen === "Crashed") return fail("COMMAND_FAILED", "app is not running", "app_not_running");
          await tap(Number(rest[0]), Number(rest[1]));
          return ok({ targetKind: "point" });
        }
        return press(rest[0] ?? "");
      }
      case "batch": {
        const steps = JSON.parse(rest[rest.indexOf("--steps") + 1] ?? "[]") as { command: string; input: Record<string, unknown> }[];
        const results = [];
        for (const step of steps) {
          const target = step.input["target"] as { kind: string; x?: number; y?: number; ref?: string; selector?: string } | undefined;
          let r: ExecResult = ok({});
          if (step.command === "press" && target?.kind === "point") {
            await tap(target.x ?? 0, target.y ?? 0);
          } else if (step.command === "press") {
            r = await press(target?.ref ?? target?.selector ?? "");
          }
          if (r.code !== 0) return r;
          results.push({ command: step.command, ok: true, data: (JSON.parse(r.stdout) as { data: unknown }).data });
        }
        return ok({ total: steps.length, executed: steps.length, results });
      }
      case "close":
      case "wait":
        return ok({});
      default:
        return ok({});
    }
  };

  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "simslim") {
      if (args[0] === "verify") return options.simslimOk === false ? { code: 1, stdout: "drift", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      if (args[0] === "measure") return { code: 0, stdout: JSON.stringify({ processes: 70, bytes: 943_718_400 }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "xcrun") {
      if (args[1] === "io") {
        frameNo += 1;
        await writeFile(args[args.length - 1] ?? join(root, "shot.png"), encodePng(frame(screen, frameNo, 3)));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get_app_container") return { code: 0, stdout: container + "\n", stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (command !== "agent-device") return { code: 127, stdout: "", stderr: "not found" };
    const plain = args.filter((a, i) => a !== "--json" && a !== "--no-record" && args[i - 1] !== "--session" && a !== "--session");
    const [verb = "", ...rest] = plain;
    return handle(verb, rest);
  };

  const tick = async (): Promise<void> => {
    if (!options.probe) return;
    const inbox = join(probeDir, "inbox.json");
    let text: string;
    try {
      text = await readFile(inbox, "utf8");
    } catch {
      return;
    }
    await rm(inbox, { force: true });
    const command = JSON.parse(text) as { id: string; action: string };
    if (command.action === "win" && screen === "Level") {
      await mkdir(probeDir, { recursive: true });
      await writeFile(join(probeDir, "events.jsonl"), JSON.stringify({ time: 3, level: "exception", message: "NullReferenceException: Confetti.Spawn", detail: "at Confetti.Spawn ()" }) + "\n", { flag: "a" });
      ack = { id: command.id, ok: true, message: "level finished" };
      await go("Win");
    } else {
      ack = { id: command.id, ok: false, message: `unknown action ${command.action}` };
      await writeProbe();
    }
  };

  return { exec, calls, get purchases() { return purchases; }, screen: () => screen, tick };
}

export function crashDirOf(root: string): string {
  return join(root, "crash-reports");
}

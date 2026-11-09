import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionArgs, parseSnapshot } from "../src/adapters/agentDevice.js";
import { parseProbeEvent, parseProbeState } from "../src/adapters/probe.js";
import { doctor } from "../src/doctor.js";
import type { Exec } from "../src/exec.js";
import { ExploreDecider, ScriptedDecider } from "../src/harness/deciders.js";
import { BlankScreenDetector, memoryGrowth, scanLog, SoftlockDetector } from "../src/harness/detectors.js";
import { decodePng, encodePng, frameFeatures, hashDistance, resize, thumbChange, VISIBLE_CHANGE, type Image } from "../src/harness/image.js";
import { structuralKey } from "../src/harness/memory.js";
import { deriveOptions, isRisky } from "../src/harness/options.js";
import type { GameOption, MemoryView, Observation } from "../src/harness/types.js";
import { absolutize, parseScenario, ScenarioError } from "../src/scenario.js";

function picture(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...paint(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

describe("image", () => {
  it("round-trips a PNG and shrinks it by area averaging", () => {
    const image = picture(30, 12, (x, y) => [x * 8, y * 20, 128]);
    const back = decodePng(encodePng(image));
    assert.equal(back.width, 30);
    assert.deepEqual([...back.data], [...image.data]);
    const small = resize(picture(6, 2, (x) => (x % 2 === 0 ? [0, 0, 0] : [200, 200, 200])), 3, 1);
    assert.deepEqual([...small.data.slice(0, 4)], [100, 100, 100, 255]);
  });

  it("decodes the filters real encoders use (sub, up, average, paeth)", async () => {
    const { deflateSync } = await import("node:zlib");
    // 2x2 RGB image, rows filtered with paeth (4) and average (3)
    const raw = Buffer.from([4, 10, 20, 30, 5, 5, 5, 3, 1, 2, 3, 4, 4, 4]);
    const png = encodePng(picture(1, 1, () => [0, 0, 0]));
    // rebuild with our own IHDR (colour type 2) and IDAT
    const sig = png.subarray(0, 8);
    const chunk = (type: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const decoded = decodePng(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
    // row 0 paeth with nothing above = sub: (10,20,30), (15,25,35)
    assert.deepEqual([...decoded.data.slice(0, 8)], [10, 20, 30, 255, 15, 25, 35, 255]);
    // row 1 average: first pixel (up/2)+v = (5+1, 10+2, 15+3); second ((left+up)/2)+v
    assert.deepEqual([...decoded.data.slice(8, 12)], [6, 12, 18, 255]);
    assert.deepEqual([...decoded.data.slice(12, 16)], [Math.floor((6 + 15) / 2) + 4, Math.floor((12 + 25) / 2) + 4, Math.floor((18 + 35) / 2) + 4, 255]);
  });

  it("gives near-equal hashes for a small animation and different hashes for a new screen", () => {
    const base = (sprite: number) => picture(120, 60, (x, y) => (y < 6 && x >= sprite && x < sprite + 4 ? [255, 0, 0] : [x * 2, y * 4, 90]));
    const a = frameFeatures(base(10));
    const b = frameFeatures(base(40));
    const other = frameFeatures(picture(120, 60, (x, y) => [255 - x * 2, 90, y * 4]));
    assert.ok(hashDistance(a.hash, b.hash) <= 4, `animation moved the hash by ${hashDistance(a.hash, b.hash)}`);
    assert.ok(hashDistance(a.hash, other.hash) > 10);
    assert.equal(a.blank, false);
    assert.equal(frameFeatures(picture(50, 50, () => [0, 0, 0])).blank, true);
  });

  it("sees a dialog open even when the coarse hash barely moves, but not an idle sprite", () => {
    const scene = (dialog: boolean, sprite: number) =>
      picture(320, 160, (x, y) => {
        if (dialog && x > 80 && x < 240 && y > 40 && y < 120) return [20, 60, 60];
        if (y < 8 && x >= sprite && x < sprite + 6) return [255, 0, 0];
        return [60 + (x >> 3), 120, 90 + (y >> 3)];
      });
    const plain = frameFeatures(scene(false, 10));
    assert.ok(thumbChange(plain.thumb, frameFeatures(scene(false, 200)).thumb) <= VISIBLE_CHANGE, "idle motion is not a change");
    assert.ok(thumbChange(plain.thumb, frameFeatures(scene(true, 10)).thumb) > VISIBLE_CHANGE, "a dialog is a change");
  });
});

describe("agent-device adapter", () => {
  it("normalizes a real 0.21 snapshot: refs get @, the app root and unhittable nodes go", () => {
    const snap = parseSnapshot({
      nodes: [
        { index: 0, type: "Application", label: "Game", rect: { x: 0, y: 0, width: 874, height: 402 }, hittable: false, ref: "e1", kind: "application" },
        { index: 1, type: "Button", label: "Play", identifier: "play", rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true, ref: "e2" },
        { index: 2, type: "Cell", label: "Hidden", hittable: false, ref: "e3" },
      ],
      viewport: { width: 874, height: 402 },
    });
    assert.deepEqual(snap.viewport, { width: 874, height: 402 });
    assert.deepEqual(snap.nodes, [{ ref: "@e2", type: "Button", label: "Play", identifier: "play", rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  });

  it("builds command lines for every input", () => {
    assert.deepEqual(actionArgs({ kind: "press", selector: 'label="Play"' }), ["press", 'label="Play"']);
    assert.deepEqual(actionArgs({ kind: "tap", at: { x: 10.4, y: 20.6 }, count: 2 }), ["press", "10", "21", "--count", "2"]);
    assert.deepEqual(actionArgs({ kind: "pan", from: { x: 1, y: 2 }, dx: 30, dy: 0, ms: 200 }), ["gesture", "pan", "1", "2", "30", "0", "200"]);
    assert.deepEqual(actionArgs({ kind: "appEvent", event: "level", payload: { n: 2 } }), ["trigger-app-event", "level", '{"n":2}']);
    assert.throws(() => actionArgs({ kind: "game", action: "x", args: {} }));
  });
});

describe("probe protocol", () => {
  it("parses state and drops malformed targets", () => {
    const state = parseProbeState(
      JSON.stringify({
        v: 1,
        seq: 3,
        scene: "Match",
        screen: "pause",
        busy: false,
        facts: { score: "1-0", nested: { no: 1 } },
        targets: [{ id: "resume", label: "Resume", x: 0.5, y: 0.4, w: 0.2, h: 0.1 }, { id: "off", x: 2, y: 0.5 }],
        actions: [{ id: "round", description: "Play a round" }, { description: "no id" }],
        ack: { id: "c1", ok: true, message: "done" },
      }),
    );
    assert.equal(state?.screen, "pause");
    assert.deepEqual(state?.facts, { score: "1-0" });
    assert.equal(state?.targets.length, 1);
    assert.equal(state?.actions.length, 1);
    assert.deepEqual(state?.ack, { id: "c1", ok: true, message: "done" });
    assert.equal(parseProbeState(JSON.stringify({ v: 2 })), null);
    assert.equal(parseProbeEvent('{"level":"debug","message":"x"}'), null);
    assert.equal(parseProbeEvent('{"level":"exception","message":"Boom"}')?.level, "exception");
  });
});

describe("log scanning", () => {
  it("ignores test-runner noise, keeps app errors and crashes, reports each once", () => {
    const seen = new Set<string>();
    const text = [
      "2026-01-01 12:00:00.000 Df Game[1:a] [com.apple.dt.xctest:Default] Replying to query with results (error: (null))",
      ")} (error: (null))",
      "2026-01-01 12:00:00.100 E  Game[1:a] [com.apple.xpc:connection] [0x1] error: Connection interrupted",
      "2026-01-01 12:00:00.200 E  Game[1:a] [com.example.game:net] Leaderboard request failed: 500",
      "2026-01-01 12:00:00.300 E  Game[1:a] [com.example.game:net] Leaderboard request failed: 501",
      "NullReferenceException: Object reference not set to an instance of an object",
      "2026-01-01 12:00:01.000 E  Game[1:a] (libswiftCore.dylib) Fatal error: Index out of range",
    ].join("\n");
    const scan = scanLog(text, 4, seen);
    assert.deepEqual(
      scan.findings.map((f) => f.kind),
      ["error_log", "error_log", "crash"],
    );
    assert.equal(scan.findings[0]?.step, 4);
    assert.equal(scanLog(text, 5, seen).findings.length, 0, "repeats are reported once");
  });
});

describe("detectors", () => {
  it("calls a softlock only after several different real controls changed nothing", () => {
    const d = new SoftlockDetector(3);
    assert.equal(d.observe(false, "s1", 1, "a", false), null);
    assert.equal(d.observe(false, "s1", 2, "a", false), null, "the same control twice is one try");
    assert.equal(d.observe(false, "s1", 3, "b", false), null);
    assert.equal(d.observe(false, "s1", 4, "c", false)?.severity, "high");
    assert.equal(d.observe(false, "s1", 5, "d", false), null, "reported once");
    assert.equal(d.observe(true, "s2", 6, "e", false), null, "a visible change resets it");
  });

  it("needs every grid cell tried before blind taps count, and then only as medium", () => {
    const d = new SoftlockDetector(3, 4);
    for (const cell of ["g1", "g2", "g3"]) assert.equal(d.observe(false, "s", 1, cell, true), null);
    const f = d.observe(false, "s", 2, "g4", true);
    assert.equal(f?.kind, "softlock");
    assert.equal(f?.severity, "medium");
  });

  it("flags a blank screen only when it persists, and big memory growth", () => {
    const b = new BlankScreenDetector();
    assert.equal(b.observe(true, 0), null);
    assert.equal(b.observe(true, 1)?.kind, "blank_screen");
    assert.equal(memoryGrowth([300_000, 320_000, 330_000], 9), null);
    assert.equal(memoryGrowth([300_000, 400_000, 600_000], 9)?.kind, "memory_growth");
  });
});

describe("scenario", () => {
  it("rejects typos loudly", () => {
    assert.throws(() => parseScenario({ name: "x", app: "a", maxStep: 3 }), /unknown scenario field\(s\): maxStep/);
    assert.throws(() => parseScenario({ name: "x", app: "a", customOptions: [{ name: "m", actions: [{ kind: "tapp" }] }] }), ScenarioError);
    assert.throws(() => parseScenario({ name: "x", app: "a", customOptions: [{ name: "m", actions: [{ kind: "tap", at: { x: 1 } }] }] }), /numeric x and y/);
    assert.throws(() => parseScenario({ name: "x", app: "a", mode: "scripted" }), /script/);
    assert.throws(() => parseScenario({ name: "x", app: "a", appEventUrl: "game://x" }), /\{event\}/);
  });

  it("resolves the slim profile against the scenario folder and applies safe defaults", () => {
    const s = parseScenario({ name: "x", app: "a", slim: { profile: "slim.json" } }, "/games/mine/playpilot");
    assert.equal(s.slim?.profile, "/games/mine/playpilot/slim.json");
    const old = parseScenario({ name: "x", app: "a", simslim: { profile: "slim.json" } }, "/games/mine/playpilot");
    assert.equal(old.slim?.profile, "/games/mine/playpilot/slim.json", "the old key still works");
    assert.throws(() => parseScenario({ name: "x", app: "a", slim: {}, simslim: {} }), /"slim" only/);
    const moved = absolutize({ name: "x", app: "a", slim: { profile: "slim.json" } }, "/games/mine/playpilot") as { slim: { profile: string } };
    assert.equal(moved.slim.profile, "/games/mine/playpilot/slim.json");
    assert.equal(s.maxSteps, 30);
    assert.ok(s.avoid.some((r) => r.test("Buy 500 Coins")));
    assert.equal(parseScenario({ name: "x", app: "a", allowRisky: true }).avoid.length, 0);
  });
});

const noMemory: MemoryView = { timesTried: () => 0, alwaysFailed: () => false, timesChanged: () => 0 };

function obs(partial: Partial<Observation>): Observation {
  return { t: 0, nodes: [], viewport: { width: 400, height: 200 }, frameHash: null, blank: false, probe: null, ...partial };
}

describe("options and deciders", () => {
  const scenario = parseScenario({ name: "x", app: "a" });

  it("lists controls, drops containers, and falls back to a grid only on a bare canvas", () => {
    const options = deriveOptions(
      scenario,
      obs({
        nodes: [
          { ref: "@e2", type: "Other", label: "Toolbar", identifier: "", rect: { x: 0, y: 0, width: 400, height: 200 } },
          { ref: "@e3", type: "Button", label: "Play", identifier: "", rect: { x: 1, y: 1, width: 50, height: 20 } },
          { ref: "@e4", type: "Button", label: "Play", identifier: "", rect: { x: 1, y: 40, width: 50, height: 20 } },
        ],
      }),
    );
    assert.deepEqual(
      options.map((o) => o.name),
      ["button:Play", "button:Play #2"],
    );
    const canvas = deriveOptions(scenario, obs({}));
    assert.equal(canvas.length, 12);
    assert.ok(canvas.every((o) => o.source === "grid"));
  });

  it("turns probe targets into taps in points and probe actions into game options", () => {
    const options = deriveOptions(
      scenario,
      obs({
        probe: {
          seq: 1,
          scene: "Match",
          screen: "",
          busy: false,
          facts: {},
          targets: [{ id: "p", label: "Pause", kind: "button", x: 0.5, y: 0.25, w: 0.1, h: 0.1 }],
          actions: [{ id: "round", description: "Play a round" }],
          ack: null,
        },
      }),
    );
    assert.deepEqual(options[0]?.actions, [{ kind: "tap", at: { x: 200, y: 50 } }]);
    assert.equal(options[1]?.name, "game:round");
    assert.equal(options.length, 2, "no grid when the probe offers targets");
  });

  it("flags purchases as risky", () => {
    const buy: GameOption = { name: "button:Buy 500 Coins", description: "", actions: [], source: "a11y" };
    assert.equal(isRisky(scenario, buy), true);
    assert.equal(isRisky(scenario, { ...buy, name: "button:Play" }), false);
  });

  it("explores the untried first, prefers real targets to grid taps, and skips options that always failed", () => {
    const grid: GameOption = { name: "grid:r1c1", description: "", actions: [], source: "grid" };
    const play: GameOption = { name: "button:Play", description: "", actions: [], source: "a11y" };
    const broken: GameOption = { name: "button:Broken", description: "", actions: [], source: "a11y" };
    const d = new ExploreDecider(7);
    assert.equal(d.choose("s", [grid, play], noMemory)?.name, "button:Play");
    const memory: MemoryView = { timesTried: (_s, o) => (o === "button:Play" ? 2 : o === "button:Broken" ? 1 : 0), alwaysFailed: (_s, o) => o === "button:Broken", timesChanged: () => 0 };
    assert.equal(d.choose("s", [play, broken, grid], memory)?.name, "grid:r1c1");
    const fine: GameOption = { name: "fine:r1c1", description: "", actions: [], source: "fine" };
    const triedGrid: MemoryView = { ...noMemory, timesTried: (_s, o) => (o === "grid:r1c1" ? 1 : 0) };
    assert.equal(d.choose("s", [grid, fine], triedGrid)?.name, "fine:r1c1", "untried fine cells beat a tried coarse one");
  });

  it("follows a script by exact name, then by substring", () => {
    const d = new ScriptedDecider(["Play", "grid:r3c4"]);
    const options: GameOption[] = [
      { name: "button:Play", description: "", actions: [], source: "a11y" },
      { name: "grid:r3c4", description: "", actions: [], source: "grid" },
    ];
    assert.equal(d.choose("s", options)?.name, "button:Play");
    assert.equal(d.choose("s", options)?.name, "grid:r3c4");
    assert.equal(d.remaining.length, 0);
  });
});

describe("structural screen keys", () => {
  it("masks digits so a ticking score is the same screen", () => {
    const node = (label: string) => ({ ref: "@e2", type: "StaticText", label, identifier: "", rect: null });
    assert.equal(structuralKey([node("Score 10")], null), structuralKey([node("Score 250")], null));
    assert.equal(structuralKey([], null), null);
  });
});

describe("doctor", () => {
  it("warns about a second agent-device install and fails on a stuck daemon", async () => {
    const exec: Exec = async (command, args) => {
      if (command === "which") return { code: 0, stdout: "/a/agent-device\n/b/agent-device\n", stderr: "" };
      if (command === "/a/agent-device") return { code: 0, stdout: "0.21.35\n", stderr: "" };
      if (command === "/b/agent-device") return { code: 0, stdout: "0.20.10\n", stderr: "" };
      if (command === "agent-device" && args[0] === "session") {
        return { code: 1, stdout: JSON.stringify({ success: false, error: { message: "Daemon registration ownership could not be verified." } }), stderr: "" };
      }
      if (command === "df") return { code: 0, stdout: "Filesystem 1K-blocks Used Available\n/dev/x 100 50 99999999\n", stderr: "" };
      return { code: 127, stdout: "", stderr: "" };
    };
    const checks = await doctor(exec);
    const byName = new Map(checks.map((c) => [c.name, c]));
    assert.equal(byName.get("agent-device installs")?.level, "warn");
    assert.match(byName.get("agent-device installs")?.fix ?? "", /\/b\/agent-device daemon stop/);
    assert.equal(byName.get("agent-device daemon")?.level, "fail");
  });
});

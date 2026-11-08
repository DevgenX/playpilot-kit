import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main, type Io } from "../src/cli.js";
import { decodePng } from "../src/harness/image.js";
import { loadReplay } from "../src/replay.js";
import type { RunReport } from "../src/report.js";
import { runReplay, runScenario } from "../src/runner.js";
import { crashDirOf, fakeGame, UDID, VIEW } from "./fakeGame.js";

async function workspace(): Promise<{ root: string; out: string; memoryDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "playpilot-test-"));
  return { root, out: join(root, "run"), memoryDir: join(root, "memory") };
}

const base = { name: "fake", app: "com.example.fake", maxSteps: 25, settleMs: 0, launchWaitMs: 0, memoryEvery: 5 };

describe("autonomous runs against the fake game", () => {
  it("explores, never buys, finds the crash with evidence, and writes a complete run folder", async () => {
    const { root, out, memoryDir } = await workspace();
    const game = fakeGame({ root });
    const report = await runScenario({ ...base, seed: 3, device: { udid: UDID }, simslim: { requires: [] } }, root, {
      exec: game.exec,
      outDir: out,
      memoryDir,
      sleep: async () => undefined,
      crashReportDir: crashDirOf(root),
    });

    assert.equal(game.purchases, 0, "the explorer must never press a purchase button");
    assert.ok(report.steps.length > 3, `only ${report.steps.length} steps`);
    assert.ok(report.screens.thisRun >= 2);
    const crash = report.findings.find((f) => f.kind === "crash");
    if (crash) {
      assert.equal(report.outcome, "not_achieved");
      assert.equal(report.note, "the game crashed");
      assert.ok(report.findings.some((f) => f.kind === "crash" && typeof f.evidence["report"] === "string"), "the OS crash report is attached");
    } else {
      assert.equal(report.outcome, "explored");
    }
    assert.ok(!report.findings.some((f) => f.kind === "error_log" && /xctest|error: \(null\)/.test(f.message)), "test-runner noise is not a finding");
    assert.equal(report.simulator.footprintMb, 900);

    const files = await readdir(out);
    for (const f of ["report.md", "report.json", "steps.json", "replay.ad", "scenario.json", "run.mp4", "contact-sheet.png", "frames"]) assert.ok(files.includes(f), `missing ${f}`);
    const firstFrame = decodePng(await readFile(join(out, "frames", "step-000.png")));
    assert.deepEqual([firstFrame.width, firstFrame.height], [VIEW.width, VIEW.height], "retina frames are shrunk to points");
    const md = await readFile(join(out, "report.md"), "utf8");
    assert.match(md, /# Playtest: fake/);
    const ad = await readFile(join(out, "replay.ad"), "utf8");
    assert.match(ad, /^open "com\.example\.fake" --relaunch$/m);
    assert.ok(!/@e\d/.test(ad), "replay scripts never contain snapshot refs");
  });

  it("reaches a canvas-only level and wins it with a scripted grid tap", async () => {
    const { root, out, memoryDir } = await workspace();
    const game = fakeGame({ root });
    const report = await runScenario(
      { ...base, mode: "scripted", script: ["Play", "grid:r3c4"], success: { label: "Well done!" }, video: false },
      root,
      { exec: game.exec, outDir: out, memoryDir, sleep: async () => undefined, crashReportDir: crashDirOf(root) },
    );
    assert.equal(report.outcome, "achieved");
    assert.equal(report.note, 'saw "Well done!"');
    assert.deepEqual(
      report.steps.map((s) => [s.option, s.changed]),
      [
        ["button:Play", true],
        ["grid:r3c4", true],
      ],
    );
    assert.equal(report.findings.length, 0, JSON.stringify(report.findings));
  });

  it("reports a missing scripted step instead of tapping something else", async () => {
    const { root, out, memoryDir } = await workspace();
    const game = fakeGame({ root });
    let clock = 0;
    const report = await runScenario({ ...base, mode: "scripted", script: ["Leaderboard"], video: false }, root, {
      exec: game.exec,
      outDir: out,
      memoryDir,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    assert.equal(report.outcome, "not_achieved");
    assert.match(report.note, /"Leaderboard" was not on screen/);
    assert.equal(report.steps.length, 0);
  });

  it("remembers screens between runs, so the second run starts from what the first one tried", async () => {
    const { root, memoryDir } = await workspace();
    const run = (out: string): Promise<RunReport> => {
      const game = fakeGame({ root });
      return runScenario({ ...base, maxSteps: 4, seed: 1, video: false }, root, { exec: game.exec, outDir: join(root, out), memoryDir, sleep: async () => undefined, crashReportDir: crashDirOf(root) });
    };
    const first = await run("one");
    const second = await run("two");
    assert.equal(second.memoryRuns, 2);
    assert.ok(second.screens.knownTotal >= first.screens.knownTotal);
    assert.notDeepEqual(
      second.steps.map((s) => s.option),
      first.steps.map((s) => s.option),
      "the second run should not repeat the first run's choices",
    );
  });

  it("fails cleanly when simslim cannot slim a simulator it was not given", async () => {
    const { root, out, memoryDir } = await workspace();
    const game = fakeGame({ root });
    const report = await runScenario({ ...base, simslim: {} }, root, { exec: game.exec, outDir: out, memoryDir });
    assert.equal(report.outcome, "error");
    assert.match(report.note, /--udid/);
  });
});

describe("game probe", () => {
  it("uses probe targets and actions, and surfaces engine exceptions", async () => {
    const { root, out, memoryDir } = await workspace();
    const game = fakeGame({ root, probe: true });
    const report = await runScenario(
      { ...base, mode: "scripted", script: ["Play", "game:win"], success: { label: "Well done!" }, video: false },
      root,
      { exec: game.exec, outDir: out, memoryDir, sleep: () => game.tick(), crashReportDir: crashDirOf(root) },
    );
    assert.equal(report.outcome, "achieved", report.note);
    assert.equal(report.probe, true);
    const exception = report.findings.find((f) => f.kind === "exception");
    assert.equal(exception?.message, "NullReferenceException: Confetti.Spawn");
    assert.equal(exception?.severity, "high");
    const steps = (await loadReplay(out)).steps;
    assert.deepEqual(steps[1]?.actions, [{ kind: "game", action: "win", args: {} }]);
    assert.match(await readFile(join(out, "replay.ad"), "utf8"), /# game action "win"/);
  });
});

describe("replay and regressions", () => {
  it("replays a crashing run to the crash, and a promoted fix-check passes on a fixed build", async () => {
    const { root, memoryDir } = await workspace();
    const runDir = join(root, "crashrun");
    const game = fakeGame({ root });
    const original = await runScenario({ ...base, mode: "scripted", script: ["Play", "grid:r1c1"], video: false }, root, {
      exec: game.exec,
      outDir: runDir,
      memoryDir,
      sleep: async () => undefined,
      crashReportDir: crashDirOf(root),
    });
    assert.equal(original.outcome, "not_achieved");

    const replayed = await runReplay(await loadReplay(runDir), root, {
      exec: fakeGame({ root }).exec,
      outDir: join(root, "replay"),
      memoryDir,
      sleep: async () => undefined,
      crashReportDir: crashDirOf(root),
    });
    assert.equal(replayed.outcome, "not_achieved");
    assert.ok(replayed.findings.some((f) => f.kind === "crash"));
    assert.equal(replayed.steps[0]?.option, "button:Play");
  });
});

describe("cli", () => {
  function capture(): Io & { text: string[] } {
    const text: string[] = [];
    return { text, out: (t) => text.push(t), err: (t) => text.push(t) };
  }

  it("drives an agent session one command per step, across processes", async () => {
    const { root } = await workspace();
    const game = fakeGame({ root });
    const scenarioPath = join(root, "scenario.json");
    await (await import("node:fs/promises")).writeFile(scenarioPath, JSON.stringify({ ...base, video: false }));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const io = capture();
      assert.equal(await main(["agent", "start", scenarioPath, "--out", "runs/a"], game.exec, io), 0, io.text.join("\n"));
      const start = io.text.join("\n");
      assert.match(start, /step 0 \| screen s1 \(new\)/);
      assert.match(start, /1\. button:Play \[a11y\]/);
      assert.match(start, /button:Buy 500 Coins \[a11y, RISKY: avoid unless asked\]/);

      const act = capture();
      assert.equal(await main(["agent", "act", "1"], game.exec, act), 0, act.text.join("\n"));
      assert.match(act.text.join("\n"), /no accessible or probe targets: look at the frame/);
      assert.match(act.text.join("\n"), /1-12\. grid:r<row>c<col> blind taps/);

      const tap = capture();
      assert.equal(await main(["agent", "act", "--tap", "300,150"], game.exec, tap), 0, tap.text.join("\n"));
      assert.match(tap.text.join("\n"), /button:Home/);

      const note = capture();
      assert.equal(await main(["agent", "note", "The", "win", "banner", "text", "is", "cut", "off", "--severity", "low", "--step", "1"], game.exec, note), 0);
      const finish = capture();
      assert.equal(await main(["agent", "finish", "--outcome", "achieved", "--summary", "Won the first level."], game.exec, finish), 0);
      const report = JSON.parse(await readFile(join(root, "runs/a/report.json"), "utf8")) as RunReport;
      assert.equal(report.outcome, "achieved");
      assert.equal(report.summary, "Won the first level.");
      assert.deepEqual(
        report.steps.map((s) => s.option),
        ["button:Play", "tap 300,150"],
      );
      const agentFinding = report.findings.find((f) => f.kind === "agent");
      assert.equal(agentFinding?.severity, "low");
      assert.equal(agentFinding?.step, 1);
      assert.equal(agentFinding?.frame, "step-002.png", "the frame after the step shows its result");
      assert.equal(report.mode, "agent");

      const again = capture();
      assert.equal(await main(["agent", "observe"], game.exec, again), 2, "a finished session cannot be resumed");
    } finally {
      process.chdir(cwd);
    }
  });

  it("plans a run without a device, and rejects bad flags with exit 2", async () => {
    const { root } = await workspace();
    const scenarioPath = join(root, "scenario.json");
    await (await import("node:fs/promises")).writeFile(scenarioPath, JSON.stringify({ ...base, maxSteps: 1 }));
    const io = capture();
    assert.equal(await main(["plan", scenarioPath], async () => ({ code: 1, stdout: "", stderr: "" }), io), 0);
    assert.ok(io.text.some((l) => l.startsWith("agent-device open com.example.fake --platform ios")), io.text.join("\n"));
    assert.equal(await main(["run", scenarioPath, "--fail-on", "sometimes"], async () => ({ code: 0, stdout: "", stderr: "" }), capture()), 2);
    assert.equal(await main(["promote", root], async () => ({ code: 0, stdout: "", stderr: "" }), capture()), 2);
  });
});

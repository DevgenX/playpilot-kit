import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExploreDecider, ScriptedDecider } from "./harness/deciders.js";
import { isRisky } from "./harness/options.js";
import type { Decider } from "./harness/types.js";
import { Playtest, type PlaytestDeps } from "./playtest.js";
import { renderReport, type RunReport } from "./report.js";
import type { ReplayFile } from "./replay.js";
import { parseScenario } from "./scenario.js";

/** How long a scripted step may take to appear (loading screens, transitions) before the run gives up. */
const SCRIPT_WAIT_MS = 8_000;

/**
 * Plays a scenario without a model: the seeded explorer or a fixed script picks each option. Free, offline and
 * reproducible, which makes it the right tool for nightly runs and CI. Agents drive runs with `playpilot agent`.
 */
export async function runScenario(rawScenario: unknown, scenarioDir: string, deps: PlaytestDeps): Promise<RunReport> {
  const scenario = parseScenario(rawScenario, scenarioDir);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let playtest: Playtest;
  try {
    playtest = await Playtest.start(rawScenario, scenarioDir, deps);
  } catch (error: unknown) {
    return errorReport(deps.outDir, scenario.name, scenario.app, scenario.mode, scenario.goal, error);
  }
  const scripted = scenario.mode === "scripted" ? new ScriptedDecider(scenario.script) : null;
  const decider: Decider = scripted ?? new ExploreDecider(scenario.seed);
  try {
    for (;;) {
      let view = await playtest.observe();
      if (view.done) return await playtest.finish(view.done.outcome, view.done.note);
      if (scripted && scripted.remaining.length === 0) return await playtest.finish("achieved", "script finished");
      const pick = (): ReturnType<Decider["choose"]> => {
        const options = scripted ? playtest.options : playtest.options.filter((o) => !isRisky(scenario, o));
        return decider.choose(view.screen.id, options, playtest.memoryView);
      };
      let choice = pick();
      const waitUntil = now() + SCRIPT_WAIT_MS;
      while (choice === null && scripted && now() < waitUntil) {
        await sleep(1_000);
        view = await playtest.observe();
        if (view.done) return await playtest.finish(view.done.outcome, view.done.note);
        choice = pick();
      }
      if (choice === null) {
        return scripted
          ? await playtest.finish("not_achieved", `script step "${scripted.remaining[0] ?? "?"}" was not on screen`)
          : await playtest.finish("explored", "no options left on this screen");
      }
      await playtest.act(choice);
    }
  } catch (error: unknown) {
    return playtest.finish("error", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Replays recorded inputs with every detector on, so a replay shows whether a bug still happens. The run stops
 * early only on a crash.
 */
export async function runReplay(replay: ReplayFile, scenarioDir: string, deps: PlaytestDeps): Promise<RunReport> {
  const scenario = parseScenario(replay.scenario, scenarioDir);
  let playtest: Playtest;
  try {
    playtest = await Playtest.start(replay.scenario, scenarioDir, deps);
  } catch (error: unknown) {
    return errorReport(deps.outDir, scenario.name, scenario.app, "replay", scenario.goal, error);
  }
  try {
    for (const step of replay.steps) {
      const view = await playtest.observe();
      if (view.done?.note === "the game crashed") return await playtest.finish("not_achieved", `the game crashed before step ${step.step}`);
      await playtest.act({ name: step.option, description: step.option, actions: step.actions, source: "custom" });
    }
    const last = await playtest.observe();
    const crashed = last.done?.note === "the game crashed";
    return await playtest.finish(crashed ? "not_achieved" : "achieved", crashed ? "the game crashed" : `replayed ${replay.steps.length} step(s)`);
  } catch (error: unknown) {
    return playtest.finish("error", error instanceof Error ? error.message : String(error));
  }
}

async function errorReport(outDir: string, name: string, app: string, mode: string, goal: string, error: unknown): Promise<RunReport> {
  const note = error instanceof Error ? error.message : String(error);
  const report: RunReport = {
    scenario: name,
    app,
    mode,
    goal,
    outcome: "error",
    note,
    summary: "",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    device: { id: null, name: null },
    steps: [],
    findings: [],
    screens: { thisRun: 0, new: 0, knownTotal: 0 },
    coverage: { optionsSeen: 0, optionsTried: 0 },
    memoryRuns: 0,
    memoryMb: [],
    probe: false,
    simulator: { profile: null, repaired: false, footprintMb: null },
    artifacts: { frames: "frames/", video: null, contactSheet: null, steps: "steps.json", replayScript: "replay.ad" },
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "report.md"), renderReport(report), "utf8");
  return report;
}

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseAction, type Scenario, ScenarioError } from "./scenario.js";
import type { ReplayStep } from "./playtest.js";

/**
 * Replays come in two forms. `steps.json` (PlayPilot's own) replays every input including game-probe actions,
 * and runs all detectors again, so a replay can prove a bug still happens or is fixed. `replay.ad` is the same
 * run as an agent-device script, for teams that already run `agent-device test` or Maestro.
 */

export interface ReplayFile {
  readonly version: 1;
  /** The scenario exactly as the run used it. */
  readonly scenario: unknown;
  readonly steps: readonly ReplayStep[];
}

/** Reads a run folder (its steps.json) or a promoted regression file. */
export async function loadReplay(path: string): Promise<ReplayFile> {
  let file = path;
  try {
    if ((await stat(path)).isDirectory()) file = join(path, "steps.json");
  } catch {
    throw new ScenarioError(`cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new ScenarioError(`cannot read replay ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const r = raw as Partial<ReplayFile> | null;
  if (r === null || typeof r !== "object" || r.version !== 1 || !Array.isArray(r.steps) || r.scenario === undefined) {
    throw new ScenarioError(`${file} is not a PlayPilot replay (version 1 with scenario and steps)`);
  }
  const steps = (r.steps as unknown[]).map((item, i): ReplayStep => {
    const s = (item ?? {}) as { step?: unknown; option?: unknown; actions?: unknown };
    if (typeof s.option !== "string" || !Array.isArray(s.actions)) throw new ScenarioError(`${file}: steps[${i}] needs option and actions`);
    const actions = s.actions.map((a: unknown, j: number) => parseAction(a, `steps[${i}].actions[${j}]`));
    if (actions.some((a) => "ref" in a)) throw new ScenarioError(`${file}: steps[${i}] uses a snapshot ref; replays need selectors or points`);
    return { step: typeof s.step === "number" ? s.step : i, option: s.option, actions: actions as ReplayStep["actions"] };
  });
  return { version: 1, scenario: r.scenario, steps };
}

/** The first `toStep + 1` steps (steps 0..toStep), for reproducing one finding or promoting a regression. */
export function trim(replay: ReplayFile, toStep?: number): ReplayFile {
  return toStep === undefined ? replay : { ...replay, steps: replay.steps.filter((s) => s.step <= toStep) };
}

const q = (text: string): string => JSON.stringify(text);
const n = (value: number): string => String(Math.round(value));

/** The run as an agent-device `.ad` script. Game-probe actions become comments: agent-device cannot send them. */
export function replayScript(scenario: Scenario, steps: readonly ReplayStep[]): string {
  const lines = [`# PlayPilot run "${scenario.name}" as an agent-device script (agent-device replay <file>)`, `context platform=${scenario.platform}`, `open ${q(scenario.app)} --relaunch`];
  for (const step of steps) {
    lines.push(`# step ${step.step}: ${step.option.replace(/\n/g, " ")}`);
    for (const a of step.actions) {
      switch (a.kind) {
        case "press":
          lines.push(`press ${q(a.selector)}`);
          break;
        case "tap":
          lines.push(`press ${n(a.at.x)} ${n(a.at.y)}${a.count && a.count > 1 ? ` --count ${a.count}` : ""}${a.holdMs !== undefined ? ` --hold-ms ${a.holdMs}` : ""}`);
          break;
        case "longpress":
          lines.push(`longpress ${n(a.at.x)} ${n(a.at.y)} ${a.ms}`);
          break;
        case "pan":
          lines.push(`gesture pan ${n(a.from.x)} ${n(a.from.y)} ${n(a.dx)} ${n(a.dy)} ${a.ms}`);
          break;
        case "fill":
          lines.push(`fill ${q(a.selector)} ${q(a.text)}`);
          break;
        case "type":
          lines.push(`type ${q(a.text)}`);
          break;
        case "back":
          lines.push("back");
          break;
        case "wait":
          if (a.ms > 0) lines.push(`wait ${a.ms}`);
          break;
        case "appEvent":
          lines.push(`trigger-app-event ${q(a.event)} ${q(JSON.stringify(a.payload))}`);
          break;
        case "game":
          lines.push(`# game action ${q(a.action)} ${JSON.stringify(a.args)} (needs the probe: use playpilot replay)`);
          break;
      }
    }
    if (scenario.settleMs > 0) lines.push(`wait ${scenario.settleMs}`);
  }
  lines.push("close", "");
  return lines.join("\n");
}

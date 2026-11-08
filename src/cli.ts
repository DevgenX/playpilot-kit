#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Simslim } from "./adapters/simslim.js";
import { doctor } from "./doctor.js";
import { formatCommand, recordingExec, spawnExec, type Exec, type PlannedCommand } from "./exec.js";
import type { DeviceAction, GameOption, Severity } from "./harness/types.js";
import { SEVERITY_ORDER } from "./harness/types.js";
import { init } from "./init.js";
import { Playtest, type ObservationView, type PlaytestDeps } from "./playtest.js";
import { loadReplay, trim } from "./replay.js";
import { failsAt, sortFindings, type RunReport } from "./report.js";
import { runReplay, runScenario } from "./runner.js";
import { ScenarioError } from "./scenario.js";

export const VERSION = "0.2.0";

const HELP = `playpilot ${VERSION}: agent playtesting for mobile games

Setup
  playpilot doctor [--json]                     check agent-device, Xcode, simslim, adb, disk
  playpilot init [--app <bundle-id>] [--dir playpilot] [--force]
                                                write starter scenarios into this repo
  playpilot sim prepare|verify|measure <udid> [--profile <file>]
                                                slim a simulator (simslim), check drift, or measure it

Autonomous runs (no model; free, seeded, good for CI)
  playpilot run <scenario.json> [--out <dir>] [--udid <udid>] [--seed <n>] [--steps <n>] [--fail-on <severity>]
  playpilot plan <scenario.json>                print the device commands a run starts with (no device)

Agent-driven runs (an agent picks each step; one command per step)
  playpilot agent start <scenario.json> [--out <dir>] [--udid <udid>]
  playpilot agent act <option-id|name>          or one of:
        --tap x,y   --hold x,y,ms   --swipe x,y,dx,dy[,ms]   --type <text>   --back   --wait <ms>
        --game <action> [--args <json>]
  playpilot agent observe                       look again without acting
  playpilot agent note <text> [--severity critical|high|medium|low|info] [--step <n>]
  playpilot agent finish [--outcome achieved|not_achieved|explored] [--summary <text>]
  (agent commands take --session <run-dir>; default: the last session started here; add --json for JSON)

Reproduce and guard
  playpilot replay <run-dir|regression.json> [--to-step <n>] [--out <dir>] [--udid <udid>]
  playpilot promote <run-dir> --to-step <n> --out <regression.json>
  playpilot regress <dir|file.json>... [--udid <udid>] [--fail-on <severity>]

Shared flags: --memory <dir> (default .playpilot/memory). Exit codes: 0 pass, 1 findings at or above
--fail-on (default high) or a missed goal, 2 usage error.
`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const consoleIo: Io = { out: (t) => process.stdout.write(t + "\n"), err: (t) => process.stderr.write(t + "\n") };

class UsageError extends Error {
  override readonly name = "UsageError";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function intFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`${name} must be a whole number`);
  return value;
}

function severityFlag(args: string[]): Severity {
  const raw = flag(args, "--fail-on") ?? "high";
  if (!(SEVERITY_ORDER as readonly string[]).includes(raw)) throw new UsageError(`--fail-on must be one of ${SEVERITY_ORDER.join(", ")}`);
  return raw as Severity;
}

function numbers(raw: string, count: number[], name: string): number[] {
  const values = raw.split(",").map((v) => Number(v.trim()));
  if (!count.includes(values.length) || values.some((v) => !Number.isFinite(v))) throw new UsageError(`${name} needs ${count.join(" or ")} comma-separated numbers`);
  return values;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new ScenarioError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Applies command-line overrides to a raw scenario before it is validated. */
function override(raw: unknown, args: string[]): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  const udid = flag(args, "--udid");
  if (udid !== undefined) copy["device"] = { ...((copy["device"] as Record<string, unknown> | undefined) ?? {}), udid };
  const seed = intFlag(args, "--seed");
  if (seed !== undefined) copy["seed"] = seed;
  const steps = intFlag(args, "--steps");
  if (steps !== undefined) copy["maxSteps"] = steps;
  return copy;
}

function summaryLine(report: RunReport, out: string): string {
  const worst = sortFindings(report.findings)
    .slice(0, 3)
    .map((f) => `${f.severity} ${f.kind}`)
    .join(", ");
  return `${report.outcome}: ${report.note} | ${report.findings.length} finding(s)${worst ? ` (${worst})` : ""} | ${join(out, "report.md")}`;
}

function exitFor(report: RunReport, failOn: Severity): number {
  return report.outcome === "error" || report.outcome === "not_achieved" || failsAt(report.findings, failOn) ? 1 : 0;
}

/** The observation as an agent reads it: compact text, one option per line. */
export function renderObservation(v: ObservationView): string {
  const where = [v.screen.scene ? `scene=${v.screen.scene}` : "", v.screen.name ? `screen=${v.screen.name}` : ""].filter(Boolean).join(" ");
  const lines = [
    `step ${v.step} | screen ${v.screen.id}${v.screen.isNew ? " (new)" : ` (visit ${v.screen.visits})`}${where ? ` ${where}` : ""}`,
    `frame ${v.frame} (${v.viewport.width}x${v.viewport.height} points; frame pixels are tap coordinates)`,
  ];
  const facts = Object.entries(v.facts);
  if (facts.length > 0) lines.push(`facts ${facts.map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(" ")}`);
  if (v.newFindings.length > 0) {
    lines.push("new findings:");
    for (const f of v.newFindings) lines.push(`  ! ${f.severity} ${f.kind}: ${f.message}`);
  }
  if (v.done) {
    lines.push(`done: ${v.done.outcome} (${v.done.note}). Run: playpilot agent finish --outcome ${v.done.outcome}`);
    return lines.join("\n");
  }
  lines.push("options:");
  const grid = v.options.filter((o) => o.source === "grid");
  for (const o of v.options) {
    if (o.source === "grid") continue;
    const extra = [o.source, o.tried > 0 ? `tried ${o.tried}x` : "", o.risky ? "RISKY: avoid unless asked" : ""].filter(Boolean).join(", ");
    lines.push(`  ${o.id}. ${o.name}${o.source === "game" || o.source === "custom" ? ` - ${o.description}` : ""} [${extra}]`);
  }
  if (grid.length > 0) {
    const first = grid[0]?.id ?? 0;
    lines.push(`  ${first}-${first + grid.length - 1}. grid:r<row>c<col> blind taps across the screen [grid]`);
  }
  if (!v.options.some((o) => o.source === "a11y" || o.source === "probe")) {
    lines.push("  (no accessible or probe targets: look at the frame and use --tap x,y where you see a control)");
  }
  return lines.join("\n");
}

/** Builds a one-off option from act flags (--tap, --swipe ...). */
function rawOption(args: string[]): GameOption | null {
  const tap = flag(args, "--tap");
  const hold = flag(args, "--hold");
  const swipe = flag(args, "--swipe");
  const type = flag(args, "--type");
  const wait = intFlag(args, "--wait");
  const game = flag(args, "--game");
  const back = bool(args, "--back");
  const gameArgs = flag(args, "--args");
  let action: DeviceAction | null = null;
  let name = "";
  if (tap !== undefined) {
    const [x = 0, y = 0] = numbers(tap, [2], "--tap");
    action = { kind: "tap", at: { x, y } };
    name = `tap ${x},${y}`;
  } else if (hold !== undefined) {
    const [x = 0, y = 0, ms = 800] = numbers(hold, [3], "--hold");
    action = { kind: "longpress", at: { x, y }, ms };
    name = `hold ${x},${y} ${ms}ms`;
  } else if (swipe !== undefined) {
    const [x = 0, y = 0, dx = 0, dy = 0, ms = 300] = numbers(swipe, [4, 5], "--swipe");
    action = { kind: "pan", from: { x, y }, dx, dy, ms };
    name = `swipe ${x},${y} by ${dx},${dy}`;
  } else if (type !== undefined) {
    action = { kind: "type", text: type };
    name = "type text";
  } else if (wait !== undefined) {
    action = { kind: "wait", ms: wait };
    name = `wait ${wait}ms`;
  } else if (back) {
    action = { kind: "back" };
    name = "back";
  } else if (game !== undefined) {
    let parsed: Record<string, unknown> = {};
    if (gameArgs !== undefined) {
      const value = JSON.parse(gameArgs) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError("--args must be a JSON object");
      parsed = value as Record<string, unknown>;
    }
    action = { kind: "game", action: game, args: parsed };
    name = `game:${game}`;
  }
  return action ? { name, description: name, actions: [action], source: "custom" } : null;
}

async function sessionDir(args: string[]): Promise<string> {
  const explicit = flag(args, "--session");
  if (explicit !== undefined) return resolve(explicit);
  try {
    return (await readFile(resolve(".playpilot", "current-session"), "utf8")).trim();
  } catch {
    throw new UsageError("no current session: start one with playpilot agent start <scenario.json>, or pass --session <run-dir>");
  }
}

async function agent(args: string[], exec: Exec, io: Io, memoryDir: string): Promise<number> {
  const sub = args.shift();
  const json = bool(args, "--json");
  const show = (v: ObservationView): void => io.out(json ? JSON.stringify(v) : renderObservation(v));
  if (sub === "start") {
    const out = resolve(flag(args, "--out") ?? join("runs", `agent-${stamp()}`));
    const file = args.shift();
    if (!file) throw new UsageError("agent start needs a scenario file");
    const raw = override(await readJson(file), args);
    const deps: PlaytestDeps = { exec, outDir: out, memoryDir };
    const playtest = await Playtest.start(raw, dirname(resolve(file)), deps, true);
    await mkdir(resolve(".playpilot"), { recursive: true });
    await writeFile(resolve(".playpilot", "current-session"), out + "\n", "utf8");
    io.out(`session ${out}`);
    show(await playtest.observe());
    return 0;
  }
  const deps: PlaytestDeps = { exec, outDir: await sessionDir(args), memoryDir };
  const playtest = await Playtest.resume(deps);
  if (playtest.finished) throw new UsageError(`session ${deps.outDir} is finished; start a new one`);
  switch (sub) {
    case "observe":
      show(await playtest.observe());
      return 0;
    case "act": {
      let option = rawOption(args);
      if (option === null) {
        const wanted = args.join(" ").trim();
        if (wanted === "") throw new UsageError("agent act needs an option id or name, or --tap/--swipe/--hold/--type/--wait/--back/--game");
        const options = playtest.options;
        const byId = /^\d+$/.test(wanted) ? options[Number(wanted) - 1] : undefined;
        option = byId ?? options.find((o) => o.name === wanted) ?? options.find((o) => o.name.toLowerCase().includes(wanted.toLowerCase())) ?? null;
        if (option === null) throw new UsageError(`no option "${wanted}" on this screen (run playpilot agent observe)`);
      }
      const record = await playtest.act(option);
      if (!record.ok) io.out(`step ${record.step} failed: ${record.note ?? ""}`);
      show(await playtest.observe());
      return 0;
    }
    case "note": {
      const severity = flag(args, "--severity") ?? "medium";
      const step = intFlag(args, "--step");
      if (!(SEVERITY_ORDER as readonly string[]).includes(severity)) throw new UsageError(`--severity must be one of ${SEVERITY_ORDER.join(", ")}`);
      const text = args.join(" ").trim();
      if (text === "") throw new UsageError("agent note needs the finding text");
      const f = await playtest.note(text, severity as Severity, step);
      io.out(`noted ${f.severity} finding at step ${f.step}`);
      return 0;
    }
    case "finish": {
      const outcome = flag(args, "--outcome") ?? "explored";
      if (!["achieved", "not_achieved", "explored"].includes(outcome)) throw new UsageError("--outcome must be achieved, not_achieved or explored");
      const summary = flag(args, "--summary") ?? "";
      const report = await playtest.finish(outcome as RunReport["outcome"], "finished by the agent", summary);
      io.out(summaryLine(report, deps.outDir));
      return 0;
    }
    default:
      throw new UsageError(`unknown agent command "${sub ?? ""}"`);
  }
}

export async function main(argv: readonly string[], exec: Exec = spawnExec, io: Io = consoleIo): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  try {
    const memoryFlag = flag(args, "--memory");
    const memoryDir = resolve(memoryFlag ?? join(".playpilot", "memory"));
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        io.out(HELP);
        return 0;
      case "--version":
      case "-v":
        io.out(VERSION);
        return 0;
      case "doctor": {
        const json = bool(args, "--json");
        const checks = await doctor(exec);
        if (json) io.out(JSON.stringify(checks));
        else for (const c of checks) io.out(`${c.level.padEnd(4)}  ${c.name}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`);
        return checks.some((c) => c.level === "fail") ? 1 : 0;
      }
      case "init": {
        const app = flag(args, "--app") ?? "com.example.mygame";
        const dir = resolve(flag(args, "--dir") ?? "playpilot");
        const result = await init(dir, app, bool(args, "--force"));
        for (const f of result.written) io.out(`wrote ${f}`);
        for (const f of result.skipped) io.out(`kept  ${f} (exists; --force to overwrite)`);
        io.out(`next: playpilot run ${join(dir, "explore.json")}   (add .playpilot/ and runs/ to .gitignore)`);
        return 0;
      }
      case "sim": {
        const sub = args.shift();
        const profile = flag(args, "--profile");
        const udid = args.shift();
        if (!udid) throw new UsageError("sim needs a simulator udid");
        const simslim = new Simslim(exec);
        if (sub === "prepare") {
          io.out((await simslim.ensure(udid, profile)) ? `slimmed ${udid}` : `${udid} already matches the profile`);
          return 0;
        }
        if (sub === "verify") return (await simslim.verify(udid, profile)) ? 0 : 1;
        if (sub === "measure") {
          io.out(JSON.stringify(await simslim.measure(udid)));
          return 0;
        }
        throw new UsageError(`unknown sim command "${sub ?? ""}"`);
      }
      case "plan":
      case "run": {
        const failOn = severityFlag(args);
        const planOnly = command === "plan";
        const out = resolve(flag(args, "--out") ?? (planOnly ? await mkdtemp(join(tmpdir(), "playpilot-plan-")) : join("runs", stamp())));
        const file = args.shift();
        if (!file) throw new UsageError(`${command} needs a scenario file`);
        const raw = override(await readJson(file), args);
        const planned: PlannedCommand[] = [];
        const deps: PlaytestDeps = {
          exec: planOnly ? recordingExec(planned) : exec,
          outDir: out,
          // a plan must not teach the real memory anything: it saw no game
          memoryDir: planOnly ? await mkdtemp(join(tmpdir(), "playpilot-mem-")) : memoryDir,
          ...(planOnly ? { sleep: async () => undefined } : {}),
        };
        const report = await runScenario(raw, dirname(resolve(file)), deps);
        if (planOnly) {
          for (const c of planned) io.out(formatCommand(c.command, c.args));
          return 0;
        }
        io.out(summaryLine(report, out));
        return exitFor(report, failOn);
      }
      case "replay": {
        const failOn = severityFlag(args);
        const toStep = intFlag(args, "--to-step");
        const out = resolve(flag(args, "--out") ?? join("runs", `replay-${stamp()}`));
        const source = args.shift();
        if (!source) throw new UsageError("replay needs a run folder or a regression file");
        const replay = trim(await loadReplay(source), toStep);
        const report = await runReplay({ ...replay, scenario: override(replay.scenario, args) }, dirname(resolve(source)), { exec, outDir: out, memoryDir });
        io.out(summaryLine(report, out));
        return exitFor(report, failOn);
      }
      case "promote": {
        const toStep = intFlag(args, "--to-step");
        const out = flag(args, "--out");
        const source = args.shift();
        if (!source || out === undefined || toStep === undefined) throw new UsageError("promote needs <run-dir> --to-step <n> --out <file.json>");
        const replay = trim(await loadReplay(source), toStep);
        await mkdir(dirname(resolve(out)), { recursive: true });
        await writeFile(resolve(out), JSON.stringify(replay, null, 2) + "\n", "utf8");
        io.out(`wrote ${resolve(out)} (${replay.steps.length} step(s)); run it with: playpilot regress ${out}`);
        return 0;
      }
      case "regress": {
        const failOn = severityFlag(args);
        const udid = flag(args, "--udid");
        const sources = await expandRegressions(args);
        if (sources.length === 0) throw new UsageError("regress needs regression files or folders holding them");
        let failed = 0;
        for (const source of sources) {
          const replay = await loadReplay(source);
          const out = resolve(join("runs", `regress-${stamp()}-${source.replace(/[^\w-]+/g, "_").slice(-40)}`));
          const report = await runReplay(
            { ...replay, scenario: override(replay.scenario, udid ? ["--udid", udid] : []) },
            dirname(resolve(source)),
            { exec, outDir: out, memoryDir },
          );
          const code = exitFor(report, failOn);
          failed += code;
          io.out(`${code === 0 ? "pass" : "FAIL"}  ${source}  ${summaryLine(report, out)}`);
        }
        io.out(`${sources.length - failed} of ${sources.length} passed`);
        return failed > 0 ? 1 : 0;
      }
      case "agent":
        return await agent(args, exec, io, memoryDir);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\nRun playpilot --help for usage.`);
      return 2;
    }
    if (error instanceof ScenarioError) {
      io.err(error.message);
      return 2;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function expandRegressions(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const info = await stat(p).catch(() => null);
    if (info === null) throw new UsageError(`${p} does not exist`);
    if (info.isDirectory()) {
      for (const name of (await readdir(p)).sort()) if (name.endsWith(".json")) out.push(join(p, name));
    } else {
      out.push(p);
    }
  }
  return out;
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

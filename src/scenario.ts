import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DeviceAction, Point } from "./harness/types.js";
import { CATEGORY_IDS } from "./slim/catalog.js";

/** A playtest request, committed next to the game as JSON. See templates/ and docs/scenarios.md. */
export interface Scenario {
  readonly name: string;
  /** Bundle id (iOS) or package name (Android). */
  readonly app: string;
  readonly platform: "ios" | "android";
  readonly device: { readonly udid?: string; readonly name?: string; readonly serial?: string };
  /** Slim-simulator profile (absolute path, resolved against the scenario file) and the categories the game needs kept on. Scenario key `slim`. */
  readonly slim: { readonly profile?: string; readonly requires: readonly string[] } | null;
  readonly mode: "explore" | "scripted";
  readonly goal: string;
  readonly maxSteps: number;
  readonly maxMinutes: number;
  readonly seed: number;
  readonly script: readonly string[];
  readonly success: { readonly label?: string; readonly screen?: string };
  /** Options whose names match any of these (case-insensitive) are never chosen by the explorer. */
  readonly avoid: readonly RegExp[];
  readonly canvas: { readonly cols: number; readonly rows: number; readonly inset: number } | null;
  readonly customOptions: readonly CustomOption[];
  readonly softlockActions: number;
  readonly slowStepMs: number;
  readonly settleMs: number;
  /** Wait after launch before the first observation (splash and loading screens). */
  readonly launchWaitMs: number;
  readonly video: boolean;
  /** Sample app memory every N steps (0 = never). */
  readonly memoryEvery: number;
  readonly probe: "auto" | "off";
  readonly appEventUrl?: string;
  readonly launchArgs: readonly string[];
  readonly relaunch: boolean;
}

export interface CustomOption {
  readonly name: string;
  readonly description: string;
  readonly when: { readonly label?: string; readonly screen?: string; readonly scene?: string };
  readonly actions: readonly DeviceAction[];
}

/** Purchases, account changes and progress resets: never pressed unless a scenario opts in with allowRisky. */
export const DEFAULT_AVOID: readonly string[] = [
  "\\bbuy\\b",
  "purchase",
  "subscribe",
  "\\bpay\\b",
  "checkout",
  "delete",
  "sign out",
  "log ?out",
  "reset (progress|data|game)",
  "erase",
  "unsubscribe",
];

/** Slim categories a game needs kept on (see `playpilot sim categories`). */
function categoryList(ids: string[], where: string): string[] {
  const unknown = ids.filter((id) => !CATEGORY_IDS.includes(id));
  if (unknown.length > 0) throw new ScenarioError(`${where}: unknown categor(ies) ${unknown.join(", ")} (known: ${CATEGORY_IDS.join(", ")})`);
  return ids;
}

export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
}

export async function loadScenario(path: string): Promise<Scenario> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new ScenarioError(`cannot read scenario ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseScenario(raw, dirname(resolve(path)));
}

const KNOWN_KEYS = new Set([
  "$schema", "name", "app", "platform", "device", "slim", "simslim", "mode", "goal", "maxSteps", "maxMinutes", "seed", "script",
  "success", "avoid", "allowRisky", "canvas", "customOptions", "softlockActions", "slowStepMs", "settleMs", "launchWaitMs", "video",
  "memoryEvery", "probe", "appEventUrl", "launchArgs", "relaunch",
]);

type Raw = Record<string, unknown>;

function obj(value: unknown, where: string): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ScenarioError(`${where} must be an object`);
  return value as Raw;
}

function point(value: unknown, where: string): Point {
  const p = obj(value, where);
  if (typeof p["x"] !== "number" || typeof p["y"] !== "number") throw new ScenarioError(`${where} needs numeric x and y (screen points)`);
  return { x: p["x"], y: p["y"] };
}

function numberField(r: Raw, key: string, where: string): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ScenarioError(`${where}.${key} must be a non-negative number`);
  return v;
}

function stringField(r: Raw, key: string, where: string): string {
  const v = r[key];
  if (typeof v !== "string" || v === "") throw new ScenarioError(`${where}.${key} must be a non-empty string`);
  return v;
}

function targetOf(r: Raw, where: string): { ref: string } | { selector: string } {
  if (typeof r["selector"] === "string" && r["selector"] !== "") return { selector: r["selector"] };
  if (typeof r["ref"] === "string" && r["ref"] !== "") return { ref: r["ref"].startsWith("@") ? r["ref"] : `@${r["ref"]}` };
  throw new ScenarioError(`${where} needs a "selector" (e.g. label="Play") or a "ref"`);
}

/** Validates one action, loudly: a typo in a macro should fail before the device is touched. */
export function parseAction(value: unknown, where: string): DeviceAction {
  const a = obj(value, where);
  switch (a["kind"]) {
    case "press":
      return { kind: "press", ...targetOf(a, where) };
    case "tap": {
      const count = a["count"] === undefined ? undefined : numberField(a, "count", where);
      const holdMs = a["holdMs"] === undefined ? undefined : numberField(a, "holdMs", where);
      return { kind: "tap", at: point(a["at"], `${where}.at`), ...(count !== undefined ? { count } : {}), ...(holdMs !== undefined ? { holdMs } : {}) };
    }
    case "longpress":
      return { kind: "longpress", at: point(a["at"], `${where}.at`), ms: numberField(a, "ms", where) };
    case "pan":
      if (typeof a["dx"] !== "number" || typeof a["dy"] !== "number") throw new ScenarioError(`${where} needs numeric dx and dy`);
      return { kind: "pan", from: point(a["from"], `${where}.from`), dx: a["dx"], dy: a["dy"], ms: a["ms"] === undefined ? 300 : numberField(a, "ms", where) };
    case "fill":
      return { kind: "fill", ...targetOf(a, where), text: typeof a["text"] === "string" ? a["text"] : "" };
    case "type":
      return { kind: "type", text: stringField(a, "text", where) };
    case "back":
      return { kind: "back" };
    case "wait":
      return { kind: "wait", ms: numberField(a, "ms", where) };
    case "appEvent":
      return { kind: "appEvent", event: stringField(a, "event", where), payload: a["payload"] === undefined ? {} : obj(a["payload"], `${where}.payload`) };
    case "game":
      return { kind: "game", action: stringField(a, "action", where), args: a["args"] === undefined ? {} : obj(a["args"], `${where}.args`) };
    default:
      throw new ScenarioError(`${where}.kind must be one of press, tap, longpress, pan, fill, type, back, wait, appEvent, game`);
  }
}

/** A copy of a raw scenario with its relative file paths made absolute, so it still works from a run folder. */
export function absolutize(raw: unknown, baseDir: string): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Raw;
  const key = r["slim"] !== undefined ? "slim" : "simslim";
  const sim = r[key];
  if (sim === null || typeof sim !== "object" || Array.isArray(sim)) return raw;
  const profile = (sim as Raw)["profile"];
  if (typeof profile !== "string" || profile === "" || isAbsolute(profile)) return raw;
  return { ...r, [key]: { ...(sim as Raw), profile: resolve(baseDir, profile) } };
}

export function parseScenario(raw: unknown, baseDir = process.cwd()): Scenario {
  const r = obj(raw, "scenario");
  const unknown = Object.keys(r).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) throw new ScenarioError(`unknown scenario field(s): ${unknown.join(", ")}`);

  const str = (key: string, fallback?: string): string => {
    const v = r[key];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (fallback !== undefined && v === undefined) return fallback;
    throw new ScenarioError(`"${key}" must be a non-empty string`);
  };
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const v = r[key] ?? fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ScenarioError(`"${key}" must be a number between ${min} and ${max}`);
    return v;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = r[key] ?? fallback;
    if (typeof v !== "boolean") throw new ScenarioError(`"${key}" must be true or false`);
    return v;
  };
  const strList = (value: unknown, where: string): string[] => {
    const v = value ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ScenarioError(`${where} must be a list of strings`);
    return v as string[];
  };

  const platform = str("platform", "ios");
  if (platform !== "ios" && platform !== "android") throw new ScenarioError(`"platform" must be ios or android`);
  const mode = str("mode", "explore");
  if (mode !== "explore" && mode !== "scripted") throw new ScenarioError(`"mode" must be explore or scripted`);
  const probe = str("probe", "auto");
  if (probe !== "auto" && probe !== "off") throw new ScenarioError(`"probe" must be auto or off`);

  const deviceRaw = r["device"] === undefined ? {} : obj(r["device"], "device");
  const device: { udid?: string; name?: string; serial?: string } = {};
  for (const key of ["udid", "name", "serial"] as const) {
    const v = deviceRaw[key];
    if (v !== undefined) {
      if (typeof v !== "string" || v === "") throw new ScenarioError(`device.${key} must be a non-empty string`);
      device[key] = v;
    }
  }

  // "slim" is the documented key; "simslim" is still read for scenarios written before the rename
  if (r["slim"] !== undefined && r["simslim"] !== undefined) throw new ScenarioError(`use "slim" only (not both "slim" and "simslim")`);
  const slimKey = r["slim"] !== undefined ? "slim" : "simslim";
  let slim: Scenario["slim"] = null;
  if (r[slimKey] !== undefined) {
    const s = obj(r[slimKey], slimKey);
    const profile = s["profile"];
    if (profile !== undefined && (typeof profile !== "string" || profile === "")) throw new ScenarioError(`${slimKey}.profile must be a file path`);
    slim = {
      ...(typeof profile === "string" ? { profile: isAbsolute(profile) ? profile : resolve(baseDir, profile) } : {}),
      requires: categoryList(strList(s["requires"], `${slimKey}.requires`), `${slimKey}.requires`),
    };
  }

  const successRaw = r["success"] === undefined ? {} : obj(r["success"], "success");
  const success: { label?: string; screen?: string } = {};
  if (typeof successRaw["label"] === "string" && successRaw["label"] !== "") success.label = successRaw["label"];
  if (typeof successRaw["screen"] === "string" && successRaw["screen"] !== "") success.screen = successRaw["screen"];

  const avoidSources = [...(bool("allowRisky", false) ? [] : DEFAULT_AVOID), ...strList(r["avoid"], "avoid")];
  const avoid = avoidSources.map((source) => {
    try {
      return new RegExp(source, "i");
    } catch {
      throw new ScenarioError(`avoid pattern ${JSON.stringify(source)} is not a valid regular expression`);
    }
  });

  let canvas: Scenario["canvas"] = null;
  if (r["canvas"] !== undefined) {
    const c = obj(r["canvas"], "canvas");
    const cols = c["cols"] ?? 4;
    const rows = c["rows"] ?? 3;
    const inset = c["inset"] ?? 0.08;
    if (typeof cols !== "number" || typeof rows !== "number" || cols < 1 || rows < 1 || cols > 12 || rows > 12) {
      throw new ScenarioError(`canvas.cols and canvas.rows must be between 1 and 12`);
    }
    if (typeof inset !== "number" || inset < 0 || inset >= 0.5) throw new ScenarioError(`canvas.inset must be between 0 and 0.5`);
    canvas = { cols: Math.floor(cols), rows: Math.floor(rows), inset };
  }

  const customRaw = r["customOptions"] ?? [];
  if (!Array.isArray(customRaw)) throw new ScenarioError(`"customOptions" must be a list`);
  const customOptions = customRaw.map((o: unknown, i: number): CustomOption => {
    const where = `customOptions[${i}]`;
    const c = obj(o, where);
    if (typeof c["name"] !== "string" || c["name"] === "" || !Array.isArray(c["actions"]) || c["actions"].length === 0) {
      throw new ScenarioError(`${where} needs a name and a non-empty actions list`);
    }
    const whenRaw = c["when"] === undefined ? {} : obj(c["when"], `${where}.when`);
    const when: { label?: string; screen?: string; scene?: string } = {};
    for (const key of ["label", "screen", "scene"] as const) if (typeof whenRaw[key] === "string" && whenRaw[key] !== "") when[key] = whenRaw[key];
    return {
      name: c["name"],
      description: typeof c["description"] === "string" ? c["description"] : c["name"],
      when,
      actions: c["actions"].map((a: unknown, j: number) => parseAction(a, `${where}.actions[${j}]`)),
    };
  });

  const script = strList(r["script"], `"script"`);
  if (mode === "scripted" && script.length === 0) throw new ScenarioError(`scripted mode needs a "script" list of option names`);
  const appEventUrl = r["appEventUrl"];
  if (appEventUrl !== undefined && (typeof appEventUrl !== "string" || !appEventUrl.includes("{event}"))) {
    throw new ScenarioError(`"appEventUrl" must be a URL template containing {event} (and usually {payload})`);
  }

  return {
    name: str("name"),
    app: str("app"),
    platform,
    device,
    slim,
    mode,
    goal: str("goal", "Explore the game and report anything that looks or behaves broken"),
    maxSteps: num("maxSteps", 30, 1, 1000),
    maxMinutes: num("maxMinutes", 20, 0.5, 240),
    seed: num("seed", 1, 0, 2 ** 31),
    script,
    success,
    avoid,
    canvas,
    customOptions,
    softlockActions: num("softlockActions", 4, 2, 50),
    slowStepMs: num("slowStepMs", 5000, 100, 600_000),
    settleMs: num("settleMs", 800, 0, 30_000),
    launchWaitMs: num("launchWaitMs", 3000, 0, 120_000),
    video: bool("video", true),
    memoryEvery: num("memoryEvery", 10, 0, 1000),
    probe,
    ...(typeof appEventUrl === "string" ? { appEventUrl } : {}),
    launchArgs: strList(r["launchArgs"], `"launchArgs"`),
    relaunch: bool("relaunch", true),
  };
}

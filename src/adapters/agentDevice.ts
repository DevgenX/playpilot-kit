import { asRecord, CommandError, formatCommand, safeJson, type Exec, type ExecResult } from "../exec.js";
import type { DeviceAction, Rect, Target, UiNode, Viewport } from "../harness/types.js";

/**
 * Thin wrapper over the agent-device CLI (callstack/agent-device, MIT). PlayPilot shells out to the installed CLI and
 * reads its `--json` envelope (`{ success, data, error }`); no code is copied. Observation commands pass
 * `--no-record` so the device session's own history holds only real inputs.
 */

export interface SessionOptions {
  readonly app: string;
  readonly session: string;
  readonly platform: "ios" | "android";
  readonly udid?: string;
  readonly serial?: string;
  /** Deep-link template for trigger-app-event, e.g. `mygame://playpilot?name={event}&payload={payload}`. */
  readonly appEventUrl?: string;
  readonly launchArgs?: readonly string[];
}

export interface Snapshot {
  readonly nodes: UiNode[];
  readonly viewport: Viewport | null;
}

export interface OpenResult {
  /** The device the session landed on (simulator UDID or Android serial), when agent-device reports it. */
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly startupMs: number | null;
}

export interface MemorySample {
  readonly available: boolean;
  readonly residentKb: number | null;
  readonly process: string | null;
}

/** What an input resolved to, so PlayPilot can write a replay line that does not depend on refs. */
export interface ActResult {
  readonly selector: string | null;
}

/** A failed agent-device call, with its machine-readable code and reason. */
export class AgentDeviceError extends CommandError {
  constructor(
    commandLine: string,
    result: ExecResult,
    readonly code: string,
    readonly reason: string | null,
    message: string,
  ) {
    super(commandLine, result, `${code}${reason ? ` (${reason})` : ""}: ${message}`);
    this.name = "AgentDeviceError";
  }
}

export class AgentDevice {
  constructor(
    private readonly exec: Exec,
    private readonly options: SessionOptions,
    private readonly bin = "agent-device",
  ) {}

  private session(): string[] {
    return ["--session", this.options.session];
  }

  private env(): Record<string, string> | undefined {
    if (!this.options.appEventUrl) return undefined;
    const key = this.options.platform === "ios" ? "AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE" : "AGENT_DEVICE_APP_EVENT_URL_TEMPLATE";
    return { [key]: this.options.appEventUrl };
  }

  /** Runs one command with `--json` and returns `data`, or throws an AgentDeviceError. */
  async call(args: readonly string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const full = [...args, "--json", ...this.session()];
    const env = this.env();
    const result = await this.exec(this.bin, full, { timeoutMs, ...(env ? { env } : {}) });
    const envelope = asRecord(safeJson(result.stdout));
    if (result.code === 0 && (envelope === null || envelope["success"] !== false)) {
      return asRecord(envelope?.["data"]) ?? {};
    }
    const error = asRecord(envelope?.["error"]);
    const details = asRecord(error?.["details"]);
    throw new AgentDeviceError(
      formatCommand(this.bin, full),
      result,
      typeof error?.["code"] === "string" ? error["code"] : `exit ${result.code}`,
      typeof details?.["reason"] === "string" ? details["reason"] : null,
      typeof error?.["message"] === "string" ? error["message"] : (result.stderr.trim() || result.stdout.trim()).slice(0, 300),
    );
  }

  /** Opens (relaunching by default, so every run starts from a cold launch) and reports where it landed. */
  async open(relaunch = true): Promise<OpenResult> {
    const args = ["open", this.options.app, "--platform", this.options.platform];
    if (this.options.udid) args.push("--udid", this.options.udid);
    if (this.options.serial) args.push("--serial", this.options.serial);
    if (relaunch) args.push("--relaunch");
    for (const arg of this.options.launchArgs ?? []) args.push("--launch-args", arg);
    const data = await this.call(args, 240_000);
    const startup = asRecord(data["startup"]);
    const id = data["device_udid"] ?? data["serial"] ?? data["id"];
    return {
      deviceId: typeof id === "string" ? id : null,
      deviceName: typeof data["device"] === "string" ? data["device"] : null,
      startupMs: typeof startup?.["durationMs"] === "number" ? startup["durationMs"] : null,
    };
  }

  /** Interactive-only snapshot: the token-cheap view, plus the viewport in points. */
  async snapshot(): Promise<Snapshot> {
    return parseSnapshot(await this.call(["snapshot", "-i", "--no-record"], 60_000));
  }

  /** Runs one or more inputs. Taps, presses, fills and waits go out as one `batch` request (one round trip). */
  async act(actions: readonly DeviceAction[]): Promise<ActResult[]> {
    if (actions.length > 1 && actions.every(batchable)) {
      const data = await this.call(["batch", "--steps", JSON.stringify(actions.map(batchStep)), "--on-error", "stop"], 90_000);
      const results = Array.isArray(data["results"]) ? data["results"] : [];
      return actions.map((_, i) => ({ selector: selectorOf(asRecord(asRecord(results[i])?.["data"])) }));
    }
    const out: ActResult[] = [];
    for (const action of actions) {
      if (action.kind === "game") throw new Error("game actions run through the probe, not agent-device");
      const data = await this.call(actionArgs(action), action.kind === "wait" ? action.ms + 30_000 : 60_000);
      out.push({ selector: selectorOf(data) });
    }
    return out;
  }

  async screenshot(path: string): Promise<void> {
    await this.call(["screenshot", path, "--no-record"]);
  }

  async recordStart(path: string): Promise<void> {
    await this.call(["record", "start", path]);
  }

  async recordStop(): Promise<void> {
    await this.call(["record", "stop"], 300_000);
  }

  /** One PNG summarizing a recording (macOS hosts only). */
  async contactSheet(video: string, out: string): Promise<void> {
    await this.call(["record", "contact-sheet", video, "--out", out], 300_000);
  }

  /** Clears and (re)starts the session's app log, returning its path. */
  async logsRestart(): Promise<string | null> {
    const data = await this.call(["logs", "clear", "--restart"]);
    return typeof data["path"] === "string" ? data["path"] : null;
  }

  async logsMark(text: string): Promise<void> {
    await this.call(["logs", "mark", text]).catch(() => undefined);
  }

  async memorySample(): Promise<MemorySample> {
    const data = await this.call(["perf", "memory", "sample", "--no-record"]);
    const memory = asRecord(asRecord(data["metrics"])?.["memory"]);
    const processes = memory?.["matchedProcesses"];
    return {
      available: memory?.["available"] === true,
      residentKb: typeof memory?.["residentMemoryKb"] === "number" ? memory["residentMemoryKb"] : null,
      process: Array.isArray(processes) && typeof processes[0] === "string" ? processes[0] : null,
    };
  }

  async close(): Promise<void> {
    await this.call(["close"]).catch(() => undefined);
  }
}

function batchable(action: DeviceAction): boolean {
  return (
    action.kind === "wait" ||
    action.kind === "press" ||
    action.kind === "fill" ||
    (action.kind === "tap" && (action.count ?? 1) === 1 && action.holdMs === undefined)
  );
}

function targetInput(target: Target): Record<string, unknown> {
  return "ref" in target ? { kind: "ref", ref: target.ref } : { kind: "selector", selector: target.selector };
}

function batchStep(action: DeviceAction): Record<string, unknown> {
  switch (action.kind) {
    case "wait":
      return { command: "wait", input: { durationMs: action.ms } };
    case "tap":
      return { command: "press", input: { target: { kind: "point", x: Math.round(action.at.x), y: Math.round(action.at.y) } } };
    case "press":
      return { command: "press", input: { target: targetInput(action) } };
    case "fill":
      return { command: "fill", input: { target: targetInput(action), text: action.text } };
    default:
      throw new Error(`${action.kind} cannot be batched`);
  }
}

function targetArg(target: Target): string {
  return "ref" in target ? target.ref : target.selector;
}

/** The agent-device command line for one input (without `--json` and the session). */
export function actionArgs(action: DeviceAction): string[] {
  const n = (v: number): string => String(Math.round(v));
  switch (action.kind) {
    case "press":
      return ["press", targetArg(action)];
    case "tap": {
      const args = ["press", n(action.at.x), n(action.at.y)];
      if (action.count !== undefined && action.count > 1) args.push("--count", String(action.count));
      if (action.holdMs !== undefined) args.push("--hold-ms", String(action.holdMs));
      return args;
    }
    case "longpress":
      return ["longpress", n(action.at.x), n(action.at.y), String(action.ms)];
    case "pan":
      return ["gesture", "pan", n(action.from.x), n(action.from.y), n(action.dx), n(action.dy), String(action.ms)];
    case "fill":
      return ["fill", targetArg(action), action.text];
    case "type":
      return ["type", action.text];
    case "back":
      return ["back"];
    case "wait":
      return ["wait", String(action.ms)];
    case "appEvent":
      return ["trigger-app-event", action.event, JSON.stringify(action.payload)];
    case "game":
      throw new Error("game actions run through the probe, not agent-device");
  }
}

function selectorOf(data: Record<string, unknown> | null): string | null {
  const chain = data?.["selectorChain"];
  return Array.isArray(chain) && chain.length > 0 && chain.every((s) => typeof s === "string") ? chain.join(" || ") : null;
}

function toRect(value: unknown): Rect | null {
  const r = asRecord(value);
  if (!r) return null;
  const { x, y, width, height } = r;
  return typeof x === "number" && typeof y === "number" && typeof width === "number" && typeof height === "number"
    ? { x, y, width, height }
    : null;
}

/**
 * Normalizes `snapshot -i --json` data. agent-device 0.21 reports refs without the `@` (`"ref": "e3"`); PlayPilot
 * always stores them with it. The application root and nodes reported as not hittable are dropped.
 */
export function parseSnapshot(data: Record<string, unknown>): Snapshot {
  const raw: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 10 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record["ref"] === "string") raw.push(record);
    for (const [key, child] of Object.entries(record)) if (key !== "rect") visit(child, depth + 1);
  };
  visit(Array.isArray(data["nodes"]) ? data["nodes"] : data, 0);

  const nodes: UiNode[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const ref = `@${String(r["ref"]).replace(/^@/, "")}`;
    const type = typeof r["type"] === "string" ? r["type"] : typeof r["role"] === "string" ? r["role"] : "element";
    if (seen.has(ref) || r["hittable"] === false || /^application$/i.test(type) || r["kind"] === "application") continue;
    seen.add(ref);
    nodes.push({
      ref,
      type,
      label: typeof r["label"] === "string" ? r["label"] : "",
      identifier: typeof r["identifier"] === "string" ? r["identifier"] : "",
      rect: toRect(r["rect"]),
    });
  }
  const vp = asRecord(data["viewport"]);
  const viewport =
    typeof vp?.["width"] === "number" && typeof vp["height"] === "number" ? { width: vp["width"], height: vp["height"] } : null;
  return { nodes, viewport };
}

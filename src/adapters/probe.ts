import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, safeJson, type Exec } from "../exec.js";
import type { ProbeAction, ProbeState, ProbeTarget } from "../harness/types.js";

/**
 * The PlayPilot side of the game probe file channel (docs/probe-protocol.md): read `state.json` and
 * `events.jsonl`, write `inbox.json`. Two transports: a folder on the Mac's disk (iOS simulator data container)
 * and adb (Android).
 */

export interface ProbeEvent {
  readonly time: number | null;
  readonly level: "exception" | "error" | "warning" | "finding";
  readonly message: string;
  readonly detail: string;
}

/** Reads and writes files in the probe folder. Missing files read as null. */
export interface ProbeTransport {
  readonly where: string;
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
}

export class LocalTransport implements ProbeTransport {
  constructor(readonly where: string) {}

  async read(name: string): Promise<string | null> {
    try {
      return await readFile(join(this.where, name), "utf8");
    } catch {
      return null;
    }
  }

  async write(name: string, text: string): Promise<void> {
    await mkdir(this.where, { recursive: true });
    const temp = join(this.where, `.${name}.${process.pid}.tmp`);
    await writeFile(temp, text, "utf8");
    await rename(temp, join(this.where, name));
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(join(this.where, "state.json"))).isFile();
    } catch {
      return false;
    }
  }
}

/** Android: the app's external files folder, through adb. */
export class AdbTransport implements ProbeTransport {
  readonly where: string;

  constructor(
    private readonly exec: Exec,
    packageName: string,
    private readonly serial?: string,
  ) {
    this.where = `/sdcard/Android/data/${packageName}/files/playpilot`;
  }

  private adb(args: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  async read(name: string): Promise<string | null> {
    const result = await this.exec("adb", this.adb(["exec-out", "cat", `${this.where}/${name}`]), { timeoutMs: 15_000 });
    return result.code === 0 && !/No such file/.test(result.stderr + result.stdout) ? result.stdout : null;
  }

  async write(name: string, text: string): Promise<void> {
    const escaped = text.replace(/'/g, `'\\''`);
    const temp = `${this.where}/.${name}.tmp`;
    const script = `mkdir -p '${this.where}' && printf '%s' '${escaped}' > '${temp}' && mv '${temp}' '${this.where}/${name}'`;
    const result = await this.exec("adb", this.adb(["shell", script]), { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(`adb could not write ${name}: ${result.stderr.trim()}`);
  }
}

export class ProbeChannel {
  private eventsOffset = 0;
  private commandCounter = 0;

  constructor(readonly transport: ProbeTransport) {}

  /** For session files: where reading left off, so a resumed session does not report events twice. */
  get cursor(): { eventsOffset: number; commandCounter: number } {
    return { eventsOffset: this.eventsOffset, commandCounter: this.commandCounter };
  }

  set cursor(value: { eventsOffset: number; commandCounter: number }) {
    this.eventsOffset = value.eventsOffset;
    this.commandCounter = value.commandCounter;
  }

  async state(): Promise<ProbeState | null> {
    const text = await this.transport.read("state.json");
    return text === null ? null : parseProbeState(text);
  }

  /** Events appended since the last call. */
  async events(): Promise<ProbeEvent[]> {
    const text = await this.transport.read("events.jsonl");
    if (text === null) return [];
    if (text.length < this.eventsOffset) this.eventsOffset = 0; // the game restarted and truncated the file
    const fresh = text.slice(this.eventsOffset);
    const complete = fresh.lastIndexOf("\n") + 1; // leave a half-written last line for next time
    this.eventsOffset += complete;
    return fresh
      .slice(0, complete)
      .split("\n")
      .map((line) => parseProbeEvent(line))
      .filter((e): e is ProbeEvent => e !== null);
  }

  /** Sends one action to the game and waits for its ack. */
  async run(
    action: string,
    args: Readonly<Record<string, unknown>>,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
  ): Promise<{ ok: boolean; message: string }> {
    this.commandCounter += 1;
    const id = `pp-${Date.now().toString(36)}-${this.commandCounter}`;
    await this.transport.write("inbox.json", JSON.stringify({ id, action, args }));
    const timeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : 60_000;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(150);
      const ack = (await this.state())?.ack;
      if (ack?.id === id) return { ok: ack.ok, message: ack.message };
    }
    return { ok: false, message: `no ack from the game within ${timeoutMs} ms (is the probe running?)` };
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseProbeState(text: string): ProbeState | null {
  const r = asRecord(safeJson(text));
  if (r === null || r["v"] !== 1) return null;
  const facts: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(asRecord(r["facts"]) ?? {})) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") facts[key] = value;
  }
  const targets: ProbeTarget[] = [];
  for (const item of Array.isArray(r["targets"]) ? r["targets"] : []) {
    const t = asRecord(item);
    const [x, y, w, h] = [num(t?.["x"]), num(t?.["y"]), num(t?.["w"]), num(t?.["h"])];
    if (t === null || x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) continue;
    targets.push({ id: str(t["id"]), label: str(t["label"]) || str(t["id"]), kind: str(t["kind"]) || "target", x, y, w: w ?? 0, h: h ?? 0 });
  }
  const actions: ProbeAction[] = [];
  for (const item of Array.isArray(r["actions"]) ? r["actions"] : []) {
    const a = asRecord(item);
    if (a && str(a["id"]) !== "") actions.push({ id: str(a["id"]), description: str(a["description"]) || str(a["id"]) });
  }
  const ackRaw = asRecord(r["ack"]);
  return {
    seq: num(r["seq"]) ?? 0,
    scene: str(r["scene"]),
    screen: str(r["screen"]),
    busy: r["busy"] === true,
    facts,
    targets,
    actions,
    ack: ackRaw && str(ackRaw["id"]) !== "" ? { id: str(ackRaw["id"]), ok: ackRaw["ok"] === true, message: str(ackRaw["message"]) } : null,
  };
}

const LEVELS = new Set(["exception", "error", "warning", "finding"]);

export function parseProbeEvent(line: string): ProbeEvent | null {
  const r = asRecord(safeJson(line.trim()));
  if (r === null || !LEVELS.has(str(r["level"])) || str(r["message"]) === "") return null;
  return { time: num(r["time"]), level: str(r["level"]) as ProbeEvent["level"], message: str(r["message"]).slice(0, 500), detail: str(r["detail"]).slice(0, 2000) };
}


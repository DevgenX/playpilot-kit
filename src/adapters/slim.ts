import { readFile } from "node:fs/promises";
import { asRecord, must, safeJson, type Exec } from "../exec.js";
import { ALL_LABELS, CATEGORIES, CATEGORY_IDS } from "../slim/catalog.js";

/**
 * Slim simulators: switches off the iOS simulator's background services a game never needs (src/slim/catalog.ts),
 * so each simulator runs far fewer processes and several can play at once on one Mac. The switch is
 * `launchctl disable` inside the simulator, which persists across reboots; a reboot makes it take effect.
 */

export interface SlimProfile {
  readonly name: string;
  readonly description: string;
  /** Categories left on. */
  readonly except: readonly string[];
  /** Individual services left on. */
  readonly keep: readonly string[];
}

export interface Footprint {
  readonly processes: number | null;
  readonly megabytes: number | null;
}

export interface Drift {
  /** Should be off but are on. */
  readonly missing: readonly string[];
  /** Are off but the profile keeps them on. */
  readonly extra: readonly string[];
}

export class SlimProfileError extends Error {
  override readonly name = "SlimProfileError";
}

const LABEL = /^[A-Za-z0-9_.-]+$/;
const PROFILE_KEYS = new Set(["$schema", "name", "description", "except", "keep"]);

/** The default profile: every category off. */
export const FULL_SLIM: SlimProfile = { name: "full", description: "Every category off", except: [], keep: [] };

export function parseProfile(raw: unknown, where = "profile"): SlimProfile {
  const r = asRecord(raw);
  if (r === null) throw new SlimProfileError(`${where} must be a JSON object`);
  const unknown = Object.keys(r).filter((k) => !PROFILE_KEYS.has(k));
  if (unknown.length > 0) throw new SlimProfileError(`${where}: unknown field(s) ${unknown.join(", ")} (allowed: name, description, except, keep)`);
  const list = (key: string): string[] => {
    const v = r[key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new SlimProfileError(`${where}.${key} must be a list of strings`);
    return v as string[];
  };
  const except = list("except");
  const badCategories = except.filter((id) => !CATEGORY_IDS.includes(id));
  if (badCategories.length > 0) throw new SlimProfileError(`${where}.except: unknown categor(ies) ${badCategories.join(", ")} (known: ${CATEGORY_IDS.join(", ")})`);
  const keep = list("keep");
  const badLabels = keep.filter((l) => !LABEL.test(l));
  if (badLabels.length > 0) throw new SlimProfileError(`${where}.keep: not a service label: ${badLabels.join(", ")}`);
  return {
    name: typeof r["name"] === "string" ? r["name"] : "custom",
    description: typeof r["description"] === "string" ? r["description"] : "",
    except,
    keep,
  };
}

export async function loadProfile(path?: string): Promise<SlimProfile> {
  if (path === undefined) return FULL_SLIM;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new SlimProfileError(`cannot read slim profile ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = safeJson(text);
  if (raw === null) throw new SlimProfileError(`slim profile ${path} is not valid JSON`);
  return parseProfile(raw, path);
}

/** The services a profile switches off. */
export function offLabels(profile: SlimProfile): Set<string> {
  const keep = new Set(profile.keep);
  return new Set(CATEGORIES.filter((c) => !profile.except.includes(c.id)).flatMap((c) => c.labels.filter((l) => !keep.has(l))));
}

/** Categories a scenario needs that the profile switches off. */
export function missingRequirements(profile: SlimProfile, requires: readonly string[]): string[] {
  return requires.filter((id) => !profile.except.includes(id));
}

/** `launchctl print-disabled system` output to the set of disabled labels (`=> disabled` or older `=> true`). */
export function parseDisabled(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)) out.add(m[1] ?? "");
  out.delete("");
  return out;
}

/** `top -l 1 -stats pid,mem` MEM values (`7590K`, `12M+`, `1.2G`) to megabytes. */
export function parseTopMem(value: string): number | null {
  const m = /^([\d.]+)([BKMG])/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const scale: Record<string, number> = { B: 1 / 1_048_576, K: 1 / 1024, M: 1, G: 1024 };
  return n * (scale[m[2] ?? "M"] ?? 1);
}

const SPAWN_PARALLEL = 8;

export class Slimmer {
  constructor(private readonly exec: Exec) {}

  private simctl(args: string[], timeoutMs = 60_000): ReturnType<Exec> {
    return this.exec("xcrun", ["simctl", ...args], { timeoutMs });
  }

  async state(udid: string): Promise<string | null> {
    const result = await this.simctl(["list", "devices", "-j"], 30_000);
    const parsed = asRecord(safeJson(result.stdout));
    for (const list of Object.values(asRecord(parsed?.["devices"]) ?? {})) {
      for (const d of Array.isArray(list) ? list : []) {
        const dev = asRecord(d);
        if (dev?.["udid"] === udid) return typeof dev["state"] === "string" ? dev["state"] : null;
      }
    }
    return null;
  }

  private async bootAndWait(udid: string): Promise<void> {
    await must(this.exec, "xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 });
    await must(this.exec, "xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 5 * 60_000 });
  }

  private async ensureBooted(udid: string): Promise<void> {
    const state = await this.state(udid);
    if (state === null) throw new Error(`no simulator with UDID ${udid} (xcrun simctl list devices)`);
    if (state !== "Booted") await this.bootAndWait(udid);
  }

  private async reboot(udid: string): Promise<void> {
    await must(this.exec, "xcrun", ["simctl", "shutdown", udid], { timeoutMs: 120_000 });
    await this.bootAndWait(udid);
  }

  async disabled(udid: string): Promise<Set<string>> {
    const result = await must(this.exec, "xcrun", ["simctl", "spawn", udid, "launchctl", "print-disabled", "system"], { timeoutMs: 60_000 });
    return parseDisabled(result.stdout);
  }

  /** How far a booted simulator is from the profile. Only services in the catalog count. */
  async drift(udid: string, profile: SlimProfile): Promise<Drift> {
    const off = offLabels(profile);
    const now = await this.disabled(udid);
    return {
      missing: [...off].filter((l) => !now.has(l)).sort(),
      extra: [...now].filter((l) => ALL_LABELS.has(l) && !off.has(l)).sort(),
    };
  }

  async verify(udid: string, profile: SlimProfile): Promise<Drift> {
    await this.ensureBooted(udid);
    return this.drift(udid, profile);
  }

  private async setAll(udid: string, verb: "disable" | "enable", labels: readonly string[]): Promise<void> {
    const queue = [...labels];
    const failures: string[] = [];
    const worker = async (): Promise<void> => {
      for (let label = queue.shift(); label !== undefined; label = queue.shift()) {
        const r = await this.simctl(["spawn", udid, "launchctl", verb, `system/${label}`]);
        if (r.code !== 0) failures.push(label);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SPAWN_PARALLEL, queue.length) }, worker));
    if (failures.length > 0) throw new Error(`launchctl ${verb} failed for ${failures.join(", ")}`);
  }

  /**
   * Boots the simulator if needed, applies only the difference to the profile and reboots once. Returns whether
   * anything changed. A simulator that already matches is left alone (no reboot).
   */
  async ensure(udid: string, profile: SlimProfile): Promise<boolean> {
    const drift = await this.verify(udid, profile);
    if (drift.missing.length === 0 && drift.extra.length === 0) return false;
    await this.setAll(udid, "disable", drift.missing);
    await this.setAll(udid, "enable", drift.extra);
    await this.reboot(udid);
    const after = await this.drift(udid, profile);
    if (after.missing.length > 0 || after.extra.length > 0) {
      throw new Error(`the simulator did not keep the profile (still on: ${after.missing.join(", ") || "none"}; still off: ${after.extra.join(", ") || "none"})`);
    }
    return true;
  }

  /** Switches every catalog service back on and reboots. Returns whether anything changed. */
  async restore(udid: string): Promise<boolean> {
    await this.ensureBooted(udid);
    const off = [...(await this.disabled(udid))].filter((l) => ALL_LABELS.has(l));
    if (off.length === 0) return false;
    await this.setAll(udid, "enable", off);
    await this.reboot(udid);
    return true;
  }

  /** Physical memory footprint of every process the booted simulator runs. */
  async measure(udid: string): Promise<Footprint> {
    const ps = await this.exec("ps", ["-axo", "pid=,ppid=,command="], { timeoutMs: 30_000 });
    const children = new Map<number, number[]>();
    const roots: number[] = [];
    for (const line of ps.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      if (/launchd_sim\b/.test(m[3] ?? "") && (m[3] ?? "").includes(udid)) roots.push(pid);
    }
    if (roots.length === 0) return { processes: null, megabytes: null };
    const pids: number[] = [];
    for (const stack = [...roots]; stack.length > 0; ) {
      const pid = stack.pop() as number;
      pids.push(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    const top = await this.exec("top", ["-l", "1", "-stats", "pid,mem", ...pids.flatMap((p) => ["-pid", String(p)])], { timeoutMs: 60_000 });
    const wanted = new Set(pids);
    let mb = 0;
    let counted = 0;
    for (const line of top.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!m || !wanted.has(Number(m[1]))) continue;
      const value = parseTopMem(m[2] ?? "");
      if (value === null) continue;
      mb += value;
      counted += 1;
    }
    return { processes: pids.length, megabytes: counted > 0 ? Math.round(mb) : null };
  }
}

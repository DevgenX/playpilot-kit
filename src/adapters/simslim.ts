import { must, safeJson, asRecord, type Exec } from "../exec.js";

/**
 * Slim simulators: switches off the iOS simulator's background daemons a game never needs, so each simulator uses
 * about a quarter of the memory. Shells out to the installed simslim CLI.
 */
export interface Footprint {
  readonly processes: number | null;
  readonly megabytes: number | null;
}

export class Simslim {
  constructor(
    private readonly exec: Exec,
    private readonly bin = "simslim",
  ) {}

  /** Slims a simulator with a committed profile and reboots it slim (simslim applies only the delta). */
  async on(udid: string, profilePath?: string): Promise<void> {
    const args = ["on", udid];
    if (profilePath) args.push("--profile", profilePath);
    await must(this.exec, this.bin, args, { timeoutMs: 15 * 60_000 });
  }

  /** True when the simulator still matches the profile exactly (simslim exits non-zero on drift). */
  async verify(udid: string, profilePath?: string): Promise<boolean> {
    const args = ["verify", udid];
    if (profilePath) args.push("--profile", profilePath);
    return (await this.exec(this.bin, args)).code === 0;
  }

  /** Preflight: the features a game needs (e.g. game-center, storekit) still work on the slim simulator. */
  async doctor(udid: string, requires: readonly string[]): Promise<{ ok: boolean; output: string }> {
    const result = await this.exec(this.bin, ["doctor", udid, "--requires", requires.join(",")]);
    return { ok: result.code === 0, output: (result.stdout + result.stderr).trim() };
  }

  /** Memory footprint of a booted simulator (phys_footprint, as simslim measures it). */
  async measure(udid: string): Promise<Footprint> {
    const result = await this.exec(this.bin, ["measure", udid, "--json"]);
    const data = asRecord(safeJson(result.stdout));
    const bytes = data?.["bytes"];
    const processes = data?.["processes"];
    return {
      processes: typeof processes === "number" ? processes : null,
      megabytes: typeof bytes === "number" ? Math.round(bytes / 1_048_576) : null,
    };
  }

  /** Verifies, and re-applies the profile only when it drifted. Returns whether a repair ran. */
  async ensure(udid: string, profilePath?: string): Promise<boolean> {
    if (await this.verify(udid, profilePath)) return false;
    await this.on(udid, profilePath);
    return true;
  }
}

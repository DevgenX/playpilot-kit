import type { ExecResult } from "../src/exec.js";

/**
 * A fake iOS simulator for the slim commands, answering like the real `xcrun simctl` (list -j, spawn launchctl,
 * boot, bootstatus, shutdown), `ps` and `top`. Disables take effect on the next boot, as on a real simulator.
 */
export class FakeSimulator {
  state: "Booted" | "Shutdown";
  /** Persisted `launchctl disable` overrides. */
  readonly disabled: Set<string>;
  /** Services running since the last boot. */
  private runningOff = new Set<string>();
  boots = 0;
  readonly failLabels = new Set<string>();

  constructor(
    readonly udid: string,
    options: { booted?: boolean; disabled?: readonly string[] } = {},
  ) {
    this.state = options.booted === false ? "Shutdown" : "Booted";
    this.disabled = new Set(options.disabled ?? []);
    this.runningOff = new Set(this.disabled);
  }

  /** Processes the simulator runs: fewer with more services switched off at boot. */
  get processCount(): number {
    return 230 - this.runningOff.size;
  }

  handle(command: string, args: readonly string[]): ExecResult | null {
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
    if (command === "ps") {
      if (this.state !== "Booted") return ok("    1     0 /sbin/launchd\n");
      const lines = ["    1     0 /sbin/launchd", ` 5000     1 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${this.udid}/data/var/run/launchd_bootstrap.plist`];
      for (let i = 1; i < this.processCount; i += 1) lines.push(` ${5000 + i}  5000 /RuntimeRoot/usr/libexec/daemon${i}`);
      lines.push(" 9000     1 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/OTHER/data/var/run/launchd_bootstrap.plist");
      lines.push(" 9001  9000 /RuntimeRoot/usr/libexec/other");
      return ok(lines.join("\n") + "\n");
    }
    if (command === "top") {
      const pids = args.flatMap((a, i) => (args[i - 1] === "-pid" ? [a] : []));
      const header = "Processes: 600 total\n\nPID    MEM\n";
      return ok(header + pids.map((p) => `${p.padEnd(6)} ${p === "5000" ? "1024K" : "20M+"}`).join("\n") + "\n");
    }
    if (command !== "xcrun" || args[0] !== "simctl") return null;
    const [, sub, ...rest] = args;
    if (sub === "list") return ok(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: this.udid, name: "Fake", state: this.state }] } }));
    if (rest[0] !== this.udid) return sub === "spawn" || sub === "boot" || sub === "shutdown" || sub === "bootstatus" ? fail(`Invalid device: ${rest[0] ?? ""}`) : null;
    switch (sub) {
      case "boot":
        if (this.state === "Booted") return fail("Unable to boot device in current state: Booted");
        this.state = "Booted";
        this.boots += 1;
        this.runningOff = new Set(this.disabled);
        return ok();
      case "shutdown":
        if (this.state !== "Booted") return fail("Unable to shutdown device in current state: Shutdown");
        this.state = "Shutdown";
        return ok();
      case "bootstatus":
        return this.state === "Booted" ? ok("Device already booted\n") : fail("not booted");
      case "spawn": {
        if (this.state !== "Booted") return fail("Unable to spawn: device is not booted");
        const [, tool, verb, target] = rest;
        if (tool !== "launchctl") return null;
        if (verb === "print-disabled") {
          const body = [...this.disabled].map((l) => `\t\t"${l}" => disabled`).join("\n");
          return ok(`\tdisabled services = {\n${body}\n\t}\n`);
        }
        const label = (target ?? "").replace(/^system\//, "");
        if (this.failLabels.has(label)) return fail(`Could not ${verb} ${label}`);
        if (verb === "disable") this.disabled.add(label);
        else if (verb === "enable") this.disabled.delete(label);
        else return null;
        return ok();
      }
      default:
        return null;
    }
  }
}

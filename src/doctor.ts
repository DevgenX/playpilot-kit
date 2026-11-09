import { asRecord, NOT_FOUND_CODE, safeJson, type Exec } from "./exec.js";

export interface Check {
  readonly name: string;
  readonly level: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix?: string;
}

const MIN_NODE = [22, 12];
const MIN_FREE_GB = 10;

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 100) ?? "";
}

/** Everything a playtest needs on this machine, with the exact fix for each problem. */
export async function doctor(exec: Exec, cwd = process.cwd()): Promise<Check[]> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > (MIN_NODE[0] ?? 0) || (major === MIN_NODE[0] && minor >= (MIN_NODE[1] ?? 0));
  checks.push({ name: "node", level: nodeOk ? "ok" : "fail", detail: process.versions.node, ...(nodeOk ? {} : { fix: "install Node 22.12 or newer" }) });

  // agent-device: every install on PATH, because an older one's daemon blocks a newer CLI
  const which = await exec("which", ["-a", "agent-device"], { timeoutMs: 10_000 });
  const paths = [...new Set(which.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""))];
  if (paths.length === 0) {
    checks.push({ name: "agent-device", level: "fail", detail: "not installed", fix: "npm install -g agent-device@latest" });
  } else {
    const versions = await Promise.all(paths.map(async (p) => ({ path: p, version: firstLine((await exec(p, ["--version"], { timeoutMs: 15_000 })).stdout) })));
    const current = versions[0];
    checks.push({ name: "agent-device", level: "ok", detail: `${current?.version ?? "?"} (${current?.path ?? ""})` });
    const others = versions.slice(1).filter((v) => v.version !== current?.version);
    if (others.length > 0) {
      checks.push({
        name: "agent-device installs",
        level: "warn",
        detail: `other versions on PATH: ${others.map((o) => `${o.version} at ${o.path}`).join(", ")}`,
        fix: `stop their daemons (${others.map((o) => `${o.path} daemon stop`).join("; ")}) and uninstall the old copies`,
      });
    }
    const sessions = await exec("agent-device", ["session", "list", "--json"], { timeoutMs: 30_000 });
    const envelope = asRecord(safeJson(sessions.stdout));
    if (sessions.code === 0 && envelope?.["success"] !== false) {
      const list = asRecord(envelope?.["data"])?.["sessions"];
      checks.push({ name: "agent-device daemon", level: "ok", detail: `${Array.isArray(list) ? list.length : 0} open session(s)` });
    } else {
      const error = asRecord(envelope?.["error"]);
      checks.push({
        name: "agent-device daemon",
        level: "fail",
        detail: typeof error?.["message"] === "string" ? error["message"] : firstLine(sessions.stderr) || `exit ${sessions.code}`,
        fix: "a daemon from another agent-device install may own the state folder: run `<that install> daemon stop`, then retry",
      });
    }
  }

  if (process.platform === "darwin") {
    const simctl = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeoutMs: 30_000 });
    if (simctl.code !== 0) {
      checks.push({ name: "xcode", level: "fail", detail: "xcrun simctl is not working", fix: "install Xcode and run: sudo xcode-select -s /Applications/Xcode.app" });
    } else {
      let booted = 0;
      try {
        const parsed = JSON.parse(simctl.stdout) as { devices?: Record<string, { state: string }[]> };
        booted = Object.values(parsed.devices ?? {}).flat().filter((d) => d.state === "Booted").length;
      } catch {
        // counted as zero
      }
      checks.push({ name: "xcode", level: "ok", detail: `${booted} simulator(s) booted` });
      if (booted > 2) checks.push({ name: "simulators", level: "warn", detail: `${booted} simulators booted`, fix: "shut down the ones you are not testing on (xcrun simctl shutdown <udid>)" });
    }
  }

  const adb = await exec("adb", ["version"], { timeoutMs: 15_000 });
  checks.push(
    adb.code === NOT_FOUND_CODE
      ? { name: "adb", level: "ok", detail: "not installed (only needed for Android)" }
      : { name: "adb", level: "ok", detail: firstLine(adb.stdout) },
  );

  const df = await exec("df", ["-k", cwd], { timeoutMs: 10_000 });
  const freeKb = Number(df.stdout.trim().split("\n")[1]?.trim().split(/\s+/)[3]);
  if (Number.isFinite(freeKb)) {
    const gb = Math.round(freeKb / 1_048_576);
    checks.push(
      gb < MIN_FREE_GB
        ? { name: "disk", level: "warn", detail: `${gb} GB free`, fix: "recordings and frames need room: free some disk space or set \"video\": false" }
        : { name: "disk", level: "ok", detail: `${gb} GB free` },
    );
  }
  return checks;
}

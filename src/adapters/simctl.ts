import { must, type Exec } from "../exec.js";

/** The few `xcrun simctl` calls that are faster or only possible outside agent-device. */
export class Simctl {
  private readonly containers = new Map<string, string | null>();

  constructor(private readonly exec: Exec) {}

  /** Full-resolution PNG of the simulator screen. About three times faster than going through the UI test runner. */
  async screenshot(udid: string, path: string): Promise<void> {
    await must(this.exec, "xcrun", ["simctl", "io", udid, "screenshot", "--type=png", path], { timeoutMs: 30_000 });
  }

  /** The app's data container on the Mac's disk, or null when the app is not installed there. */
  async dataContainer(udid: string, bundleId: string): Promise<string | null> {
    const key = `${udid}/${bundleId}`;
    if (!this.containers.has(key)) {
      const result = await this.exec("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"], { timeoutMs: 30_000 });
      this.containers.set(key, result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null);
    }
    return this.containers.get(key) ?? null;
  }

  /** Booted simulators as { udid, name }. */
  async booted(): Promise<{ udid: string; name: string }[]> {
    const result = await this.exec("xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeoutMs: 30_000 });
    try {
      const parsed = JSON.parse(result.stdout) as { devices?: Record<string, { udid: string; name: string; state: string }[]> };
      return Object.values(parsed.devices ?? {})
        .flat()
        .filter((d) => d.state === "Booted")
        .map((d) => ({ udid: d.udid, name: d.name }));
    } catch {
      return [];
    }
  }
}

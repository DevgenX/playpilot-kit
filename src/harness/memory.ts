import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashDistance } from "./image.js";
import type { MemoryView, ProbeState, UiNode } from "./types.js";

/**
 * Per-game memory kept between runs: the screens seen and how each option fared on each. Autopilot keeps verified
 * notes and reusable harness code per project; this is the data-only version of that loop, so every run explores
 * what earlier runs did not and skips what always failed.
 */
interface OptionStats {
  tries: number;
  fails: number;
  /** Times the option moved the game to a different screen. */
  changed: number;
}

interface ScreenEntry {
  /** Structural identity (probe scene/screen or accessibility labels). Absent for canvas-only screens. */
  key?: string;
  /** Perceptual hash, used to recognize canvas-only screens. */
  hash?: string;
  labels: string[];
  visits: number;
  firstRun: number;
  options: Record<string, OptionStats>;
}

interface MemoryFile {
  version: 2;
  runs: number;
  nextId: number;
  screens: Record<string, ScreenEntry>;
  notes: string[];
}

/** How far apart two canvas frames may be (of 64 hash bits) and still count as the same screen. */
const SAME_CANVAS = 10;

export interface ScreenRef {
  readonly id: string;
  readonly isNew: boolean;
  readonly visits: number;
}

export class GameMemory implements MemoryView {
  private constructor(
    private readonly path: string,
    private readonly data: MemoryFile,
  ) {}

  static async load(path: string): Promise<GameMemory> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as MemoryFile;
      if (parsed.version === 2) return new GameMemory(path, parsed);
    } catch {
      // first run, or an unreadable file: start fresh rather than fail the playtest
    }
    return new GameMemory(path, { version: 2, runs: 0, nextId: 1, screens: {}, notes: [] });
  }

  get runs(): number {
    return this.data.runs;
  }

  get screenCount(): number {
    return Object.keys(this.data.screens).length;
  }

  get notes(): readonly string[] {
    return this.data.notes;
  }

  /** Finds or creates the screen for this observation and counts the visit. */
  resolve(nodes: readonly UiNode[], probe: ProbeState | null, hash: string | null): ScreenRef {
    const key = structuralKey(nodes, probe);
    let id: string | undefined;
    if (key !== null) {
      id = Object.keys(this.data.screens).find((k) => this.data.screens[k]?.key === key);
    } else if (hash !== null) {
      let best = SAME_CANVAS + 1;
      for (const [k, s] of Object.entries(this.data.screens)) {
        if (s.key !== undefined || s.hash === undefined) continue;
        const d = hashDistance(s.hash, hash);
        if (d < best) [best, id] = [d, k];
      }
    }
    const isNew = id === undefined;
    if (id === undefined) {
      id = `s${this.data.nextId}`;
      this.data.nextId += 1;
      this.data.screens[id] = {
        ...(key !== null ? { key } : {}),
        ...(hash !== null && key === null ? { hash } : {}),
        labels: labelsOf(nodes, probe).slice(0, 20),
        visits: 0,
        firstRun: this.data.runs + 1,
        options: {},
      };
    }
    const entry = this.data.screens[id];
    if (entry) entry.visits += 1;
    return { id, isNew, visits: entry?.visits ?? 1 };
  }

  timesTried(screen: string, option: string): number {
    return this.data.screens[screen]?.options[option]?.tries ?? 0;
  }

  alwaysFailed(screen: string, option: string): boolean {
    const stats = this.data.screens[screen]?.options[option];
    return stats !== undefined && stats.fails > 0 && stats.fails >= stats.tries;
  }

  timesChanged(screen: string, option: string): number {
    return this.data.screens[screen]?.options[option]?.changed ?? 0;
  }

  record(screen: string, option: string, ok: boolean, changed: boolean): void {
    const entry = this.data.screens[screen];
    if (!entry) return;
    const stats = (entry.options[option] ??= { tries: 0, fails: 0, changed: 0 });
    stats.tries += 1;
    if (!ok) stats.fails += 1;
    if (changed) stats.changed += 1;
  }

  note(text: string): void {
    if (!this.data.notes.includes(text)) this.data.notes.push(text);
    if (this.data.notes.length > 200) this.data.notes.splice(0, this.data.notes.length - 200);
  }

  /** Writes the file (atomically). Pass `countRun` once, at the end of a run. */
  async save(countRun: boolean): Promise<void> {
    if (countRun) this.data.runs += 1;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    await rename(temp, this.path);
  }
}

function labelsOf(nodes: readonly UiNode[], probe: ProbeState | null): string[] {
  const labels = nodes.map((n) => n.label || n.identifier).filter((l) => l !== "");
  return probe ? [...probe.targets.map((t) => t.label), ...labels] : labels;
}

/**
 * A stable identity for "which screen is this". The probe's own scene and screen win; otherwise the set of
 * accessible controls, with digits masked so a changing score or timer does not make every frame a new screen.
 * Null when there is nothing structural to go on (a game canvas): the caller then falls back to the frame hash.
 */
export function structuralKey(nodes: readonly UiNode[], probe: ProbeState | null): string | null {
  if (probe && (probe.scene !== "" || probe.screen !== "")) return `probe:${probe.scene}/${probe.screen}`;
  if (nodes.length === 0) return null;
  const parts = nodes.map((n) => `${n.type}:${(n.identifier || n.label).replace(/\d+/g, "#")}`);
  return `a11y:${[...new Set(parts)].sort().join("|")}`;
}

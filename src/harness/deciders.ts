import type { Decider, GameOption, MemoryView } from "./types.js";

/** Deterministic PRNG (mulberry32) so a seeded exploration run can be reproduced exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blind grid taps only win when nothing better is left untried. */
const SOURCE_RANK: Readonly<Record<GameOption["source"], number>> = { game: 0, probe: 0, custom: 0, a11y: 0, grid: 1, fine: 2 };

/**
 * Novelty-seeking explorer. On each screen it prefers, in order: options never tried here (across all runs),
 * real targets over grid taps, options that have led somewhere before, then a seeded random pick. Options that
 * only ever failed are skipped. Free, offline and reproducible.
 */
export class ExploreDecider implements Decider {
  readonly name = "explore";
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = seededRandom(seed);
  }

  choose(screen: string, options: readonly GameOption[], memory: MemoryView): GameOption | null {
    if (options.length === 0) return null;
    const viable = options.filter((o) => !memory.alwaysFailed(screen, o.name));
    const pool = viable.length > 0 ? viable : options;
    // untried real targets, then untried coarse grid, then untried fine grid, then the least tried of all
    const score = (o: GameOption): [number, number, number] => [
      Math.min(memory.timesTried(screen, o.name), 1) * 10 + SOURCE_RANK[o.source],
      memory.timesTried(screen, o.name),
      -Math.min(memory.timesChanged(screen, o.name), 1),
    ];
    let best: GameOption[] = [];
    let bestScore: [number, number, number] | null = null;
    for (const o of pool) {
      const s = score(o);
      const cmp = bestScore === null ? -1 : compare(s, bestScore);
      if (cmp < 0) {
        best = [o];
        bestScore = s;
      } else if (cmp === 0) {
        best.push(o);
      }
    }
    return best[Math.floor(this.random() * best.length)] ?? null;
  }
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Follows a fixed list of option names in order: exact name first, then a case-insensitive substring. */
export class ScriptedDecider implements Decider {
  readonly name = "scripted";
  private index = 0;

  constructor(private readonly script: readonly string[]) {}

  choose(_screen: string, options: readonly GameOption[]): GameOption | null {
    const wanted = this.script[this.index];
    if (wanted === undefined) return null;
    const lower = wanted.toLowerCase();
    const match = options.find((o) => o.name === wanted) ?? options.find((o) => o.name.toLowerCase().includes(lower));
    if (match) this.index += 1;
    return match ?? null;
  }

  get remaining(): readonly string[] {
    return this.script.slice(this.index);
  }

  get position(): number {
    return this.index;
  }

  set position(value: number) {
    this.index = value;
  }
}

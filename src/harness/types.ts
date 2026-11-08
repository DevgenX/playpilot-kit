/**
 * The harness contract. The idea (game-level options with their own facts, a decider that picks only among legal
 * options, executors that do the precise input) is credited to Aura Autopilot (ramenvr/autopilot, Apache-2.0).
 * This is an independent TypeScript implementation for mobile games.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Where to press. `ref` is a snapshot ref (`@e3`, only valid for the latest snapshot); `selector` is an
 * agent-device selector expression (`id="play" || label="Play"`), stable across runs.
 */
export type Target = { readonly ref: string } | { readonly selector: string };

/**
 * One input. Game-level options compile down to these. Coordinates are in screen points, the same space as the
 * accessibility tree and as the frames PlayPilot saves.
 */
export type DeviceAction =
  | ({ readonly kind: "press" } & Target)
  | { readonly kind: "tap"; readonly at: Point; readonly count?: number; readonly holdMs?: number }
  | { readonly kind: "longpress"; readonly at: Point; readonly ms: number }
  | { readonly kind: "pan"; readonly from: Point; readonly dx: number; readonly dy: number; readonly ms: number }
  | ({ readonly kind: "fill"; readonly text: string } & Target)
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "back" }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "appEvent"; readonly event: string; readonly payload: Readonly<Record<string, unknown>> }
  /** A macro the game runs itself through the probe (see docs/probe-protocol.md). */
  | { readonly kind: "game"; readonly action: string; readonly args: Readonly<Record<string, unknown>> };

/** One actionable element from an accessibility snapshot. */
export interface UiNode {
  /** Always `@`-prefixed, ready to pass to agent-device. */
  readonly ref: string;
  readonly type: string;
  readonly label: string;
  readonly identifier: string;
  readonly rect: Rect | null;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** A hit area the game reports through its probe. Normalized, top-left origin, centre point. */
export interface ProbeTarget {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ProbeAction {
  readonly id: string;
  readonly description: string;
}

/** The latest `state.json` a probe wrote. */
export interface ProbeState {
  readonly seq: number;
  readonly scene: string;
  readonly screen: string;
  readonly busy: boolean;
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
  readonly targets: readonly ProbeTarget[];
  readonly actions: readonly ProbeAction[];
  readonly ack: { readonly id: string; readonly ok: boolean; readonly message: string } | null;
}

/** What the game looks like right now, as cheap facts. */
export interface Observation {
  readonly t: number;
  readonly nodes: readonly UiNode[];
  readonly viewport: Viewport;
  /** Perceptual hash of the frame (16 hex chars), or null when no frame could be read. */
  readonly frameHash: string | null;
  /** True when the frame is (nearly) one flat colour: a black, white or blank screen. */
  readonly blank: boolean;
  readonly probe: ProbeState | null;
}

/** One legal, game-meaningful choice ("press Play", "drag the gear onto the axle", "play a round"). */
export interface GameOption {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly DeviceAction[];
  /** Where the option came from; the explorer prefers real targets over blind grid taps. */
  readonly source: "a11y" | "probe" | "game" | "custom" | "grid" | "fine";
}

/** Chooses one option. Pluggable: scripted, the novelty-seeking explorer, or an agent through `playpilot agent`. */
export interface Decider {
  readonly name: string;
  choose(screen: string, options: readonly GameOption[], memory: MemoryView): GameOption | null;
}

/** What earlier runs learned, as a decider sees it. */
export interface MemoryView {
  timesTried(screen: string, option: string): number;
  /** Tried at least once and failed every time. */
  alwaysFailed(screen: string, option: string): boolean;
  /** How often this option moved the game to a different screen. */
  timesChanged(screen: string, option: string): number;
}

export type FindingKind =
  | "crash"
  | "exception"
  | "game_invariant"
  | "softlock"
  | "blank_screen"
  | "memory_growth"
  | "error_log"
  | "slow_step"
  | "command_failed"
  | "agent";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly step: number;
  readonly message: string;
  /** Frame of the step the finding belongs to, when there is one. */
  readonly frame?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export const DEFAULT_SEVERITY: Readonly<Record<FindingKind, Severity>> = {
  crash: "critical",
  exception: "high",
  game_invariant: "high",
  softlock: "high",
  blank_screen: "medium",
  memory_growth: "medium",
  error_log: "low",
  slow_step: "low",
  command_failed: "info",
  agent: "medium",
};

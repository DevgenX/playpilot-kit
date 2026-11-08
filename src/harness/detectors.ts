import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEVERITY, type Finding, type FindingKind } from "./types.js";
import type { ProbeEvent } from "../adapters/probe.js";

export function finding(kind: FindingKind, step: number, message: string, evidence: Record<string, unknown> = {}, frame?: string): Finding {
  return { kind, severity: DEFAULT_SEVERITY[kind], step, message, evidence, ...(frame !== undefined ? { frame } : {}) };
}

/** Lines that mean the app died, from any log source (iOS unified log, Android logcat, engine stdout). */
const CRASH_PATTERNS: readonly RegExp[] = [
  /Fatal error:/,
  /EXC_BAD_ACCESS|EXC_CRASH|EXC_BREAKPOINT/,
  /Terminating app due to uncaught exception/,
  /\*\*\* Assertion failure in/,
  /\bSIG(ABRT|SEGV|BUS|ILL)\b/,
  /FATAL EXCEPTION:/,
  /\bANR in\b/,
];

/** Engine and app errors that usually show up as plain stdout lines rather than typed log entries. */
const ENGINE_ERROR_PATTERNS: readonly RegExp[] = [
  /^(\w+\.)*\w*Exception: /,
  /\bNullReferenceException\b/,
  /\bMissingReferenceException\b/,
  /\bSCRIPT ERROR\b/,
  /\bShader error\b/i,
  /\bfailed to load\b/i,
  /\bMetal API Validation\b/,
];

/**
 * Subsystems that write in the app's process but describe the test harness or the OS, not the game. Most of a
 * simulator app log is XCTest chatter answering accessibility queries.
 */
const NOISE = /^(com\.apple\.(dt\.|UIKit|Accessibility|xpc|BackBoard|FrontBoard|runningboard|CoreTelephony|network|defaults|CFNetwork|coreanimation|launchservices|AppSupport|RenderBox|SpringBoard)|libsystem_|AXRuntime)/;

/** `2026-01-01 12:00:00.000 E  MyGame[123:abc] [com.example:cat] message` (iOS `log stream --style compact`). */
const OSLOG_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\w{1,2})\s+[^\s[]+\[\d+:[\da-fx]+\]\s+(?:\[([^\]]+)\]|\(([^)]+)\))?\s*(.*)$/;

export interface LogScan {
  readonly findings: Finding[];
  /** Subsystem of the last typed line, carried to continuation lines in the next chunk. */
  readonly subsystem: string;
}

/**
 * Scans new app-log text. Typed iOS lines are judged by type (E = error, F = fault) and subsystem; untyped lines
 * (stdout, logcat, continuations) by pattern. Harness noise is skipped, and repeats are reported once per run.
 */
export function scanLog(text: string, step: number, seen: Set<string>, subsystem = ""): LogScan {
  const findings: Finding[] = [];
  let current = subsystem;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const typed = OSLOG_LINE.exec(line);
    let message = line;
    let type = "";
    if (typed) {
      type = typed[1] ?? "";
      current = typed[2] ?? typed[3] ?? "";
      message = typed[4] ?? "";
    }
    if (NOISE.test(current) || /\bPLAYPILOT \{/.test(message) || /^-- playpilot step/.test(message)) continue;
    const key = message.replace(/0x[\da-f]+|\d+/gi, "#").slice(0, 160);
    if (seen.has(key)) continue;
    let kind: FindingKind | null = null;
    if (CRASH_PATTERNS.some((p) => p.test(message))) kind = "crash";
    else if (ENGINE_ERROR_PATTERNS.some((p) => p.test(message))) kind = "error_log";
    else if ((type === "E" || type === "F") && !current.startsWith("com.apple.")) kind = "error_log";
    if (kind === null) continue;
    seen.add(key);
    findings.push(finding(kind, step, message.slice(0, 300), { source: "app log", ...(current ? { subsystem: current } : {}) }));
  }
  return { findings, subsystem: current };
}

/** Engine-reported problems from the probe's events.jsonl. */
export function probeFindings(events: readonly ProbeEvent[], step: number, frame?: string): Finding[] {
  const out: Finding[] = [];
  for (const e of events) {
    if (e.level === "warning") continue;
    const kind: FindingKind = e.level === "exception" ? "exception" : e.level === "finding" ? "game_invariant" : "error_log";
    out.push(finding(kind, step, e.message, { source: "probe", ...(e.detail ? { detail: e.detail } : {}), ...(e.time !== null ? { gameTime: e.time } : {}) }, frame));
  }
  return out;
}

/**
 * Softlock: the player kept acting with different real controls (accessible elements, probe targets, macros),
 * yet nothing visibly changed. Blind grid taps that miss small buttons are not evidence of a stuck game, so a
 * grid-only screen needs every coarse cell tried before it counts, and then only at medium severity.
 */
export class SoftlockDetector {
  private tried = new Set<string>();
  private gridTried = new Set<string>();
  private reported = false;

  constructor(
    private readonly limit: number,
    private readonly gridCells = 12,
  ) {}

  /** `changed`: whether the last action visibly changed the game. */
  observe(changed: boolean, screen: string, step: number, lastOption: string | null, lastWasGrid: boolean, frame?: string): Finding | null {
    if (changed || lastOption === null) {
      this.tried = new Set();
      this.gridTried = new Set();
      this.reported = false;
      return null;
    }
    (lastWasGrid ? this.gridTried : this.tried).add(lastOption);
    if (this.reported) return null;
    if (this.tried.size >= this.limit) {
      this.reported = true;
      return finding("softlock", step, `Nothing changed after ${this.tried.size} different controls on this screen (last: ${lastOption})`, { tried: [...this.tried], screen }, frame);
    }
    if (this.tried.size === 0 && this.gridTried.size >= this.gridCells) {
      this.reported = true;
      return {
        ...finding("softlock", step, `Nothing changed after tapping ${this.gridTried.size} spots across the screen; the game may be stuck, or its controls sit between the grid points`, { tried: [...this.gridTried], screen }, frame),
        severity: "medium",
      };
    }
    return null;
  }

  toJSON(): unknown {
    return { tried: [...this.tried], gridTried: [...this.gridTried], reported: this.reported };
  }

  restore(value: unknown): void {
    const v = value as { tried?: string[]; gridTried?: string[]; reported?: boolean } | null;
    this.tried = new Set(v?.tried ?? []);
    this.gridTried = new Set(v?.gridTried ?? []);
    this.reported = v?.reported ?? false;
  }
}

/** A flat frame twice in a row (a single one is often a transition). */
export class BlankScreenDetector {
  private streak = 0;
  private reported = false;

  observe(blank: boolean, step: number, frame?: string): Finding | null {
    this.streak = blank ? this.streak + 1 : 0;
    if (!blank) this.reported = false;
    if (this.streak >= 2 && !this.reported) {
      this.reported = true;
      return finding("blank_screen", step, "The screen stayed one flat colour across two observations", {}, frame);
    }
    return null;
  }

  toJSON(): unknown {
    return { streak: this.streak, reported: this.reported };
  }

  restore(value: unknown): void {
    const v = value as { streak?: number; reported?: boolean } | null;
    this.streak = v?.streak ?? 0;
    this.reported = v?.reported ?? false;
  }
}

/** Resident memory that grew by more than both 50% and 150 MB since the first sample of the run. */
export function memoryGrowth(samplesKb: readonly number[], step: number): Finding | null {
  const first = samplesKb[0];
  const last = samplesKb[samplesKb.length - 1];
  if (first === undefined || last === undefined || samplesKb.length < 3) return null;
  const grew = last - first;
  if (grew <= 150 * 1024 || last < first * 1.5) return null;
  return finding("memory_growth", step, `Memory grew from ${Math.round(first / 1024)} MB to ${Math.round(last / 1024)} MB during the run`, {
    samplesMb: samplesKb.map((kb) => Math.round(kb / 1024)),
  });
}

export function slowStep(ms: number, limitMs: number, step: number, option: string): Finding | null {
  return ms > limitMs ? finding("slow_step", step, `"${option}" took ${ms} ms (limit ${limitMs} ms)`, { ms, option }) : null;
}

/**
 * Crash reports the OS wrote for this app since the run started. iOS simulator crashes land in the Mac's
 * ~/Library/Logs/DiagnosticReports as `<Process>-<date>.ips`.
 */
export async function newCrashReports(processName: string, sinceMs: number, dir = join(homedir(), "Library/Logs/DiagnosticReports")): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(`${processName}-`) || !/\.(ips|crash)$/.test(name)) continue;
    try {
      if ((await stat(join(dir, name))).mtimeMs >= sinceMs) out.push(join(dir, name));
    } catch {
      // removed while scanning
    }
  }
  return out.sort();
}

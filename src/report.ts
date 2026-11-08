import { SEVERITY_ORDER, type Finding, type GameOption, type Severity } from "./harness/types.js";

export interface StepRecord {
  readonly step: number;
  readonly screen: string;
  readonly option: string;
  readonly source: GameOption["source"];
  readonly ok: boolean;
  readonly ms: number;
  /** When the step started, in ms from the start of the video (or of the run when there is no video). */
  readonly atMs: number;
  /** Whether the step moved the game to a different screen (known once the next observation is in). */
  readonly changed?: boolean;
  readonly note?: string;
}

export interface RunReport {
  readonly scenario: string;
  readonly app: string;
  readonly mode: string;
  readonly goal: string;
  /** achieved: goal met or script done; explored: budget used, no goal; not_achieved: goal missed or crash; error: could not run. */
  readonly outcome: "achieved" | "explored" | "not_achieved" | "error";
  readonly note: string;
  /** The agent's own summary, when an agent drove the run. */
  readonly summary: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: { readonly id: string | null; readonly name: string | null };
  readonly steps: readonly StepRecord[];
  readonly findings: readonly Finding[];
  readonly screens: { readonly thisRun: number; readonly new: number; readonly knownTotal: number };
  readonly coverage: { readonly optionsSeen: number; readonly optionsTried: number };
  readonly memoryRuns: number;
  readonly memoryMb: readonly number[];
  readonly probe: boolean;
  readonly simulator: { readonly profile: string | null; readonly repaired: boolean; readonly footprintMb: number | null };
  readonly artifacts: {
    readonly frames: string;
    readonly video: string | null;
    readonly contactSheet: string | null;
    readonly steps: string;
    readonly replayScript: string;
  };
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.step - b.step);
}

export function worstSeverity(findings: readonly Finding[]): Severity | null {
  return sortFindings(findings)[0]?.severity ?? null;
}

/** True when any finding is at least as severe as `threshold`. */
export function failsAt(findings: readonly Finding[], threshold: Severity): boolean {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  return findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= limit);
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport(r: RunReport): string {
  const findings = sortFindings(r.findings);
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const stepAt = new Map(r.steps.map((s) => [s.step, s.atMs]));
  const avg = r.steps.length > 0 ? Math.round(r.steps.reduce((sum, s) => sum + s.ms, 0) / r.steps.length) : 0;
  const lines = [
    `# Playtest: ${r.scenario}`,
    "",
    `**${r.outcome}**${r.note ? `: ${r.note}` : ""}`,
    "",
    ...(r.summary ? [r.summary, ""] : []),
    `| | |`,
    `| --- | --- |`,
    `| App | \`${r.app}\` on ${r.device.name ?? r.device.id ?? "unknown device"} |`,
    `| Goal | ${cell(r.goal)} |`,
    `| Mode | ${r.mode}${r.probe ? ", game probe connected" : ""} |`,
    `| Steps | ${r.steps.length} in ${clock(r.durationMs)} (average action ${avg} ms) |`,
    `| Screens | ${r.screens.thisRun} this run, ${r.screens.new} new; ${r.screens.knownTotal} known over ${r.memoryRuns} run(s) |`,
    `| Options | ${r.coverage.optionsTried} tried of ${r.coverage.optionsSeen} seen |`,
    ...(r.memoryMb.length > 0 ? [`| App memory | ${r.memoryMb.join(" → ")} MB |`] : []),
    ...(r.simulator.footprintMb !== null ? [`| Simulator | ${r.simulator.footprintMb} MB${r.simulator.repaired ? " (re-slimmed before the run)" : ""} |`] : []),
    "",
    `## Findings (${findings.length}${counts.length > 0 ? `: ${counts.map(([s, n]) => `${n} ${s}`).join(", ")}` : ""})`,
    "",
  ];
  if (findings.length === 0) lines.push("None.", "");
  for (const f of findings) {
    const at = stepAt.get(f.step);
    const where = [`step ${f.step}`, ...(at !== undefined && r.artifacts.video ? [`video ${clock(at)}`] : []), ...(f.frame ? [`[frame](frames/${f.frame})`] : [])];
    lines.push(`- **${f.severity}** \`${f.kind}\` (${where.join(", ")}): ${f.message}`);
    const detail = f.evidence["detail"] ?? f.evidence["report"];
    if (typeof detail === "string") lines.push(`  - ${cell(detail.split("\n").slice(0, 3).join(" / ")).slice(0, 300)}`);
  }
  if (findings.length > 0) {
    lines.push("", `Reproduce: \`playpilot replay <this folder> --to-step <step>\`. Keep a fix from regressing: \`playpilot promote <this folder> --to-step <step> --out playpilot/regressions/<name>.json\`.`, "");
  }
  lines.push(
    "## Evidence",
    "",
    ...(r.artifacts.contactSheet ? [`![Contact sheet](${r.artifacts.contactSheet})`, ""] : []),
    `- Frames: \`${r.artifacts.frames}\` (one per step, in screen points)`,
    ...(r.artifacts.video ? [`- Video: \`${r.artifacts.video}\``] : []),
    `- Replay: \`${r.artifacts.steps}\` (playpilot replay) and \`${r.artifacts.replayScript}\` (agent-device replay)`,
    "",
    "## Steps",
    "",
    "| # | Screen | Option | Result | ms |",
    "| --- | --- | --- | --- | --- |",
    ...r.steps.map(
      (s) => `| ${s.step} | ${s.screen} | ${cell(s.option)} | ${s.ok ? (s.changed === undefined ? "ok" : s.changed ? "moved" : "no change") : `failed${s.note ? `: ${cell(s.note).slice(0, 80)}` : ""}`} | ${s.ms} |`,
    ),
    "",
  );
  return lines.join("\n");
}

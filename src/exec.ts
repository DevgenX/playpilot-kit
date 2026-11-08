import { spawn } from "node:child_process";

/** The result of one external command. */
export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** Extra environment variables for this command only. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs one external program. Injected everywhere so tests and dry runs never touch a device. */
export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 120_000;
/** Exit code reported when a command was killed for running past its timeout (same as coreutils `timeout`). */
export const TIMEOUT_CODE = 124;
/** Exit code reported when the program could not be started at all (same as a shell's "command not found"). */
export const NOT_FOUND_CODE = 127;

/** The real executor: spawns the program without a shell, so arguments are never re-parsed. */
export const spawnExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: Error) => resolve({ code: NOT_FOUND_CODE, stdout, stderr: stderr + error.message }));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code: code ?? (signal ? TIMEOUT_CODE : 1), stdout, stderr }),
    );
  });

/** One command a dry run would have executed. */
export interface PlannedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** An executor that records commands and answers every one with success and empty output. */
export function recordingExec(log: PlannedCommand[]): Exec {
  return async (command, args) => {
    log.push({ command, args: [...args] });
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** Thrown when a required command fails; carries the command line for the report. */
export class CommandError extends Error {
  constructor(
    readonly commandLine: string,
    readonly result: ExecResult,
    detail?: string,
  ) {
    super(`${commandLine} exited ${result.code}: ${(detail ?? (result.stderr.trim() || result.stdout.trim())).slice(0, 500)}`);
    this.name = "CommandError";
  }
}

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map((a) => (/^[\w@./:=,+-]+$/.test(a) ? a : JSON.stringify(a)))].join(" ");
}

/** Runs a command and throws a CommandError when it exits non-zero. */
export async function must(exec: Exec, command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
  const result = await exec(command, args, options);
  if (result.code !== 0) throw new CommandError(formatCommand(command, args), result);
  return result;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Narrows unknown JSON to a plain object, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDevice } from "./adapters/agentDevice.js";
import { AdbTransport, LocalTransport, ProbeChannel } from "./adapters/probe.js";
import { Simctl } from "./adapters/simctl.js";
import { Simslim } from "./adapters/simslim.js";
import type { Exec } from "./exec.js";
import { BlankScreenDetector, finding, memoryGrowth, newCrashReports, probeFindings, scanLog, slowStep, SoftlockDetector } from "./harness/detectors.js";
import { bytesFeatures, decodePng, encodePng, frameFeatures, resize, thumbChange, VISIBLE_CHANGE, type FrameFeatures } from "./harness/image.js";
import { GameMemory } from "./harness/memory.js";
import { deriveOptions, isRisky } from "./harness/options.js";
import type { DeviceAction, Finding, GameOption, Observation, ProbeState, UiNode, Viewport } from "./harness/types.js";
import { renderReport, type RunReport, type StepRecord } from "./report.js";
import { replayScript } from "./replay.js";
import { absolutize, parseScenario, type Scenario } from "./scenario.js";

export interface PlaytestDeps {
  readonly exec: Exec;
  readonly outDir: string;
  readonly memoryDir: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Where the OS writes crash reports (tests point this at a temp folder). */
  readonly crashReportDir?: string;
}

/** One option as the agent sees it: a short id to act on, and what is known about it. */
export interface OptionView {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly source: GameOption["source"];
  readonly tried: number;
  readonly risky: boolean;
}

export interface ObservationView {
  readonly step: number;
  readonly screen: { readonly id: string; readonly isNew: boolean; readonly visits: number; readonly scene?: string; readonly name?: string };
  /** Frame in screen points: a pixel at (x, y) in this image is a tap at (x, y). */
  readonly frame: string;
  readonly viewport: Viewport;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly options: readonly OptionView[];
  readonly newFindings: readonly Finding[];
  readonly done: { readonly outcome: RunReport["outcome"]; readonly note: string } | null;
}

/** A replayable input: refs are swapped for the selector agent-device resolved them to. */
export type ReplayAction = Exclude<DeviceAction, { kind: "press"; ref: string } | { kind: "fill"; ref: string }>;

export interface ReplayStep {
  readonly step: number;
  readonly option: string;
  readonly actions: readonly ReplayAction[];
}

interface Pending {
  readonly screen: string;
  readonly option: string;
  readonly ok: boolean;
  readonly thumb: string | null;
  readonly grid: boolean;
}

/** Everything a session needs to continue in a later process (`playpilot agent act` runs once per step). */
interface SessionState {
  version: 1;
  /** An agent picks the steps: it sees the frame, so the dense fallback grid would only be noise. */
  agent: boolean;
  rawScenario: unknown;
  scenarioDir: string;
  session: string;
  startedAt: number;
  videoStartedAt: number | null;
  deviceId: string | null;
  deviceName: string | null;
  processName: string | null;
  logPath: string | null;
  logOffset: number;
  logSubsystem: string;
  logSeen: string[];
  crashReportsSeen: string[];
  probeWhere: string | null;
  probeCursor: { eventsOffset: number; commandCounter: number };
  step: number;
  steps: StepRecord[];
  replay: ReplayStep[];
  findings: Finding[];
  screensThisRun: string[];
  newScreens: number;
  optionsSeen: string[];
  memorySamplesKb: number[];
  memoryGrowthReported: boolean;
  pending: Pending | null;
  /** Step of the latest observation (its frame is the freshest evidence). */
  observedStep: number | null;
  last: { screen: string; thumb: string | null; nodes: UiNode[]; viewport: Viewport; options: GameOption[]; probe: ProbeState | null } | null;
  softlock: unknown;
  blank: unknown;
  simulator: RunReport["simulator"];
  finished: boolean;
}

const SESSION_FILE = "session.json";

export class Playtest {
  private readonly device: AgentDevice;
  private readonly simctl: Simctl;
  private readonly softlock: SoftlockDetector;
  private readonly blank = new BlankScreenDetector();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private probe: ProbeChannel | null = null;

  private constructor(
    readonly scenario: Scenario,
    private readonly deps: PlaytestDeps,
    private readonly memory: GameMemory,
    private readonly s: SessionState,
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.simctl = new Simctl(deps.exec);
    this.softlock = new SoftlockDetector(scenario.softlockActions);
    this.softlock.restore(s.softlock);
    this.blank.restore(s.blank);
    this.device = new AgentDevice(deps.exec, {
      app: scenario.app,
      session: s.session,
      platform: scenario.platform,
      ...(s.deviceId && scenario.platform === "ios" ? { udid: s.deviceId } : scenario.device.udid ? { udid: scenario.device.udid } : {}),
      ...(scenario.device.serial ? { serial: scenario.device.serial } : {}),
      ...(scenario.appEventUrl ? { appEventUrl: scenario.appEventUrl } : {}),
      launchArgs: scenario.launchArgs,
    });
    if (s.probeWhere !== null) {
      this.probe = new ProbeChannel(
        scenario.platform === "android" ? new AdbTransport(deps.exec, scenario.app, s.deviceId ?? scenario.device.serial) : new LocalTransport(s.probeWhere),
      );
      this.probe.cursor = s.probeCursor;
    }
  }

  get outDir(): string {
    return this.deps.outDir;
  }

  get findings(): readonly Finding[] {
    return this.s.findings;
  }

  get stepCount(): number {
    return this.s.step;
  }

  get finished(): boolean {
    return this.s.finished;
  }

  /** Options from the latest observation, as the decider sees them. */
  get options(): readonly GameOption[] {
    return this.s.last?.options ?? [];
  }

  get currentScreen(): string | null {
    return this.s.last?.screen ?? null;
  }

  get memoryView(): GameMemory {
    return this.memory;
  }

  /**
   * Prepares the simulator, cold-launches the game and starts the evidence streams (log, video, probe).
   * `rawScenario` is kept in the run folder so the run can be replayed exactly.
   */
  static async start(givenScenario: unknown, scenarioDir: string, deps: PlaytestDeps, agent = false): Promise<Playtest> {
    const rawScenario = absolutize(givenScenario, scenarioDir);
    const scenario = parseScenario(rawScenario, scenarioDir);
    await mkdir(join(deps.outDir, "frames"), { recursive: true });
    const now = deps.now ?? Date.now;
    const memory = await GameMemory.load(join(deps.memoryDir, `${scenario.app}.json`));
    const state: SessionState = {
      version: 1,
      agent,
      rawScenario,
      scenarioDir,
      session: `playpilot-${scenario.name.replace(/[^\w-]+/g, "-").slice(0, 40)}`,
      startedAt: now(),
      videoStartedAt: null,
      deviceId: null,
      deviceName: null,
      processName: null,
      logPath: null,
      logOffset: 0,
      logSubsystem: "",
      logSeen: [],
      crashReportsSeen: [],
      probeWhere: null,
      probeCursor: { eventsOffset: 0, commandCounter: 0 },
      step: 0,
      steps: [],
      replay: [],
      findings: [],
      screensThisRun: [],
      newScreens: 0,
      optionsSeen: [],
      memorySamplesKb: [],
      memoryGrowthReported: false,
      pending: null,
      observedStep: null,
      last: null,
      softlock: null,
      blank: null,
      simulator: { profile: scenario.simslim?.profile ?? null, repaired: false, footprintMb: null },
      finished: false,
    };
    await writeFile(join(deps.outDir, "scenario.json"), JSON.stringify(rawScenario, null, 2) + "\n", "utf8");

    if (scenario.simslim !== null && scenario.platform === "ios") {
      const udid = scenario.device.udid;
      if (udid === undefined) throw new Error("simslim slims one simulator by UDID: set device.udid in the scenario or pass --udid <udid>");
      const simslim = new Simslim(deps.exec);
      state.simulator = { ...state.simulator, repaired: await simslim.ensure(udid, scenario.simslim.profile) };
      if (scenario.simslim.requires.length > 0) {
        const doctor = await simslim.doctor(udid, scenario.simslim.requires);
        if (!doctor.ok) throw new Error(`simslim doctor: features this game needs are switched off (${scenario.simslim.requires.join(", ")}). ${doctor.output.slice(0, 300)}`);
      }
      state.simulator = { ...state.simulator, footprintMb: (await simslim.measure(udid)).megabytes };
    }

    const playtest = new Playtest(scenario, deps, memory, state);
    await playtest.boot();
    return playtest;
  }

  private async boot(): Promise<void> {
    const s = this.s;
    const opened = await this.device.open(this.scenario.relaunch);
    s.deviceId = opened.deviceId;
    s.deviceName = opened.deviceName;
    s.logPath = await this.device.logsRestart().catch(() => null);
    if (this.scenario.video) {
      try {
        await this.device.recordStart(join(this.deps.outDir, "run.mp4"));
        s.videoStartedAt = this.now();
      } catch (error: unknown) {
        this.add(finding("command_failed", 0, `Screen recording could not start: ${message(error)}`));
      }
    }
    try {
      const sample = await this.device.memorySample();
      s.processName = sample.process;
      if (sample.residentKb !== null) s.memorySamplesKb.push(sample.residentKb);
    } catch {
      // memory sampling is optional evidence
    }
    if (this.scenario.probe === "auto") await this.findProbe();
    // splash and loading screens: give the game a moment before the first look
    if (this.scenario.launchWaitMs > 0) await this.sleep(this.scenario.launchWaitMs);
    await this.save();
  }

  private async findProbe(): Promise<void> {
    const s = this.s;
    if (this.scenario.platform === "ios" && s.deviceId) {
      const container = await this.simctl.dataContainer(s.deviceId, this.scenario.app);
      if (container !== null) {
        const transport = new LocalTransport(join(container, "Documents", "playpilot"));
        // The probe deletes stale commands at startup; a fresh launch may not have written state.json yet.
        for (let i = 0; i < 10 && !(await transport.exists()); i += 1) await this.sleep(300);
        if (await transport.exists()) {
          this.probe = new ProbeChannel(transport);
          s.probeWhere = transport.where;
        }
      }
    } else if (this.scenario.platform === "android") {
      const transport = new AdbTransport(this.deps.exec, this.scenario.app, s.deviceId ?? this.scenario.device.serial);
      if ((await transport.read("state.json")) !== null) {
        this.probe = new ProbeChannel(transport);
        s.probeWhere = transport.where;
      }
    }
    if (this.probe) {
      await this.probe.events(); // skip anything logged before the run started
      s.probeCursor = this.probe.cursor;
    }
  }

  private add(f: Finding): void {
    this.s.findings.push(f);
  }

  /** Records a problem the agent saw (for example, art that failed to load). Uses the latest frame as evidence. */
  async note(text: string, severity: Finding["severity"] = "medium", step?: number): Promise<Finding> {
    const observed = this.s.observedStep ?? 0;
    const at = step === undefined ? observed : Math.min(Math.max(0, step), observed);
    // the frame after the step shows its result
    const f: Finding = { ...finding("agent", at, text, {}, frameName(Math.min(at + (step === undefined ? 0 : 1), observed))), severity };
    this.add(f);
    await this.save();
    return f;
  }

  /** Looks at the game: accessibility tree, frame, probe state, logs and crash reports, then lists the legal options. */
  async observe(): Promise<ObservationView> {
    const s = this.s;
    const step = s.step;
    const before = s.findings.length;
    const frame = join(this.deps.outDir, "frames", frameName(step));
    // what this observation finds was caused by the previous action; its frame shows the result
    const cause = Math.max(0, step - 1);
    const failures: Finding[] = [];

    if (this.probe) {
      for (let waited = 0; waited < 10_000 && (await this.probe.state())?.busy; waited += 250) await this.sleep(250);
    }
    const [snapshot, features, probeState] = await Promise.all([
      this.device.snapshot().catch((error: unknown) => {
        failures.push(finding("command_failed", cause, `Snapshot failed: ${message(error)}`));
        return { nodes: [] as UiNode[], viewport: null };
      }),
      this.captureFrame(frame).catch((error: unknown) => {
        failures.push(finding("command_failed", cause, `Screenshot failed: ${message(error)}`));
        return null;
      }),
      this.probe?.state() ?? Promise.resolve(null),
    ]);
    const viewport = snapshot.viewport ?? s.last?.viewport ?? { width: 0, height: 0 };
    const frameInfo = features ? await this.processFrame(frame, features, snapshot.viewport) : null;
    s.observedStep = step;
    const obs: Observation = {
      t: this.now(),
      nodes: snapshot.nodes,
      viewport,
      frameHash: frameInfo?.hash ?? null,
      blank: frameInfo?.blank ?? false,
      probe: probeState,
    };

    const screen = this.memory.resolve(obs.nodes, probeState, obs.frameHash);
    if (!s.screensThisRun.includes(screen.id)) s.screensThisRun.push(screen.id);
    if (screen.isNew) s.newScreens += 1;
    const pending = s.pending;
    const thumb = frameInfo?.thumb ?? null;
    let changed = true;
    if (pending) {
      changed = pending.screen !== screen.id || pending.thumb === null || thumb === null || thumbChange(pending.thumb, thumb) > VISIBLE_CHANGE;
      this.memory.record(pending.screen, pending.option, pending.ok, changed);
      const last = s.steps[s.steps.length - 1];
      if (last && last.step === step - 1) s.steps[s.steps.length - 1] = { ...last, changed };
      s.pending = null;
    }

    const frameRef = frameName(step);
    const stuck = pending ? this.softlock.observe(changed, screen.id, cause, pending.option, pending.grid, frameRef) : null;
    if (stuck) this.add(stuck);
    const blank = this.blank.observe(obs.blank, cause, frameRef);
    if (blank) this.add(blank);
    await this.collectEvidence(cause, frameRef, before, failures.length > 0);
    // a dead app also fails its snapshot; the crash already says everything
    if (!s.findings.slice(before).some((f) => f.kind === "crash")) for (const f of failures) this.add(f);

    let options = deriveOptions(this.scenario, obs);
    const coarse = options.filter((o) => o.source === "grid");
    if (!s.agent && coarse.length > 0 && coarse.every((o) => this.memory.timesTried(screen.id, o.name) > 0)) {
      options = deriveOptions(this.scenario, obs, true);
    }
    for (const o of options) if (!s.optionsSeen.includes(`${screen.id}/${o.name}`)) s.optionsSeen.push(`${screen.id}/${o.name}`);
    s.last = { screen: screen.id, thumb, nodes: [...obs.nodes], viewport, options, probe: probeState };

    const done = this.status(obs, step);
    await this.save();
    return {
      step,
      screen: {
        id: screen.id,
        isNew: screen.isNew,
        visits: screen.visits,
        ...(probeState?.scene ? { scene: probeState.scene } : {}),
        ...(probeState?.screen ? { name: probeState.screen } : {}),
      },
      frame,
      viewport,
      facts: probeState?.facts ?? {},
      options: options.map((o, i) => ({
        id: i + 1,
        name: o.name,
        description: o.description,
        source: o.source,
        tried: this.memory.timesTried(screen.id, o.name),
        risky: isRisky(this.scenario, o),
      })),
      newFindings: s.findings.slice(before),
      done,
    };
  }

  /** A full-resolution simulator screenshot is fastest through simctl; everything else goes through agent-device. */
  private async captureFrame(path: string): Promise<Uint8Array> {
    const udid = this.s.deviceId;
    if (this.scenario.platform === "ios" && udid && /^[0-9A-F-]{36}$/i.test(udid)) {
      try {
        await this.simctl.screenshot(udid, path);
        return await readFile(path);
      } catch {
        // a physical device, or simctl is unavailable: fall through
      }
    }
    await this.device.screenshot(path);
    return readFile(path);
  }

  /**
   * Hashes the frame and shrinks a retina capture to screen points, so frame pixels and tap coordinates are the
   * same numbers for whoever looks at it.
   */
  private async processFrame(path: string, bytes: Uint8Array, viewport: Viewport | null): Promise<FrameFeatures> {
    let image;
    try {
      image = decodePng(bytes);
    } catch {
      return bytesFeatures(bytes);
    }
    // skip while the capture and the viewport disagree on orientation (mid-rotation)
    const sameOrientation = viewport !== null && image.width > image.height === viewport.width > viewport.height;
    if (viewport === null || !sameOrientation || image.width <= viewport.width * 1.05) return frameFeatures(image);
    const small = resize(image, viewport.width, viewport.height);
    await writeFile(path, encodePng(small));
    return frameFeatures(small);
  }

  /** Collects log, probe, crash-report and memory evidence; `since` marks this observation's first finding. */
  private async collectEvidence(step: number, frame: string, since: number, unreachable = false): Promise<void> {
    const s = this.s;
    // one crash, one finding: later evidence of the same crash is attached to the first
    const addCrash = (f: Finding): void => {
      const index = s.findings.findIndex((x, i) => i >= since && x.kind === "crash");
      const existing = s.findings[index];
      if (existing) s.findings[index] = { ...existing, evidence: { ...existing.evidence, ...f.evidence, also: f.message } };
      else this.add(f);
    };
    if (this.probe) {
      for (const f of probeFindings(await this.probe.events().catch(() => []), step, frame)) this.add(f);
      s.probeCursor = this.probe.cursor;
    }
    if (s.logPath) {
      try {
        const text = await readFile(s.logPath, "utf8");
        if (text.length < s.logOffset) s.logOffset = 0;
        const seen = new Set(s.logSeen);
        const scan = scanLog(text.slice(s.logOffset), step, seen, s.logSubsystem);
        s.logOffset = text.length;
        s.logSubsystem = scan.subsystem;
        s.logSeen = [...seen].slice(-500);
        for (const f of scan.findings) (f.kind === "crash" ? addCrash : this.add.bind(this))({ ...f, frame });
      } catch {
        // the log may not exist yet
      }
    }
    if (s.processName) {
      const reports = await newCrashReports(s.processName, s.startedAt, this.deps.crashReportDir);
      for (const report of reports.filter((r) => !s.crashReportsSeen.includes(r))) {
        s.crashReportsSeen.push(report);
        addCrash(finding("crash", step, `The OS wrote a crash report for ${s.processName}`, { report }, frame));
      }
    }
    const every = this.scenario.memoryEvery;
    if (every > 0 && step > 0 && step % every === 0) {
      try {
        const sample = await this.device.memorySample();
        // a missed sample alone is not a crash; together with a failed snapshot it is
        if (!sample.available && unreachable) {
          addCrash(finding("crash", step, "The app is no longer running", { source: "memory sample" }, frame));
        } else if (sample.residentKb !== null) {
          s.memorySamplesKb.push(sample.residentKb);
          const grew = s.memoryGrowthReported ? null : memoryGrowth(s.memorySamplesKb, step);
          if (grew) {
            s.memoryGrowthReported = true;
            this.add(grew);
          }
        }
      } catch {
        // optional evidence
      }
    }
  }

  private status(obs: Observation, step: number): ObservationView["done"] {
    const { success, maxSteps, maxMinutes } = this.scenario;
    if (this.s.findings.some((f) => f.kind === "crash")) return { outcome: "not_achieved", note: "the game crashed" };
    if (success.label !== undefined) {
      const label = success.label;
      if (obs.nodes.some((n) => n.label.includes(label)) || obs.probe?.targets.some((t) => t.label.includes(label))) {
        return { outcome: "achieved", note: `saw "${label}"` };
      }
    }
    if (success.screen !== undefined && obs.probe?.screen === success.screen) return { outcome: "achieved", note: `reached screen "${success.screen}"` };
    const hasGoal = success.label !== undefined || success.screen !== undefined;
    if (step >= maxSteps) return { outcome: hasGoal ? "not_achieved" : "explored", note: `step budget (${maxSteps}) used` };
    if (this.now() - this.s.startedAt > maxMinutes * 60_000) return { outcome: hasGoal ? "not_achieved" : "explored", note: `time budget (${maxMinutes} min) used` };
    return null;
  }

  /** Performs one option. Inputs go to agent-device (batched when possible); game actions go to the probe. */
  async act(option: GameOption): Promise<StepRecord> {
    const s = this.s;
    const step = s.step;
    const screen = s.last?.screen ?? "unknown";
    const started = this.now();
    const replay: ReplayAction[] = [];
    let ok = true;
    let note = "";
    try {
      let batch: DeviceAction[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const results = await this.device.act(batch);
        batch.forEach((a, i) => replay.push(this.replayable(a, results[i]?.selector ?? null)));
        batch = [];
      };
      for (const action of option.actions) {
        if (action.kind !== "game") {
          batch.push(action);
          continue;
        }
        await flush();
        if (!this.probe) throw new Error(`"${action.action}" needs the game probe, and none is running`);
        const result = await this.probe.run(action.action, action.args, this.sleep, this.now);
        replay.push(action);
        note = result.message;
        if (!result.ok) throw new Error(`game action "${action.action}" failed: ${result.message}`);
      }
      await flush();
    } catch (error: unknown) {
      ok = false;
      note = message(error);
      this.add(finding("command_failed", step, note, { option: option.name }, frameName(step)));
    }
    const ms = this.now() - started;
    const slow = slowStep(ms, this.scenario.slowStepMs, step, option.name);
    if (slow) this.add({ ...slow, frame: frameName(step) });
    const record: StepRecord = {
      step,
      screen,
      option: option.name,
      source: option.source,
      ok,
      ms,
      atMs: started - (s.videoStartedAt ?? s.startedAt),
      ...(note ? { note: note.slice(0, 200) } : {}),
    };
    s.steps.push(record);
    s.replay.push({ step, option: option.name, actions: replay });
    s.pending = { screen, option: option.name, ok, thumb: s.last?.thumb ?? null, grid: option.source === "grid" || option.source === "fine" };
    s.step += 1;
    if (this.scenario.settleMs > 0) await this.sleep(this.scenario.settleMs);
    await this.save();
    return record;
  }

  /** Swaps a ref (valid for one snapshot only) for its resolved selector, or the centre of its last known rect. */
  private replayable(action: DeviceAction, selector: string | null): ReplayAction {
    if ((action.kind === "press" || action.kind === "fill") && "ref" in action) {
      if (selector !== null) return action.kind === "press" ? { kind: "press", selector } : { kind: "fill", selector, text: action.text };
      const rect = this.s.last?.nodes.find((n) => n.ref === action.ref)?.rect;
      if (rect) return { kind: "tap", at: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
      return { kind: "wait", ms: 0 };
    }
    return action as ReplayAction;
  }

  /** Stops the streams, closes the app and writes report.md, report.json, steps.json and replay.ad. */
  async finish(outcome: RunReport["outcome"], note: string, summary = ""): Promise<RunReport> {
    const s = this.s;
    if (s.pending) {
      this.memory.record(s.pending.screen, s.pending.option, s.pending.ok, false);
      s.pending = null;
    }
    const video = join(this.deps.outDir, "run.mp4");
    const sheet = join(this.deps.outDir, "contact-sheet.png");
    let hasVideo = false;
    let hasSheet = false;
    if (s.videoStartedAt !== null) {
      await this.device.recordStop().catch(() => undefined);
      hasVideo = await exists(video);
      if (hasVideo) hasSheet = await this.device.contactSheet(video, sheet).then(() => exists(sheet), () => false);
    }
    await this.collectEvidence(Math.max(0, s.step - 1), frameName(s.observedStep ?? 0), s.findings.length);
    await this.device.close();
    if (s.findings.length > 0) this.memory.note(`${new Date(this.now()).toISOString()}: ${s.findings.length} finding(s) in "${this.scenario.name}"`);
    await this.memory.save(true);

    const report: RunReport = {
      scenario: this.scenario.name,
      app: this.scenario.app,
      mode: s.agent ? "agent" : this.scenario.mode,
      goal: this.scenario.goal,
      outcome,
      note,
      summary,
      startedAt: new Date(s.startedAt).toISOString(),
      durationMs: this.now() - s.startedAt,
      device: { id: s.deviceId, name: s.deviceName },
      steps: s.steps,
      findings: s.findings,
      screens: { thisRun: s.screensThisRun.length, new: s.newScreens, knownTotal: this.memory.screenCount },
      coverage: { optionsSeen: s.optionsSeen.length, optionsTried: new Set(s.steps.map((st) => `${st.screen}/${st.option}`)).size },
      memoryRuns: this.memory.runs,
      memoryMb: s.memorySamplesKb.map((kb) => Math.round(kb / 1024)),
      probe: s.probeWhere !== null,
      simulator: s.simulator,
      artifacts: {
        frames: "frames/",
        video: hasVideo ? "run.mp4" : null,
        contactSheet: hasSheet ? "contact-sheet.png" : null,
        steps: "steps.json",
        replayScript: "replay.ad",
      },
    };
    s.finished = true;
    await writeFile(join(this.deps.outDir, "steps.json"), JSON.stringify({ version: 1, scenario: s.rawScenario, steps: s.replay }, null, 2) + "\n", "utf8");
    await writeFile(join(this.deps.outDir, "replay.ad"), replayScript(this.scenario, s.replay), "utf8");
    await writeFile(join(this.deps.outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    await writeFile(join(this.deps.outDir, "report.md"), renderReport(report), "utf8");
    await this.save();
    return report;
  }

  private async save(): Promise<void> {
    this.s.softlock = this.softlock.toJSON();
    this.s.blank = this.blank.toJSON();
    await writeFile(join(this.deps.outDir, SESSION_FILE), JSON.stringify(this.s), "utf8");
    await this.memory.save(false);
  }

  /** Picks a session back up in a new process (the device session lives on in the agent-device daemon). */
  static async resume(deps: PlaytestDeps): Promise<Playtest> {
    let state: SessionState;
    try {
      state = JSON.parse(await readFile(join(deps.outDir, SESSION_FILE), "utf8")) as SessionState;
    } catch {
      throw new Error(`no playtest session in ${deps.outDir} (start one with: playpilot agent start <scenario.json>)`);
    }
    if (state.version !== 1) throw new Error(`session file version ${String(state.version)} is not supported`);
    const scenario = parseScenario(state.rawScenario, state.scenarioDir);
    const memory = await GameMemory.load(join(deps.memoryDir, `${scenario.app}.json`));
    return new Playtest(scenario, deps, memory, state);
  }

}

export function frameName(step: number): string {
  return `step-${String(step).padStart(3, "0")}.png`;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

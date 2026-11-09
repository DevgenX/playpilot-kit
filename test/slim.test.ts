import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FULL_SLIM, missingRequirements, offLabels, parseDisabled, parseProfile, parseTopMem, SlimProfileError, Slimmer } from "../src/adapters/slim.js";
import type { Exec } from "../src/exec.js";
import { ALL_LABELS, CATEGORIES } from "../src/slim/catalog.js";
import { parseScenario, ScenarioError } from "../src/scenario.js";
import { FakeSimulator } from "./fakeSim.js";

const UDID = "11111111-2222-3333-4444-555555555555";

function rig(options: { booted?: boolean; disabled?: readonly string[] } = {}): { sim: FakeSimulator; slimmer: Slimmer; calls: string[][] } {
  const sim = new FakeSimulator(UDID, options);
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    return sim.handle(command, args) ?? { code: 127, stdout: "", stderr: "not found" };
  };
  return { sim, slimmer: new Slimmer(exec), calls };
}

const storeLabels = CATEGORIES.find((c) => c.id === "store")?.labels ?? [];

describe("slim catalog", () => {
  it("has unique, well-formed labels and never the services that break a simulator", () => {
    const all = CATEGORIES.flatMap((c) => c.labels);
    assert.equal(new Set(all).size, all.length, "a service is listed twice");
    for (const label of all) assert.match(label, /^com\.apple\.[A-Za-z0-9_.-]+$/);
    assert.ok(!ALL_LABELS.has("com.apple.nanoregistryd"), "nanoregistryd hangs app launches when off");
    for (const kept of ["com.apple.gamed", "com.apple.GameController.gamecontrollerd", "com.apple.gamesaved", "com.apple.SpringBoard", "com.apple.backboardd", "com.apple.mobile.installd", "com.apple.cloudd", "com.apple.sharingd"]) {
      assert.ok(!ALL_LABELS.has(kept), `${kept} must stay on`);
    }
  });
});

describe("slim profiles", () => {
  it("switches off every category except the kept ones and kept services", () => {
    const profile = parseProfile({ name: "iap", except: ["store"], keep: ["com.apple.tipsd"] });
    const off = offLabels(profile);
    assert.ok(!storeLabels.some((l) => off.has(l)));
    assert.ok(!off.has("com.apple.tipsd"));
    assert.ok(off.has("com.apple.searchd"));
    assert.equal(offLabels(FULL_SLIM).size, ALL_LABELS.size);
  });

  it("rejects unknown categories, fields and malformed labels", () => {
    assert.throws(() => parseProfile({ except: ["stores"] }), (e: unknown) => e instanceof SlimProfileError && /unknown categor.*stores.*known: widgets/.test(e.message));
    assert.throws(() => parseProfile({ exept: ["store"] }), /unknown field\(s\) exept/);
    assert.throws(() => parseProfile({ keep: ["com.apple.a com.apple.b"] }), /not a service label/);
  });

  it("names the categories a scenario needs that the profile switches off", () => {
    assert.deepEqual(missingRequirements(parseProfile({ except: ["store"] }), ["store", "icloud"]), ["icloud"]);
    assert.equal(parseScenario({ name: "x", app: "a", slim: { requires: ["store"] } }).slim?.requires[0], "store");
    assert.throws(() => parseScenario({ name: "x", app: "a", slim: { requires: ["storekit"] } }), (e: unknown) => e instanceof ScenarioError && /storekit/.test(e.message));
  });

  it("parses launchctl and top output", () => {
    const disabled = parseDisabled('\tdisabled services = {\n\t\t"com.apple.a" => disabled\n\t\t"com.apple.b" => enabled\n\t\t"com.apple.c" => true\n\t}\n');
    assert.deepEqual([...disabled].sort(), ["com.apple.a", "com.apple.c"]);
    assert.equal(parseTopMem("1024K"), 1);
    assert.equal(parseTopMem("12M+"), 12);
    assert.equal(parseTopMem("1.5G-"), 1536);
    assert.equal(parseTopMem("n/a"), null);
  });
});

describe("Slimmer", () => {
  it("slims a stock simulator with one reboot, then leaves a slim one alone", async () => {
    const { sim, slimmer } = rig();
    assert.equal(await slimmer.ensure(UDID, FULL_SLIM), true);
    assert.equal(sim.boots, 1, "one reboot");
    assert.equal(sim.disabled.size, ALL_LABELS.size);
    assert.equal(await slimmer.ensure(UDID, FULL_SLIM), false);
    assert.equal(sim.boots, 1, "no reboot when nothing changed");
  });

  it("boots a shut-down simulator first, and applies only the difference", async () => {
    const { sim, slimmer, calls } = rig({ booted: false, disabled: [...ALL_LABELS] });
    const iap = parseProfile({ except: ["store"] });
    const drift = await slimmer.verify(UDID, iap);
    assert.deepEqual(drift.missing, []);
    assert.deepEqual([...drift.extra].sort(), [...storeLabels].sort());
    const before = calls.length;
    assert.equal(await slimmer.ensure(UDID, iap), true);
    const toggles = calls.slice(before).filter((c) => c.includes("enable") || c.includes("disable"));
    assert.equal(toggles.length, storeLabels.length, "only the store services were switched");
    assert.ok(storeLabels.every((l) => !sim.disabled.has(l)));
  });

  it("leaves services outside the catalog alone", async () => {
    const { sim, slimmer } = rig({ disabled: ["com.example.custom"] });
    await slimmer.ensure(UDID, FULL_SLIM);
    assert.ok(sim.disabled.has("com.example.custom"));
    assert.equal(await slimmer.restore(UDID), true);
    assert.deepEqual([...sim.disabled], ["com.example.custom"]);
  });

  it("reports services it could not switch", async () => {
    const { sim, slimmer } = rig();
    sim.failLabels.add("com.apple.tipsd");
    await assert.rejects(slimmer.ensure(UDID, FULL_SLIM), /launchctl disable failed for com\.apple\.tipsd/);
  });

  it("measures only this simulator's processes", async () => {
    const { sim, slimmer } = rig();
    const stock = await slimmer.measure(UDID);
    assert.deepEqual(stock, { processes: 230, megabytes: 1 + 229 * 20 });
    await slimmer.ensure(UDID, FULL_SLIM);
    const slim = await slimmer.measure(UDID);
    assert.equal(slim.processes, sim.processCount);
    assert.ok((slim.processes ?? 0) < (stock.processes ?? 0));
  });

  it("fails clearly for an unknown simulator", async () => {
    const { slimmer } = rig();
    await assert.rejects(slimmer.ensure("AAAAAAAA-0000-0000-0000-000000000000", FULL_SLIM), /no simulator with UDID/);
  });
});

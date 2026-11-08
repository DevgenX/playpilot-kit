import type { Scenario } from "../scenario.js";
import type { GameOption, Observation, UiNode } from "./types.js";

/** Accessibility types that are layout, not controls (or the keyboard, which `fill` handles). */
const NOT_CONTROLS = /^(Window|Other|ScrollView|CollectionView|Table|NavigationBar|Toolbar|TabBar|Keyboard|Key|Group|Map|WebView|StatusBar)$/i;

function controlNodes(nodes: readonly UiNode[], obs: Observation): UiNode[] {
  const screenArea = obs.viewport.width * obs.viewport.height;
  return nodes.filter((n) => {
    if (NOT_CONTROLS.test(n.type) && !(n.type.toLowerCase() === "other" && n.identifier !== "")) return false;
    if (n.label === "" && n.identifier === "") return false;
    // a "control" covering most of the screen is a container the runner reports as hittable
    return !(n.rect && screenArea > 0 && n.rect.width * n.rect.height > 0.85 * screenArea);
  });
}

/**
 * Every legal option on this screen: the probe's own targets and game actions, accessible controls, the
 * scenario's macros, and, only when the screen offers nothing else (a game canvas without a probe), a grid of taps.
 */
export function deriveOptions(scenario: Scenario, obs: Observation, fineGrid = false): GameOption[] {
  const options: GameOption[] = [];
  const names = new Set<string>();
  const add = (option: GameOption): void => {
    let name = option.name;
    for (let n = 2; names.has(name); n += 1) name = `${option.name} #${n}`;
    names.add(name);
    options.push({ ...option, name });
  };
  const { width, height } = obs.viewport;

  for (const t of obs.probe?.targets ?? []) {
    add({
      name: `ui:${t.label || t.id}`,
      description: `Tap the game's ${t.kind} "${t.label || t.id}"`,
      actions: [{ kind: "tap", at: { x: t.x * width, y: t.y * height } }],
      source: "probe",
    });
  }
  for (const a of obs.probe?.actions ?? []) {
    add({ name: `game:${a.id}`, description: a.description, actions: [{ kind: "game", action: a.id, args: {} }], source: "game" });
  }
  for (const n of controlNodes(obs.nodes, obs)) {
    const label = n.label || n.identifier;
    add({ name: `${n.type.toLowerCase()}:${label}`, description: `Press the ${n.type} "${label}"`, actions: [{ kind: "press", ref: n.ref }], source: "a11y" });
  }
  for (const custom of scenario.customOptions) {
    const { label, screen, scene } = custom.when;
    if (label !== undefined && !obs.nodes.some((n) => n.label.includes(label)) && !obs.probe?.targets.some((t) => t.label.includes(label))) continue;
    if (screen !== undefined && obs.probe?.screen !== screen) continue;
    if (scene !== undefined && obs.probe?.scene !== scene) continue;
    add({ name: custom.name, description: custom.description, actions: custom.actions, source: "custom" });
  }

  const nothingToPress = !options.some((o) => o.source === "probe" || o.source === "a11y");
  if ((scenario.canvas !== null || nothingToPress) && width > 0 && height > 0) {
    const grid = scenario.canvas ?? (width >= height ? { cols: 4, rows: 3, inset: 0.08 } : { cols: 3, rows: 4, inset: 0.08 });
    const left = grid.inset * width;
    const top = grid.inset * height;
    const cellW = (width - 2 * left) / grid.cols;
    const cellH = (height - 2 * top) / grid.rows;
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const at = { x: Math.round(left + (col + 0.5) * cellW), y: Math.round(top + (row + 0.5) * cellH) };
        add({ name: `grid:r${row + 1}c${col + 1}`, description: `Tap the screen at (${at.x}, ${at.y})`, actions: [{ kind: "tap", at }], source: "grid" });
      }
    }
    if (fineGrid) {
      // twice as dense and offset from the coarse points: reaches the small buttons a coarse grid misses
      const cols = grid.cols * 2;
      const rows = grid.rows * 2;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const at = { x: Math.round(left + ((col + 0.5) * cellW) / 2), y: Math.round(top + ((row + 0.5) * cellH) / 2) };
          add({ name: `fine:r${row + 1}c${col + 1}`, description: `Tap the screen at (${at.x}, ${at.y})`, actions: [{ kind: "tap", at }], source: "fine" });
        }
      }
    }
  }
  return options;
}

/** True when an option looks like a purchase, account change or data reset (see Scenario.avoid). */
export function isRisky(scenario: Scenario, option: GameOption): boolean {
  return scenario.avoid.some((pattern) => pattern.test(option.name) || pattern.test(option.description));
}

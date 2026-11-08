import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The templates folder ships next to dist/ in the package. */
export function templatesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

/**
 * Copies the starter scenarios into a game repo, with the app id filled in. Never overwrites a file unless
 * `force` is set. Returns the files written.
 */
export async function init(targetDir: string, app: string, force: boolean): Promise<{ written: string[]; skipped: string[] }> {
  const source = templatesDir();
  const written: string[] = [];
  const skipped: string[] = [];
  await mkdir(join(targetDir, "regressions"), { recursive: true });
  for (const name of (await readdir(source)).sort()) {
    const target = join(targetDir, name);
    if (!force && (await exists(target))) {
      skipped.push(target);
      continue;
    }
    const text = (await readFile(join(source, name), "utf8")).replaceAll("com.example.mygame", app);
    await writeFile(target, text, "utf8");
    written.push(target);
  }
  return { written, skipped };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

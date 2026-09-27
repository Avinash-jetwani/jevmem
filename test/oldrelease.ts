/**
 * The real jevmem 0.5.7, for tests that check main against the CLI on npm: its plugin folder, and its CLI built from the
 * v0.5.7 tag once and cached under node_modules/.cache (or the CLI from JEVMEM_OLD_CLI, a 0.5.7 dist/cli.js such as one
 * unpacked from npm). Null without the tag (git fetch --tags).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OLD_TAG = "v0.5.7";
const TAG = OLD_TAG;

/** The v0.5.7 release: its plugin folder, and its CLI built from the tag (or JEVMEM_OLD_CLI). Null without the tag. */
export function oldRelease(): { cli: string; plugin: string } | null {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", "-q", `${TAG}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const dir = path.resolve("node_modules", ".cache", `jevmem-${TAG}-${sha.slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, "dist", "cli.js"))) {
    const work = `${dir}.${process.pid}.tmp`;
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const tar = execFileSync("git", ["archive", "--format=tar", TAG, "src", "plugin", "hooks", "package.json", "tsconfig.json", "tsup.config.ts"], { maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", work], { input: tar });
    fs.symlinkSync(path.resolve("node_modules"), path.join(work, "node_modules"));
    try {
      execFileSync(path.resolve("node_modules", ".bin", "tsup"), [], { cwd: work, stdio: "pipe" });
    } catch (err) {
      throw new Error(`could not build jevmem ${TAG} from the tag (set JEVMEM_OLD_CLI to a ${TAG.slice(1)} dist/cli.js instead): ${String((err as { stderr?: unknown }).stderr ?? err).slice(0, 500)}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(work, dir);
  }
  return { cli: process.env.JEVMEM_OLD_CLI ? path.resolve(process.env.JEVMEM_OLD_CLI) : path.join(dir, "dist", "cli.js"), plugin: path.join(dir, "plugin") };
}


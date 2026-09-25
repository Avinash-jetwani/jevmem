import fs from "node:fs";

/** The package version, read from package.json next to dist/ (or src/ in tests). */
export const PACKAGE_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

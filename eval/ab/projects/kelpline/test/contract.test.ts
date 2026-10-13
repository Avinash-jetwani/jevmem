import fs from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ERROR_CODES } from "../src/errors.js";
import { makeTestApp } from "./helpers.js";

/** Every route the app registers is in api/openapi.yaml, and every error code is in its Error schema. */
describe("api/openapi.yaml", () => {
  const spec = YAML.parse(fs.readFileSync("api/openapi.yaml", "utf8"));
  const paths = Object.keys(spec.paths).map((p) => p.replace(/\{(\w+)\}/g, ":$1"));

  it("lists every route", async () => {
    const { app } = makeTestApp();
    const routes = new Set<string>();
    app.addHook("onRoute", (r) => void routes.add(r.url));
    await app.ready();
    for (const url of routes) expect(paths, url).toContain(url);
  });

  it("lists every error code", () => {
    const codes: string[] = spec.components.schemas.Error.properties.error.properties.code.enum;
    for (const c of Object.keys(ERROR_CODES)) expect(codes).toContain(c);
  });
});

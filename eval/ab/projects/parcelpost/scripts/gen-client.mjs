// Writes src/generated/client.ts from api/openapi.json.
import fs from "node:fs";

const spec = JSON.parse(fs.readFileSync(new URL("../api/openapi.json", import.meta.url), "utf8"));
const header = Object.values(spec.components.securitySchemes)[0].name;
const base = spec.servers[0].url;
const methods = Object.entries(spec.paths).map(([p, ops]) => {
  const op = ops.get;
  const url = p.replace(/\{(\w+)\}/g, (_, v) => "${encodeURIComponent(" + v + ")}");
  return `  /** ${op.summary} */
  ${op.operationId}(tracking: string): Promise<unknown> {
    return httpGet(\`\${this.baseUrl}${url}\`, { headers: { "${header}": this.apiKey } });
  }`;
});
const out = `import { httpGet } from "../lib/http.js";

export class CarrierClient {
  constructor(private apiKey: string, private baseUrl = "${base}") {}

${methods.join("\n\n")}
}
`;
fs.writeFileSync(new URL("../src/generated/client.ts", import.meta.url), out);
console.log("wrote src/generated/client.ts");

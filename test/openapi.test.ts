import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { openAPIDocument } from "../src/api-contract";

describe("exported response and parameter schemas", () => {
  test("nullable resource responses accept null", () => {
    const document = openAPIDocument();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(document, "contract");

    for (const [path, method, status] of [
      ["/v1/agents/{id}", "patch", "200"],
      ["/v1/agents/{id}/duplicate", "post", "201"],
      ["/v1/agents/{id}/memories/{memoryId}", "patch", "200"],
      ["/v1/memories/{id}", "patch", "200"],
      ["/v1/skills/{id}", "patch", "200"],
      ["/v1/schedules/{id}", "patch", "200"],
      ["/v1/mcp-servers/{id}", "patch", "200"],
    ]) {
      const escaped = path!.replaceAll("~", "~0").replaceAll("/", "~1");

      const validator = ajv.compile({
        $ref: `contract#/paths/${escaped}/${method}/responses/${status}/content/application~1json/schema`,
      });

      expect(validator(null)).toBe(true);
      expect(validator("invalid resource")).toBe(false);
    }
  });

  test("all path parameters are required", () => {
    const document = openAPIDocument();

    for (const path of Object.values(document.paths ?? {})) {
      for (const method of ["get", "put", "post", "patch", "delete"] as const) {
        for (const parameter of path?.[method]?.parameters ?? []) {
          if ("in" in parameter && parameter.in === "path")
            expect(parameter.required).toBe(true);
        }
      }
    }
  });
});

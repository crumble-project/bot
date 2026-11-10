import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { openAPIDocument } from "./api-contract";

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

  test("schedule admission results describe execution fields without requiring them", () => {
    const document = openAPIDocument();
    const result = document.components?.schemas?.["ScheduleRunResult"];

    expect(result).toMatchObject({
      properties: {
        agentId: { type: "string" },
        conversationId: { type: "string" },
        prompt: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });

    ajv.addSchema(document, "contract");

    const validate = ajv.compile({
      $ref: "contract#/components/schemas/ScheduleRun",
    });

    expect(validate({ admitted: false })).toBe(true);
    expect(
      validate({ admitted: true, result: { id: "e1", status: "pending" } }),
    ).toBe(true);
    expect(validate({ admitted: true, result: { agentId: 123 } })).toBe(false);
  });

  test("all path parameters are required", () => {
    const document = openAPIDocument();
    const parameters: [string, string, string, boolean | undefined][] = [];

    for (const [route, path] of Object.entries(document.paths ?? {})) {
      for (const method of ["get", "put", "post", "patch", "delete"] as const) {
        for (const parameter of path?.[method]?.parameters ?? []) {
          if ("in" in parameter && parameter.in === "path")
            parameters.push([
              route,
              method,
              parameter.name,
              parameter.required,
            ]);
        }
      }
    }

    expect(parameters).toContainEqual(["/v1/agents/{id}", "get", "id", true]);
    expect(parameters.filter(([, , , required]) => required !== true)).toEqual(
      [],
    );
  });

  test("voice gateway routes take only a voice gateway token, and no other route does", () => {
    const security: [string, unknown][] = [];

    for (const [route, path] of Object.entries(openAPIDocument().paths ?? {}))
      for (const method of ["get", "put", "post", "patch", "delete"] as const) {
        const operation = path?.[method];

        if (operation) security.push([route, operation.security]);
      }

    const voice = security.filter(([route]) => route.startsWith("/v1/voice/"));
    const tokenOnly = [{ VoiceGatewayToken: [] }];

    expect(voice.length).toBeGreaterThan(0);
    expect(
      voice.filter(([, value]) => !Bun.deepEquals(value, tokenOnly)),
    ).toEqual([]);
    expect(
      security.filter(
        ([route, value]) =>
          !route.startsWith("/v1/voice/") &&
          JSON.stringify(value).includes("VoiceGatewayToken"),
      ),
    ).toEqual([]);
  });
});

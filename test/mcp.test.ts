import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fixture, makeCp, on } from "./helpers.js";

async function connect() {
  const { cp } = makeCp([on("/journeys", fixture("journeys-lisboa-porto-c2"), 200, "POST")]);
  const serviceCodes = await cp.serviceCodes();
  const server = createServer({ cp, serviceCodes });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function walk(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!schema || typeof schema !== "object") return;
  visit(schema as Record<string, unknown>);
  for (const v of Object.values(schema)) walk(v, visit);
}

describe("MCP surface", () => {
  it("lists all tools, all read-only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["classes_e_regras", "estado_comboio", "horarios", "info_estacao", "link_compra", "mostrar_horarios", "partidas_chegadas", "perturbacoes", "precos", "procurar_estacao"].sort(),
    );
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("uses no nullable type unions in input schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      walk(t.inputSchema, (node) => {
        if (Array.isArray(node.type)) throw new Error(`${t.name} has a type union: ${JSON.stringify(node.type)}`);
        if (node.type === "null") throw new Error(`${t.name} has a null type`);
      });
    }
  });

  it("lists valid service codes in the horarios description", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const horarios = tools.find((t) => t.name === "horarios")!;
    const services = (horarios.inputSchema.properties as any).services;
    expect(services.description).toContain("AP (Alfa Pendular)");
    expect(services.description).toContain("IC (Intercidades)");
    expect((horarios.inputSchema.properties as any).date.format).toBe("date");
  });

  it("returns JSON text results and structured errors", async () => {
    const client = await connect();
    const ok = await client.callTool({ name: "procurar_estacao", arguments: { query: "campanha" } });
    expect(ok.isError).toBeFalsy();
    const data = JSON.parse((ok.content as any)[0].text);
    expect(data.results[0].code).toBe("94-2006");

    const bad = await client.callTool({ name: "horarios", arguments: { from: "Lisboa", to: "Porto", date: "2026-11-30" } });
    expect(bad.isError).toBe(true);
    const err = JSON.parse((bad.content as any)[0].text).error;
    expect(err.code).toBe("AMBIGUOUS_STATION");
    expect(err.candidates.length).toBeGreaterThan(1);
  });

  it("serves a full journey search over the protocol", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "horarios", arguments: { from: "lisboa sa", to: "porto", date: "2026-11-30", services: ["AP"] } });
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.options.length).toBeGreaterThan(0);
    expect(data.options[0].id).toMatch(/^2026-11-30_94-30007_94-2006_c2_p1_out\d+$/);
  });

  it("with payments enabled: buy_url instead of cp.pt, comprar_bilhete instead of link_compra", async () => {
    process.env.PAYMENTS_ENABLED = "1";
    process.env.PUBLIC_BASE_URL = "https://example.test";
    try {
      const client = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("comprar_bilhete");
      expect(names).not.toContain("link_compra");
      const res = await client.callTool({ name: "horarios", arguments: { from: "lisboa sa", to: "porto", date: "2026-11-30" } });
      const data = JSON.parse((res.content as any)[0].text);
      expect(data).not.toHaveProperty("cp_url");
      expect(JSON.stringify(data)).not.toContain("www.cp.pt");
      const sold = data.options.filter((o: any) => o.saleable_online);
      expect(sold.length).toBeGreaterThan(0);
      for (const o of sold) expect(o.buy_url).toBe(`https://example.test/comprar?o=${encodeURIComponent(o.id)}`);
    } finally {
      delete process.env.PAYMENTS_ENABLED;
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  it("offers the in-chat view only on mostrar_horarios, as an MCP Apps resource", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const show = tools.find((t) => t.name === "mostrar_horarios")!;
    expect(show._meta).toMatchObject({ ui: { resourceUri: "ui://comboios/horarios.html" }, "ui/resourceUri": "ui://comboios/horarios.html" });
    expect(show.description).toMatch(/Do NOT use it for quick factual questions/);
    expect(tools.find((t) => t.name === "horarios")!._meta).toBeUndefined();

    const res = await client.readResource({ uri: "ui://comboios/horarios.html" });
    const c = res.contents[0] as any;
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toMatch(/^<!doctype html>/);
    expect(c.text).toContain('id="root"');
    expect(c._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });

    const data = JSON.parse(((await client.callTool({ name: "mostrar_horarios", arguments: { from: "lisboa sa", to: "porto", date: "2026-11-30" } })).content as any)[0].text);
    expect(data.options.length).toBeGreaterThan(0);
  });
});

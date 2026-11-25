import { describe, expect, it } from "vitest";
import { StationIndex, loadAliases, normalize } from "../src/stations.js";
import { CpError } from "../src/errors.js";
import { fixture } from "./helpers.js";

const index = new StationIndex(fixture("stations"), loadAliases());

function resolveErr(q: string): CpError {
  try {
    index.resolve(q);
  } catch (e) {
    return e as CpError;
  }
  throw new Error(`expected "${q}" to fail`);
}

describe("normalize", () => {
  it("strips accents, case, hyphens and dots", () => {
    expect(normalize("Porto-Campanhã")).toBe("porto campanha");
    expect(normalize("  S. Bento  ")).toBe("s bento");
    expect(normalize("Coimbra-B")).toBe("coimbra b");
  });
});

describe("station resolution", () => {
  it("loads all stations", () => {
    expect(index.size).toBeGreaterThan(400);
  });

  it.each([
    ["Campanhã", "94-2006"],
    ["campanha", "94-2006"],
    ["Porto", "94-2006"],
    ["lisboa sa", "94-30007"],
    ["Santa Apolónia", "94-30007"],
    ["Coimbra", "94-36004"],
    ["Coimbra B", "94-36004"],
    ["Coimbra-B", "94-36004"],
    ["Sao Bento", "94-1008"],
    ["São Bento", "94-1008"],
    ["Oriente", "94-31039"],
    ["94-30007", "94-30007"],
  ])("%s -> %s", (q, code) => {
    expect(index.resolve(q).code).toBe(code);
  });

  it("resolves an exact designation even when other names share its prefix", () => {
    // "Braga" is also a prefix of nothing else, but "Aveiro" vs "Aveiro-Vouga"-style collisions must not raise.
    expect(index.resolve("Aveiro").code).toBe("94-38000");
    expect(index.resolve("Faro").code).toBe("94-73007");
  });

  it("tolerates a typo", () => {
    expect(index.resolve("Entrecampo").code).toBe("94-66050");
    expect(index.resolve("Entrcampos").code).toBe("94-66050");
  });

  it("reports ambiguity with candidates instead of guessing", () => {
    const err = resolveErr("Lisboa");
    expect(err.code).toBe("AMBIGUOUS_STATION");
    const codes = (err.details?.candidates as { code: string }[]).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["94-30007", "94-31039"]));
  });

  it("reports unknown codes and names", () => {
    expect(resolveErr("94-999999").code).toBe("STATION_NOT_FOUND");
    expect(resolveErr("xyzzyplugh").code).toBe("STATION_NOT_FOUND");
  });
});

describe("station search", () => {
  it("always returns a ranked list, never an ambiguity error", () => {
    const r = index.search("Lisboa", 5);
    expect(r.length).toBe(3); // Santa Apolonia, Oriente, Rossio
    expect(() => index.search("Lisboa", 5)).not.toThrow();
    expect(r.every((x) => x.name.toLowerCase().startsWith("lisboa"))).toBe(true);
  });

  it("puts the exact/alias match first with score 1", () => {
    const r = index.search("Campanhã", 3);
    expect(r[0]).toMatchObject({ code: "94-2006", score: 1 });
    expect(typeof r[0].lat).toBe("number");
  });

  it("respects the limit", () => {
    expect(index.search("a", 3).length).toBeLessThanOrEqual(3);
  });
});

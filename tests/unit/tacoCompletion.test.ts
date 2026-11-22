// «Completar el taco» (5.7, B-R23): a qué página va cada fichero, sin
// navegador ni BD.
import { describe, it, expect } from "vitest";
import {
  completionSummary,
  emptyTacoPages,
  endPositions,
  hasTargetClash,
  planTacoCompletion,
  type CompletionRow,
} from "@/lib/tacoCompletion";

const file = (name: string, hash = name) => ({ id: name, name, hash });

describe("planTacoCompletion", () => {
  it("lo que ya está se reconoce por la huella (sin mayúsculas) y no se sube", () => {
    const rows = planTacoCompletion({
      files: [file("SCAN0002.pdf", "AA"), file("SCAN0004.pdf", "bb")],
      occupied: [{ position: 2, fileHash: "aa" }],
      takenPages: [1, 2, 3],
      fileCount: 4,
    });
    expect(rows.map((row) => [row.name, row.alreadyAt, row.target])).toEqual([
      ["SCAN0002.pdf", 2, null],
      ["SCAN0004.pdf", null, 4],
    ]);
  });

  it("con tantos ficheros como páginas vacías, a las vacías en orden natural por nombre", () => {
    const rows = planTacoCompletion({
      files: [file("Escaneo (10).pdf"), file("Escaneo (2).pdf")],
      occupied: [],
      takenPages: [1, 3, 4],
      fileCount: 5,
    });
    expect(rows.map((row) => [row.name, row.target])).toEqual([["Escaneo (2).pdf", 2], ["Escaneo (10).pdf", 5]]);
  });

  it("si no casan con los huecos, todos al final; y el mismo fichero dos veces, una sola vez", () => {
    const rows = planTacoCompletion({
      files: [file("a.pdf", "h1"), file("b.pdf", "h2"), file("c.pdf", "h1")],
      occupied: [],
      takenPages: [1, 2],
      fileCount: 3,
    });
    expect(rows.map((row) => [row.name, row.target, row.repeatOf])).toEqual([
      ["a.pdf", "end", null],
      ["b.pdf", "end", null],
      ["c.pdf", null, "a.pdf"],
    ]);
  });

  it("páginas vacías, choques y la página de los que van al final", () => {
    expect(emptyTacoPages(5, [1, 3, 5])).toEqual([2, 4]);
    expect(emptyTacoPages(0, [])).toEqual([]);
    const row = (id: string, target: CompletionRow["target"]): CompletionRow => ({ id, name: id, alreadyAt: null, repeatOf: null, target });
    expect(hasTargetClash([row("a", 2), row("b", 2)])).toBe(true);
    expect(hasTargetClash([row("a", 2), row("b", "end"), row("c", "end")])).toBe(false);
    expect([...endPositions([row("a", "end"), row("b", 2), row("c", "end")], 53)]).toEqual([["a", 53], ["c", 54]]);
  });
});

describe("completionSummary", () => {
  const row = (id: string, target: CompletionRow["target"], alreadyAt: number | null = null): CompletionRow =>
    ({ id, name: id, alreadyAt, repeatOf: null, target });

  it("«3 ficheros: 2 a páginas vacías y 1 al final del taco (Pág. 53).»", () => {
    expect(completionSummary([row("a", 4), row("b", 9), row("c", "end")], 52))
      .toBe("3 ficheros: 2 a páginas vacías y 1 al final del taco (Pág. 53).");
  });

  it("solo a huecos, solo al final y lo que ya estaba", () => {
    expect(completionSummary([row("a", 4)], 52)).toBe("1 fichero a una página vacía.");
    expect(completionSummary([row("a", "end"), row("b", "end")], 52)).toBe("2 ficheros al final del taco (Págs. 53-54).");
    expect(completionSummary([row("a", null, 3), row("b", null, 7)], 52)).toBe("2 ya están en el taco.");
    expect(completionSummary([row("a", 4), row("b", null, 3)], 52)).toBe("1 fichero a una página vacía. 1 ya está en el taco.");
  });
});

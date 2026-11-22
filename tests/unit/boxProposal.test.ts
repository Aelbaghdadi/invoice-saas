import { describe, it, expect } from "vitest";
import {
  BOX_LABEL_LENGTH_ERROR,
  boxNumberOf,
  boxLabelKey,
  boxLabelPrefix,
  countsForMode,
  normalizeBoxLabel,
  proposeBoxLabels,
  type BoxProposalInput,
  type BoxUse,
} from "@/lib/boxProposal";

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 10));
const use = (label: string, d: number): BoxUse => ({ label, filedAt: day(d) });

function perClient(used: BoxUse[], overrides: Partial<BoxProposalInput> = {}) {
  return proposeBoxLabels({ mode: "PER_CLIENT_YEAR", clientName: "Panadería López", fiscalYearLabel: "2026", used, ...overrides });
}

function shared(used: BoxUse[], others: BoxUse[] = []) {
  return proposeBoxLabels({ mode: "SHARED", clientName: "Panadería López", fiscalYearLabel: "2026", used, others });
}

describe("proposeBoxLabels: una caja por cliente y año", () => {
  it("sin cajas usadas: la 1, y «Caja nueva» la 2", () => {
    expect(perClient([])).toEqual({
      proposed: "Panadería López · 2026 · Caja 1",
      next: "Panadería López · 2026 · Caja 2",
      lastUsed: null,
      suggestions: [],
    });
  });

  it("la última usada aunque no sea la mayor; la nueva, la mayor + 1", () => {
    const result = perClient([
      use("Panadería López · 2026 · Caja 3", 1),
      use("Panadería López · 2026 · Caja 5", 2),
      use("Panadería López · 2026 · Caja 4", 15),
    ]);
    expect(result.proposed).toBe("Panadería López · 2026 · Caja 4");
    expect(result.lastUsed).toBe("Panadería López · 2026 · Caja 4");
    expect(result.next).toBe("Panadería López · 2026 · Caja 6");
  });

  it("las escritas a mano cuentan para el número", () => {
    const result = perClient([use("Panadería López · 2026 · Caja 2", 1), use("López 2026 caja 3", 5)]);
    expect(result.proposed).toBe("López 2026 caja 3");
    expect(result.next).toBe("Panadería López · 2026 · Caja 4");
  });

  it("con etiquetas pero ninguna con número, la nueva es la 1", () => {
    const result = perClient([use("Estantería del fondo", 3)]);
    expect(result.proposed).toBe("Estantería del fondo");
    expect(result.next).toBe("Panadería López · 2026 · Caja 1");
  });

  it("el año o el ejercicio del final de una etiqueta escrita a mano no es el nº de caja", () => {
    const year = perClient([use("López 2026", 3)]);
    expect(year.proposed).toBe("López 2026");
    expect(year.next).toBe("Panadería López · 2026 · Caja 1");
    const fiscalYear = perClient([use("López 2025-26", 3)], { fiscalYearLabel: "2025-26" });
    expect(fiscalYear.next).toBe("Panadería López · 2025-26 · Caja 1");
    // Con una que sí dice la caja, esa manda.
    expect(perClient([use("López 2026", 9), use("López 2026 caja nº 4", 3)]).next).toBe("Panadería López · 2026 · Caja 5");
  });

  it("con el ejercicio de julio a junio, y en un taco de varios clientes con el año natural", () => {
    expect(perClient([], { clientName: "Bar Pepe", fiscalYearLabel: "2025-26" }).proposed).toBe("Bar Pepe · 2025-26 · Caja 1");
    expect(perClient([], { clientName: null }).proposed).toBe("Varios clientes · 2026 · Caja 1");
    expect(perClient([], { clientName: "   " }).proposed).toBe("Varios clientes · 2026 · Caja 1");
  });

  it("un nombre de 120 caracteres se recorta con «…» y la etiqueta cabe en 80", () => {
    const longName = `Distribuciones ${"Muy Larga ".repeat(11)}SL`.slice(0, 120);
    expect(longName).toHaveLength(120);
    const prefix = boxLabelPrefix({ mode: "PER_CLIENT_YEAR", clientName: longName, fiscalYearLabel: "2025-26" });
    const clientPart = prefix.split(" · ")[0];
    expect([...clientPart].length).toBeLessThanOrEqual(50);
    expect(clientPart.endsWith("…")).toBe(true);
    const result = perClient([], { clientName: longName, fiscalYearLabel: "2025-26" });
    expect(result.proposed.length).toBeLessThanOrEqual(80);
    expect(normalizeBoxLabel(result.next)).toEqual({ ok: true, label: result.next });
  });
});

describe("proposeBoxLabels: todas juntas", () => {
  it("sin cajas, la 1; con cajas, la última de la asesoría, y la nueva la mayor + 1", () => {
    expect(shared([])).toMatchObject({ proposed: "Caja 1", next: "Caja 2", lastUsed: null });
    expect(shared([use("Caja 15", 1), use("Caja 12", 20)])).toMatchObject({ proposed: "Caja 12", next: "Caja 16", lastUsed: "Caja 12" });
  });

  it("una etiqueta que acaba en un año («Estantería B 2025») se propone, pero no da el nº de la nueva", () => {
    expect(shared([use("Caja 4", 1), use("Estantería B 2025", 5)])).toMatchObject({
      proposed: "Estantería B 2025",
      next: "Caja 5",
      lastUsed: "Estantería B 2025",
    });
    expect(shared([use("Estantería B 2025", 5)]).next).toBe("Caja 1");
  });
});

describe("boxNumberOf: el nº que va detrás de «caja»", () => {
  it("al final de la etiqueta, escrito de varias maneras", () => {
    for (const [label, number] of [
      ["Panadería López · 2026 · Caja 12", 12],
      ["López 2026 caja 3", 3],
      ["López 2026 - caja 3", 3],
      ["Caja 7", 7],
      ["Caja7", 7],
      ["Caja-8", 8],
      ["caja nº 12", 12],
      ["Caja n.º 12", 12],
      ["CAJA N° 12", 12],
      ["Caja no. 12", 12],
      ["Caja núm. 12", 12],
      ["Caja número 12", 12],
    ] as const) {
      expect(boxNumberOf(label), label).toBe(number);
    }
  });

  it("un número sin «caja» delante, o lo que no acaba en el número, no es una caja", () => {
    for (const label of ["López 2026", "López 2025-26", "Estantería B 2025", "Archivo del sótano 2", "Cajas 3", "Encaja 3", "Caja 3 bis", "Caja"]) {
      expect(boxNumberOf(label), label).toBeNull();
    }
  });
});

describe("cambiar el ajuste no mezcla las cajas", () => {
  it("de todas juntas a una por cliente: «Caja 12» de los tacos del cliente no cuenta", () => {
    expect(perClient([use("Caja 12", 10)])).toMatchObject({
      proposed: "Panadería López · 2026 · Caja 1",
      next: "Panadería López · 2026 · Caja 2",
      lastUsed: null,
    });
  });

  it("de una por cliente a todas juntas: «Panadería López · 2026 · Caja 3» no cuenta y la nueva no toma el 3", () => {
    expect(shared([use("Panadería López · 2026 · Caja 3", 10)])).toMatchObject({ proposed: "Caja 1", next: "Caja 2", lastUsed: null });
    expect(shared([use("Panadería López · 2026 · Caja 3", 10), use("Caja 7", 1)])).toMatchObject({ proposed: "Caja 7", next: "Caja 8" });
  });

  it("countsForMode", () => {
    expect(countsForMode("PER_CLIENT_YEAR", "Panadería López · 2026 · Caja 3")).toBe(true);
    expect(countsForMode("PER_CLIENT_YEAR", "López 2026 caja 3")).toBe(true);
    expect(countsForMode("PER_CLIENT_YEAR", "Caja 12")).toBe(false);
    expect(countsForMode("PER_CLIENT_YEAR", "caja nº 12")).toBe(false);
    expect(countsForMode("PER_CLIENT_YEAR", "Caja n.º 12")).toBe(false);
    expect(countsForMode("SHARED", "Caja 12")).toBe(true);
    expect(countsForMode("SHARED", "Archivo del sótano 2")).toBe(true);
    expect(countsForMode("SHARED", "Panadería López · 2026 · Caja 3")).toBe(false);
  });
});

describe("sugerencias", () => {
  it("primero las que cuentan (las más recientes antes), después las demás de la asesoría, sin repetir", () => {
    const result = shared(
      [use("Caja 2", 1), use("Panadería López · 2026 · Caja 3", 30), use("Caja 5", 9)],
      [use("Bar Pepe · 2026 · Caja 1", 20), use("CAJA 2", 25), use("Bar Pepe · 2025 · Caja 9", 2)],
    );
    expect(result.suggestions).toEqual([
      "Caja 5",
      "Caja 2",
      "Panadería López · 2026 · Caja 3",
      "Bar Pepe · 2026 · Caja 1",
      "Bar Pepe · 2025 · Caja 9",
    ]);
  });

  it("como mucho 50", () => {
    const many = Array.from({ length: 70 }, (_, i) => use(`Caja ${i + 1}`, (i % 28) + 1));
    expect(shared(many).suggestions).toHaveLength(50);
  });

  it("las de tacos que no ve quien pregunta cuentan para la propuesta, pero no se sugieren", () => {
    const hidden = (label: string, d: number): BoxUse => ({ label, filedAt: day(d), hidden: true });
    const result = shared([use("Caja 4", 1), hidden("Caja 12", 5), hidden("Clínica Secreta · 2026 · Caja 7", 3)]);
    expect(result).toMatchObject({ proposed: "Caja 12", next: "Caja 13", lastUsed: "Caja 12" });
    expect(result.suggestions).toEqual(["Caja 4"]);
    // La misma caja, vista en otro taco, sí.
    expect(shared([hidden("Caja 12", 5), use("caja 12", 2)]).suggestions).toEqual(["caja 12"]);
  });
});

describe("boxLabelKey", () => {
  it("sin tildes, en minúsculas y con los espacios juntados", () => {
    expect(boxLabelKey("Panadería  López · 2026 · Caja 3")).toBe(boxLabelKey("panaderia lopez · 2026 · CAJA 3"));
    expect(boxLabelKey(" Caja   3 ")).toBe("caja 3");
  });
});

describe("normalizeBoxLabel", () => {
  const TAB = String.fromCharCode(9);
  const BELL = String.fromCharCode(7);
  const ZERO_WIDTH = String.fromCharCode(0x200b);

  it("recorta y junta los espacios", () => {
    expect(normalizeBoxLabel("  Caja    3 ")).toEqual({ ok: true, label: "Caja 3" });
    expect(normalizeBoxLabel(`Caja${TAB}3`)).toEqual({ ok: true, label: "Caja 3" });
  });

  it("quita los caracteres de control y los invisibles", () => {
    expect(normalizeBoxLabel(`Caja${BELL} 3${ZERO_WIDTH}`)).toEqual({ ok: true, label: "Caja 3" });
    expect(normalizeBoxLabel(`Caja ${ZERO_WIDTH} 3`)).toEqual({ ok: true, label: "Caja 3" });
    expect(normalizeBoxLabel(`${BELL}${ZERO_WIDTH}`)).toEqual({ ok: false, error: BOX_LABEL_LENGTH_ERROR });
  });

  it("de 2 a 80 caracteres", () => {
    expect(BOX_LABEL_LENGTH_ERROR).toBe("La etiqueta de la caja tiene que tener entre 2 y 80 caracteres.");
    expect(normalizeBoxLabel("A")).toEqual({ ok: false, error: BOX_LABEL_LENGTH_ERROR });
    expect(normalizeBoxLabel("   A   ")).toEqual({ ok: false, error: BOX_LABEL_LENGTH_ERROR });
    expect(normalizeBoxLabel("C3")).toEqual({ ok: true, label: "C3" });
    expect(normalizeBoxLabel("ñ".repeat(80))).toEqual({ ok: true, label: "ñ".repeat(80) });
    expect(normalizeBoxLabel("x".repeat(81))).toEqual({ ok: false, error: BOX_LABEL_LENGTH_ERROR });
  });
});

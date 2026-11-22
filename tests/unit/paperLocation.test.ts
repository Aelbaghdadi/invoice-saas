import { describe, it, expect } from "vitest";
import {
  boxLabelMatchesWords,
  invoiceOrderLabel,
  isPaperWithoutLocation,
  isUnconfirmedWithoutLocation,
  pageRangeLabel,
  paperLocationOf,
  shortPaperLocationText,
  tacoLabel,
  tacoShortLabel,
  tacoSlots,
  tacoState,
  tacoStateLabel,
  type PaperLocationInput,
  type TacoRef,
  type TacoSlotRow,
  type TacoState,
} from "@/lib/paperLocation";
import { boxLabelPrefix } from "@/lib/boxProposal";

// 23:30 UTC del 20/11 ya es el 21/11 en Madrid.
const RETURNED = new Date("2026-11-20T23:30:00Z");
const FILED = new Date("2026-11-21T09:00:00Z");

function taco(overrides: Partial<TacoRef> = {}): TacoRef {
  return {
    id: "taco-37",
    tacoNumber: 37,
    origin: "UPLOAD",
    wholePdf: false,
    boxLabel: null,
    returnedAt: null,
    filedAt: null,
    voidedAt: null,
    ...overrides,
  };
}

const digital = taco({ id: "tanda-digital", tacoNumber: null });
const archiveBox = taco({ id: "taco-40", tacoNumber: 40, origin: "ARCHIVE", boxLabel: "Panadería López · 2026 · Caja 5", filedAt: FILED });
const archiveReturned = taco({ id: "taco-41", tacoNumber: 41, origin: "ARCHIVE", returnedAt: RETURNED, filedAt: RETURNED });

function input(overrides: Partial<PaperLocationInput> = {}): PaperLocationInput {
  return { medium: "PAPER", paperHeldByClient: false, uploadPosition: 12, arrival: taco(), paper: null, ...overrides };
}

const BOX = "Panadería López · 2026 · Caja 3";
const PREFIX = boxLabelPrefix({ mode: "PER_CLIENT_YEAR", clientName: "Panadería López", fiscalYearLabel: "2026" });

describe("paperLocationOf (B-R12)", () => {
  it("en un taco guardado en caja: la caja, el taco y la página", () => {
    const location = paperLocationOf(input({ arrival: taco({ boxLabel: BOX, filedAt: FILED }) }));
    expect(location).toEqual({
      kind: "box",
      text: "Panadería López · 2026 · Caja 3 · Taco 37 · Pág. 12",
      tacoId: "taco-37",
      tacoNumber: 37,
      page: 12,
      boxLabel: BOX,
      tacoText: "Taco 37 · Pág. 12",
      tacoShort: "T37 · Pág. 12",
      manual: false,
      withoutLocation: false,
      arrivalDigitalBatchId: null,
    });
  });

  it("devuelto, con el día en Madrid", () => {
    const location = paperLocationOf(input({ arrival: taco({ returnedAt: RETURNED, filedAt: RETURNED }) }));
    expect(location).toMatchObject({ kind: "returned", text: "Devuelto al cliente el 21/11/2026 · Taco 37 · Pág. 12", boxLabel: null });
  });

  it("sin guardar y anulado", () => {
    expect(paperLocationOf(input())).toMatchObject({ kind: "unfiled", text: "Taco 37 · Pág. 12 (sin guardar)" });
    // Anulado manda aunque estuviera guardado.
    const voided = taco({ voidedAt: FILED, boxLabel: BOX, filedAt: FILED });
    expect(paperLocationOf(input({ arrival: voided, medium: "PAPER" }))).toMatchObject({
      kind: "voided",
      text: "Taco 37 · Pág. 12 (taco anulado)",
      tacoId: "taco-37",
    });
  });

  it("taco entero: la página del PDF donde empieza", () => {
    const location = paperLocationOf(input({ uploadPosition: 27, arrival: taco({ wholePdf: true, boxLabel: "Caja 7", filedAt: FILED }) }));
    expect(location).toMatchObject({
      kind: "box",
      text: "Caja 7 · Taco 37 · Pág. 27 del PDF",
      page: 27,
      tacoText: "Taco 37 · Pág. 27 del PDF",
      tacoShort: "T37 · Pág. 27 del PDF",
    });
  });

  it("papel ubicado a mano (ARCHIVE): en caja sin «Taco», y devuelto solo con la fecha", () => {
    const boxed = paperLocationOf(input({ arrival: digital, paper: archiveBox, uploadPosition: 3 }));
    expect(boxed).toMatchObject({
      kind: "box",
      text: "Panadería López · 2026 · Caja 5 · papel ubicado a mano",
      tacoId: "taco-40",
      tacoNumber: 40,
      page: null,
      tacoText: null,
      tacoShort: null,
      manual: true,
      withoutLocation: false,
      arrivalDigitalBatchId: "tanda-digital",
    });
    expect(paperLocationOf(input({ arrival: null, paper: archiveReturned, uploadPosition: null }))).toMatchObject({
      kind: "returned",
      text: "Devuelto al cliente el 21/11/2026",
      tacoNumber: 41,
      manual: true,
    });
  });

  it("«Sacada» de su taco: manda el taco donde está ahora, no el de llegada", () => {
    const location = paperLocationOf(input({ arrival: taco({ boxLabel: BOX, filedAt: FILED }), paper: archiveReturned }));
    expect(location).toMatchObject({ kind: "returned", text: "Devuelto al cliente el 21/11/2026", tacoId: "taco-41" });
  });

  it("papel en otro taco subido: como el de llegada, sin «Pág.»", () => {
    const other = taco({ id: "taco-50", tacoNumber: 50, boxLabel: "Caja 9", filedAt: FILED });
    expect(paperLocationOf(input({ arrival: taco(), paper: other }))).toMatchObject({
      kind: "box",
      text: "Caja 9 · Taco 50",
      page: null,
      tacoShort: "T50",
    });
  });

  it("electrónica (también dentro de un taco) y la que guarda el cliente (también con taco)", () => {
    expect(paperLocationOf(input({ medium: "ELECTRONIC" }))).toMatchObject({
      kind: "electronic",
      text: "Original electrónico",
      tacoId: null,
      page: null,
      withoutLocation: false,
    });
    expect(paperLocationOf(input({ paperHeldByClient: true, paper: archiveBox }))).toMatchObject({
      kind: "client",
      text: "Lo guarda el cliente",
      tacoId: null,
      withoutLocation: false,
    });
  });

  it("sin taco: «Por confirmar» o «Sin ubicación»", () => {
    expect(paperLocationOf(input({ medium: null, arrival: null, uploadPosition: null }))).toMatchObject({
      kind: "unconfirmed",
      text: "Por confirmar",
      withoutLocation: true,
      arrivalDigitalBatchId: null,
    });
    expect(paperLocationOf(input({ arrival: null, uploadPosition: null }))).toMatchObject({
      kind: "none",
      text: "Sin ubicación",
      withoutLocation: true,
    });
  });

  it("una tanda digital no es un taco: da la subida para «Ver la subida»", () => {
    expect(paperLocationOf(input({ medium: null, arrival: digital, uploadPosition: 4 }))).toMatchObject({
      kind: "unconfirmed",
      text: "Por confirmar",
      tacoId: null,
      page: null,
      arrivalDigitalBatchId: "tanda-digital",
    });
    expect(paperLocationOf(input({ medium: "ELECTRONIC", arrival: digital })).arrivalDigitalBatchId).toBe("tanda-digital");
  });
});

describe("shortPaperLocationText", () => {
  it("quita «{cliente} · {ejercicio} · » de la caja, con tildes y mayúsculas distintas", () => {
    const location = paperLocationOf(input({ arrival: taco({ boxLabel: "PANADERIA lopez · 2026 · Caja 3", filedAt: FILED }), uploadPosition: 28 }));
    expect(shortPaperLocationText(location, PREFIX)).toBe("Caja 3 · T37 · Pág. 28");
    expect(location.text).toBe("PANADERIA lopez · 2026 · Caja 3 · Taco 37 · Pág. 28");
  });

  it("si la caja no lleva ese prefijo, o no hay prefijo, la deja entera", () => {
    const location = paperLocationOf(input({ arrival: taco({ boxLabel: "López 2026 caja 3", filedAt: FILED }) }));
    expect(shortPaperLocationText(location, PREFIX)).toBe("López 2026 caja 3 · T37 · Pág. 12");
    const other = paperLocationOf(input({ arrival: taco({ boxLabel: "Otro Cliente · 2026 · Caja 1", filedAt: FILED }) }));
    expect(shortPaperLocationText(other, PREFIX)).toBe("Otro Cliente · 2026 · Caja 1 · T37 · Pág. 12");
    expect(shortPaperLocationText(other, null)).toBe("Otro Cliente · 2026 · Caja 1 · T37 · Pág. 12");
    expect(shortPaperLocationText(other, "Caja ")).toBe("Otro Cliente · 2026 · Caja 1 · T37 · Pág. 12");
  });

  it("sin caja: el taco abreviado; el papel ubicado a mano, sin taco", () => {
    expect(shortPaperLocationText(paperLocationOf(input()), PREFIX)).toBe("T37 · Pág. 12 (sin guardar)");
    expect(shortPaperLocationText(paperLocationOf(input({ arrival: taco({ voidedAt: FILED }) })), PREFIX)).toBe(
      "T37 · Pág. 12 (taco anulado)",
    );
    expect(shortPaperLocationText(paperLocationOf(input({ arrival: taco({ returnedAt: RETURNED }) })), PREFIX)).toBe(
      "Devuelto al cliente el 21/11/2026 · T37 · Pág. 12",
    );
    expect(shortPaperLocationText(paperLocationOf(input({ paper: archiveBox })), PREFIX)).toBe("Caja 5 · papel ubicado a mano");
    expect(shortPaperLocationText(paperLocationOf(input({ paper: archiveReturned })), PREFIX)).toBe("Devuelto al cliente el 21/11/2026");
    expect(shortPaperLocationText(paperLocationOf(input({ arrival: null })), PREFIX)).toBe("Sin ubicación");
  });
});

describe("sin ubicación (B-R13)", () => {
  const none = input({ arrival: null, uploadPosition: null });

  it("papel sin taco ni cliente; no las rechazadas, ni lo por confirmar, ni el papel de un taco sin guardar", () => {
    expect(isPaperWithoutLocation(none)).toBe(true);
    expect(isPaperWithoutLocation({ ...none, rejected: true })).toBe(false);
    expect(isPaperWithoutLocation({ ...none, medium: null })).toBe(false);
    expect(isPaperWithoutLocation(input())).toBe(false);
    expect(isPaperWithoutLocation({ ...none, paperHeldByClient: true })).toBe(false);
    expect(isPaperWithoutLocation({ ...none, paper: archiveBox })).toBe(false);
    // Llegar en una tanda digital no es tener taco.
    expect(isPaperWithoutLocation({ ...none, arrival: digital })).toBe(true);
  });

  it("dice lo mismo que la ubicación que se enseña", () => {
    for (const value of [none, { ...none, arrival: digital }, { ...none, paper: digital }, input(), { ...none, paper: archiveBox }]) {
      expect(isPaperWithoutLocation(value)).toBe(paperLocationOf(value).withoutLocation);
    }
  });

  it("por confirmar sin taco ni cliente; no con taco, ni la del cliente, ni las rechazadas", () => {
    const unconfirmed = { ...none, medium: null };
    expect(isUnconfirmedWithoutLocation(unconfirmed)).toBe(true);
    expect(isUnconfirmedWithoutLocation({ ...unconfirmed, arrival: digital })).toBe(true);
    expect(isUnconfirmedWithoutLocation({ ...unconfirmed, arrival: taco() })).toBe(false);
    expect(isUnconfirmedWithoutLocation({ ...unconfirmed, paper: archiveBox })).toBe(false);
    expect(isUnconfirmedWithoutLocation({ ...unconfirmed, paperHeldByClient: true })).toBe(false);
    expect(isUnconfirmedWithoutLocation({ ...unconfirmed, rejected: true })).toBe(false);
    expect(isUnconfirmedWithoutLocation(none)).toBe(false);
  });

  it("la «Por confirmar» que aún se analiza, no: el análisis puede decir que es electrónica", () => {
    expect(isUnconfirmedWithoutLocation({ ...none, medium: null, analyzing: true })).toBe(false);
    expect(isUnconfirmedWithoutLocation({ ...none, medium: null, analyzing: false })).toBe(true);
  });
});

describe("boxLabelMatchesWords (el buscador en las cajas)", () => {
  const LOPEZ = boxLabelPrefix({ mode: "PER_CLIENT_YEAR", clientName: "Panadería López", fiscalYearLabel: "2026" });
  const label = "Panadería López · 2026 · Caja 3";

  it("el cliente o el año solos no casan: eso ya lo dice la fila; con algo de lo escrito en la caja, sí", () => {
    for (const text of ["López", "panaderia", "2026", "Panadería López 2026", "lo"]) {
      expect(boxLabelMatchesWords(label, LOPEZ, text)).toBe(false);
    }
    for (const text of ["panadería 2026 caja 3", "lopez caja", "CAJA 3", "caja"]) {
      expect(boxLabelMatchesWords(label, LOPEZ, text)).toBe(true);
    }
    // Todas las palabras tienen que estar.
    expect(boxLabelMatchesWords(label, LOPEZ, "lopez caja 9")).toBe(false);
    // Una letra suelta no basta para casar fuera del cliente.
    expect(boxLabelMatchesWords("Cliente A SL · 2026 · Caja 1", "Cliente A SL · 2026 · Caja ", "cliente a")).toBe(false);
  });

  it("una etiqueta escrita a mano (sin el prefijo del cliente) se busca entera", () => {
    expect(boxLabelMatchesWords("Armario López 2025", LOPEZ, "López")).toBe(true);
    expect(boxLabelMatchesWords("Archivo del sótano", null, "sótano")).toBe(true);
  });
});

describe("estado de un taco", () => {
  type TacoStateInput = Parameters<typeof tacoState>[0];
  const base: TacoStateInput = {
    wholePdf: false,
    pdfSplitAt: null,
    voidedAt: null,
    filedAt: null,
    boxLabel: null,
    returnedAt: null,
    invoiceCount: 5,
  };

  it("los seis, y anulado manda sobre todo", () => {
    const cases: [Partial<TacoStateInput>, TacoState, string][] = [
      [{}, "unfiled", "Sin guardar"],
      [{ invoiceCount: 0 }, "empty", "Vacío"],
      [{ boxLabel: "Caja 3", filedAt: FILED }, "box", "En «Caja 3»"],
      [{ returnedAt: RETURNED, filedAt: RETURNED }, "returned", "Devuelto el 21/11/2026"],
      [{ wholePdf: true, invoiceCount: 0 }, "pending-split", "Por dividir"],
      [{ voidedAt: FILED, wholePdf: true, boxLabel: "Caja 3" }, "voided", "Anulado"],
    ];
    for (const [overrides, state, label] of cases) {
      const b = { ...base, ...overrides };
      expect(tacoState(b), label).toBe(state);
      expect(tacoStateLabel(tacoState(b), b), state).toBe(label);
    }
  });

  it("un taco entero sin dividir sigue «Por dividir» aunque se guarde; dividido, como los demás", () => {
    expect(tacoState({ ...base, wholePdf: true, boxLabel: "Caja 3", filedAt: FILED, invoiceCount: 0 })).toBe("pending-split");
    expect(tacoState({ ...base, wholePdf: true, pdfSplitAt: FILED, invoiceCount: 4 })).toBe("unfiled");
    // Uno vacío que se guardó dice dónde está.
    expect(tacoState({ ...base, invoiceCount: 0, boxLabel: "Caja 3", filedAt: FILED })).toBe("box");
  });
});

describe("tacoSlots (B-R18)", () => {
  let next = 0;
  function row(position: number | null, overrides: Partial<TacoSlotRow> = {}): TacoSlotRow {
    next += 1;
    return {
      invoiceId: `f${String(next).padStart(3, "0")}`,
      clientId: "c1",
      status: "VALIDATED",
      splitFromId: null,
      uploadPosition: position,
      splitPart: 0,
      medium: "PAPER",
      paperHeldByClient: false,
      paperBatchId: null,
      paperTacoNumber: null,
      paperTacoReturnedAt: null,
      paperTacoOrigin: null,
      ...overrides,
    };
  }
  const perInvoice = (rows: TacoSlotRow[], fileCount: number) =>
    tacoSlots({ batchId: "taco-37", fileCount, wholePdf: false, pdfPageCount: null, split: false, rows });
  const summary = (slots: ReturnType<typeof perInvoice>) =>
    slots.map((slot) => [slot.page, slot.kind, slot.rows.map((r) => r.invoiceId), slot.label]);

  it("factura a factura: cada página, con los huecos", () => {
    const rows = [row(3), row(1)];
    expect(summary(perInvoice(rows, 4))).toEqual([
      [1, "invoices", [rows[1].invoiceId], null],
      [2, "empty", [], "Sin factura (duplicada o no subida)"],
      [3, "invoices", [rows[0].invoiceId], null],
      [4, "empty", [], "Sin factura (duplicada o no subida)"],
    ]);
    expect(perInvoice(rows, 4).every((slot) => slot.order == null && slot.endPage === slot.page)).toBe(true);
  });

  it("una división en la pág. 12: sus 3 partes, en orden, y sin la original", () => {
    const root = row(12, { status: "SPLIT_SOURCE" });
    const parts = [3, 1, 2].map((part) => row(12, { splitFromId: root.invoiceId, splitPart: part }));
    const slot = perInvoice([parts[0], root, parts[1], parts[2]], 12)[11];
    expect(slot.kind).toBe("invoices");
    expect(slot.rows.map((r) => r.splitPart)).toEqual([1, 2, 3]);
    expect(slot.label).toBe("3 facturas en el mismo papel");
  });

  it("una original dividida cuyas partes no están se enseña: la página no queda vacía", () => {
    const root = row(2, { status: "SPLIT_SOURCE" });
    expect(perInvoice([root], 2)[1].rows).toEqual([root]);
  });

  it("electrónica, la que guarda el cliente y la que está en otro taco", () => {
    const slots = perInvoice(
      [
        row(1, { medium: "ELECTRONIC" }),
        row(2, { paperHeldByClient: true }),
        row(3, { paperBatchId: "taco-40", paperTacoNumber: 40, paperTacoOrigin: "ARCHIVE" }),
        row(4, { paperBatchId: "taco-41", paperTacoNumber: 41, paperTacoOrigin: "ARCHIVE", paperTacoReturnedAt: RETURNED }),
        row(5, { paperBatchId: "taco-37" }),
      ],
      5,
    );
    expect(slots.map((slot) => [slot.kind, slot.label])).toEqual([
      ["electronic", "No es papel (original electrónico)"],
      ["client", "Lo guarda el cliente"],
      ["elsewhere", "Guardada en el Taco 40"],
      ["elsewhere", "Sacada: devuelta al cliente el 21/11/2026"],
      ["invoices", null],
    ]);
  });

  it("una rechazada sigue en su página: el papel está ahí", () => {
    const slot = perInvoice([row(1, { status: "REJECTED" })], 1)[0];
    expect(slot.kind).toBe("invoices");
  });

  it("una página con papel y una electrónica cuenta como papel", () => {
    const slot = perInvoice([row(1, { medium: "ELECTRONIC", splitPart: 1 }), row(1, { splitPart: 2 })], 1)[0];
    expect([slot.kind, slot.label]).toEqual(["invoices", "2 facturas en el mismo papel"]);
  });

  it("filas en desorden y más allá de fileCount: no se pierde ninguna", () => {
    const rows = [row(5), row(2), row(null), row(1)];
    const slots = perInvoice(rows, 3);
    expect(slots.map((slot) => [slot.page, slot.rows.length])).toEqual([[1, 1], [2, 1], [3, 0], [4, 0], [5, 1]]);
  });

  it("taco entero dividido con inicios 3, 5 y 9 de 12: rangos con su orden y «sin factura» delante", () => {
    const rows = [row(9), row(3), row(5)];
    const slots = tacoSlots({ batchId: "taco-38", fileCount: 1, wholePdf: true, pdfPageCount: 12, split: true, rows });
    expect(slots.map((slot) => [slot.page, slot.endPage, slot.order, slot.kind, slot.label])).toEqual([
      [1, 2, null, "empty", "Sin factura"],
      [3, 4, 1, "invoices", null],
      [5, 8, 2, "invoices", null],
      [9, 12, 3, "invoices", null],
    ]);
    expect(slots.map((slot) => pageRangeLabel(slot.page, slot.endPage))).toEqual(["1-2", "3-4", "5-8", "9-12"]);
  });

  it("taco entero: una factura dividida en la revisión comparte el rango de su página", () => {
    const root = row(1, { status: "SPLIT_SOURCE" });
    const rows = [root, row(1, { splitFromId: root.invoiceId, splitPart: 1 }), row(1, { splitFromId: root.invoiceId, splitPart: 2 }), row(4)];
    const slots = tacoSlots({ batchId: "taco-38", fileCount: 1, wholePdf: true, pdfPageCount: 6, split: true, rows });
    expect(slots.map((slot) => [slot.page, slot.endPage, slot.order, slot.rows.length, slot.label])).toEqual([
      [1, 3, 1, 2, "2 facturas en el mismo papel"],
      [4, 6, 2, 1, null],
    ]);
  });

  it("taco entero sin dividir: nada", () => {
    expect(tacoSlots({ batchId: "taco-38", fileCount: 1, wholePdf: true, pdfPageCount: 87, split: false, rows: [] })).toEqual([]);
  });
});

describe("etiquetas", () => {
  it("taco, rango y orden", () => {
    expect(tacoLabel(37)).toBe("Taco 37");
    expect(tacoShortLabel(37)).toBe("T37");
    expect(pageRangeLabel(12, 12)).toBe("12");
    expect(pageRangeLabel(27, 29)).toBe("27-29");
    expect(invoiceOrderLabel(12)).toBe("12.ª");
  });
});

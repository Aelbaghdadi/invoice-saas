// Lotes al subir y al mover (lo pidió un asesor: «cuando hay un lote y subo
// más facturas del mismo, que las ponga en el mismo lote»).
import { describe, it, expect } from "vitest";
import {
  batchLabel,
  defaultUploadTarget,
  isPeriodClosed,
  matchingOpenBatches,
  moveTargetsFor,
  openBatchCounts,
  overlappingOpenBatches,
  parseBatchPeriod,
  periodsOverlap,
  pickBatchLabel,
  planBatchMove,
  storedPeriodMonth,
  uploadNotice,
  type ClosedPeriod,
  type MoveRow,
  type OpenBatch,
  type UploadSelection,
} from "@/lib/batchTarget";
import { previousPeriod } from "@/lib/period";
import { previousPeriod as previousPeriodFromExportPage } from "@/lib/exportPage";

// 15 de noviembre de 2026, 12:00 en Madrid.
const now = new Date("2026-11-15T11:00:00Z");

const lot = (over: Partial<OpenBatch> = {}): OpenBatch => ({
  clientId: "c1",
  periodType: "MONTHLY",
  periodMonth: 10,
  periodYear: 2026,
  type: "PURCHASE",
  pending: 12,
  toExport: 0,
  ...over,
});
const octubre = lot();
const noviembre = lot({ periodMonth: 11, pending: 30 });
const septiembre = lot({ periodMonth: 9, pending: 1 });
const t4 = lot({ periodType: "QUARTERLY", periodMonth: 10, pending: 5 });
const t3 = lot({ periodType: "QUARTERLY", periodMonth: 7, pending: 2 });

const target = (
  openBatches: OpenBatch[],
  type: UploadSelection["type"] = "PURCHASE",
  lastPeriodType: "MONTHLY" | "QUARTERLY" | null = "MONTHLY",
  at = now,
  closedPeriods: ClosedPeriod[] = [],
) => defaultUploadTarget({ openBatches, type, lastPeriodType, closedPeriods, now: at });

// 15 de octubre de 2026 y 20 de enero de 2027, a mediodía en Madrid.
const octubre2026 = new Date("2026-10-15T10:00:00Z");
const enero2027 = new Date("2027-01-20T11:00:00Z");

describe("defaultUploadTarget: el lote que propone «Subir facturas»", () => {
  it("con un lote abierto del tipo elegido, ese", () => {
    expect(target([octubre])).toEqual({ periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, batch: octubre });
  });

  it("con octubre y noviembre abiertos, el del periodo anterior (octubre)", () => {
    expect(target([noviembre, octubre]).batch).toBe(octubre);
  });

  it("solo con el del mes en curso abierto, ese", () => {
    expect(target([noviembre])).toMatchObject({ periodMonth: 11, periodYear: 2026, batch: noviembre });
  });

  it("un lote viejo con algo atascado no se lleva lo nuevo: el periodo anterior", () => {
    expect(target([septiembre])).toEqual({ periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, batch: null });
  });

  it("uno de un mes que aún no ha llegado, tampoco", () => {
    expect(target([lot({ periodMonth: 12 })]).batch).toBeNull();
  });

  it("uno del otro tipo no cuenta; con «Detectar automáticamente», sí", () => {
    const emitidas = lot({ type: "SALE" });
    expect(target([emitidas], "PURCHASE").batch).toBeNull();
    expect(target([emitidas], "SALE").batch).toBe(emitidas);
    expect(target([emitidas], "UNKNOWN").batch).toBe(emitidas);
  });

  it("un T4 abierto cubre octubre: se propone aunque el cliente suba en mensual", () => {
    expect(target([t4])).toEqual({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, batch: t4 });
  });

  it("cliente trimestral en noviembre: el T4 (el trimestre de octubre), no un T3 con restos", () => {
    expect(target([t3, t4], "PURCHASE", "QUARTERLY").batch).toBe(t4);
    // El T3 sigue en la lista para elegirlo a mano, pero no se lleva la subida.
    expect(target([t3], "PURCHASE", "QUARTERLY")).toEqual({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, batch: null });
  });

  it("cliente trimestral en octubre: el T3 (el trimestre de septiembre)", () => {
    expect(target([t3, t4], "PURCHASE", "QUARTERLY", octubre2026).batch).toBe(t3);
    expect(target([], "PURCHASE", "QUARTERLY", octubre2026)).toEqual({ periodType: "QUARTERLY", periodMonth: 7, periodYear: 2026, batch: null });
  });

  it("entre dos del mismo periodo («Detectar automáticamente»), el que tiene más por revisar", () => {
    const recibidas = lot({ pending: 2 });
    const emitidas = lot({ type: "SALE", pending: 7 });
    expect(target([recibidas, emitidas], "UNKNOWN").batch).toBe(emitidas);
  });

  it("sin lotes abiertos: el periodo del mes anterior, con la agrupación de la última subida", () => {
    // En trimestral, el trimestre de octubre (T4), no el anterior (T3) que propone Exportar.
    expect(target([], "PURCHASE", "QUARTERLY")).toEqual({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, batch: null });
    // Sin subidas: mensual.
    expect(target([], "PURCHASE", null)).toEqual({ periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, batch: null });
  });

  it("en enero, diciembre del año anterior (y su lote, si está abierto); en trimestral, su T4", () => {
    expect(target([], "PURCHASE", "MONTHLY", enero2027)).toMatchObject({ periodMonth: 12, periodYear: 2026, batch: null });
    const diciembre = lot({ periodMonth: 12 });
    expect(target([diciembre], "PURCHASE", "MONTHLY", enero2027).batch).toBe(diciembre);
    expect(target([], "PURCHASE", "QUARTERLY", enero2027)).toEqual({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, batch: null });
    expect(target([t4], "PURCHASE", "QUARTERLY", enero2027).batch).toBe(t4);
  });

  it("con el periodo del mes anterior cerrado, el que está en curso: en uno cerrado no se puede subir", () => {
    const octubreCerrado = [{ month: 10, year: 2026 }];
    expect(target([], "PURCHASE", "MONTHLY", now, octubreCerrado)).toEqual({ periodType: "MONTHLY", periodMonth: 11, periodYear: 2026, batch: null });
    // Un lote abierto en un periodo cerrado tampoco se propone.
    expect(target([octubre], "PURCHASE", "MONTHLY", now, octubreCerrado).batch).toBeNull();
    // Trimestral en octubre con el T3 cerrado (ya presentado): el T4.
    expect(target([], "PURCHASE", "QUARTERLY", octubre2026, [{ month: 7, year: 2026 }])).toMatchObject({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026 });
    // Si el que está en curso también está cerrado, se deja el del mes anterior: el formulario lo avisa.
    expect(target([], "PURCHASE", "MONTHLY", now, [...octubreCerrado, { month: 11, year: 2026 }])).toMatchObject({ periodMonth: 10, batch: null });
  });
});

describe("isPeriodClosed: con la clave del cierre, como la subida", () => {
  const cerrados = [{ month: 10, year: 2026 }];

  it("en trimestral cuenta el primer mes del trimestre", () => {
    expect(isPeriodClosed(cerrados, { periodType: "MONTHLY", periodMonth: 10, periodYear: 2026 })).toBe(true);
    expect(isPeriodClosed(cerrados, { periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026 })).toBe(true);
    expect(isPeriodClosed(cerrados, { periodType: "MONTHLY", periodMonth: 11, periodYear: 2026 })).toBe(false);
    expect(isPeriodClosed(cerrados, { periodType: "MONTHLY", periodMonth: 10, periodYear: 2025 })).toBe(false);
    expect(isPeriodClosed([], { periodType: "MONTHLY", periodMonth: 10, periodYear: 2026 })).toBe(false);
  });
});

describe("uploadNotice: a dónde van las facturas con lo elegido", () => {
  const recibidasOctubre: UploadSelection = { periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, type: "PURCHASE" };
  const emitidas = lot({ type: "SALE", pending: 5 });

  it("a un lote abierto: lo nombra con su tipo", () => {
    expect(uploadNotice(recibidasOctubre, [octubre], false)).toEqual({
      tone: "open",
      text: "Se añadirán al lote abierto de Octubre 2026 · Recibidas (12 por revisar). ¿Son de otro periodo? Cámbialo abajo.",
    });
  });

  it("sin lote abierto no dice que se abra uno: puede existir terminado", () => {
    expect(uploadNotice(recibidasOctubre, [], false)).toEqual({
      tone: "none",
      text: "No hay ningún lote abierto de Octubre 2026 · Recibidas: irán a ese periodo.",
    });
    expect(uploadNotice({ ...recibidasOctubre, type: "UNKNOWN" }, [], false).text).toBe(
      "No hay ningún lote abierto de Octubre 2026: irán a ese periodo.",
    );
  });

  it("con «Detectar automáticamente», cada una al lote de su tipo: dice cuáles están abiertos", () => {
    const auto = { ...recibidasOctubre, type: "UNKNOWN" as const };
    expect(uploadNotice(auto, [emitidas], false).text).toBe(
      "Irán a Octubre 2026, cada una al lote de su tipo: ya está abierto el de Emitidas (5 por revisar). ¿Son de otro periodo? Cámbialo abajo.",
    );
    expect(uploadNotice(auto, [octubre, emitidas], false).text).toBe(
      "Irán a Octubre 2026, cada una al lote de su tipo: ya están abiertos el de Recibidas (12 por revisar) y el de Emitidas (5 por revisar). ¿Son de otro periodo? Cámbialo abajo.",
    );
  });

  it("con el periodo cerrado, que no se puede subir", () => {
    expect(uploadNotice({ ...recibidasOctubre, periodType: "QUARTERLY" }, [], true)).toEqual({
      tone: "closed",
      text: "T4 2026 está cerrado para este cliente: no se pueden subir facturas. Elige otro periodo.",
    });
  });
});

describe("pickBatchLabel: el botón de cada lote abierto", () => {
  it("si es de otro tipo, dice que lo cambia; con «Detectar automáticamente», no lo cambia", () => {
    expect(pickBatchLabel("PURCHASE", "PURCHASE")).toBe("Añadir a este lote");
    expect(pickBatchLabel("SALE", "UNKNOWN")).toBe("Añadir a este lote");
    expect(pickBatchLabel("SALE", "PURCHASE")).toBe("Cambiar a emitidas y añadir");
    expect(pickBatchLabel("PURCHASE", "SALE")).toBe("Cambiar a recibidas y añadir");
  });
});

describe("lote elegido y solapes mensual/trimestral", () => {
  const elegido = (over: Partial<UploadSelection> = {}): UploadSelection => ({
    periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, type: "PURCHASE", ...over,
  });

  it("el lote abierto que coincide con lo elegido: mismo periodo, agrupación y tipo", () => {
    const emitidas = lot({ type: "SALE" });
    expect(matchingOpenBatches([octubre, emitidas, t4], elegido())).toEqual([octubre]);
    expect(matchingOpenBatches([octubre, emitidas, t4], elegido({ type: "UNKNOWN" }))).toEqual([octubre, emitidas]);
    expect(matchingOpenBatches([octubre], elegido({ periodMonth: 11 }))).toEqual([]);
  });

  it("octubre con un T4 abierto: avisa del T4", () => {
    expect(overlappingOpenBatches([octubre, t4], elegido())).toEqual([t4]);
  });

  it("T4 con octubre y noviembre abiertos: avisa de los dos", () => {
    expect(overlappingOpenBatches([octubre, noviembre, septiembre, t4], elegido({ periodType: "QUARTERLY" }))).toEqual([octubre, noviembre]);
  });

  it("sin meses en común, del otro tipo o con la misma agrupación, nada", () => {
    expect(overlappingOpenBatches([t3], elegido())).toEqual([]);
    expect(overlappingOpenBatches([lot({ periodType: "QUARTERLY", type: "SALE" })], elegido())).toEqual([]);
    expect(overlappingOpenBatches([noviembre], elegido())).toEqual([]);
    // Con «Detectar automáticamente», el del otro tipo también.
    const t4Emitidas = lot({ periodType: "QUARTERLY", type: "SALE" });
    expect(overlappingOpenBatches([t4Emitidas], elegido({ type: "UNKNOWN" }))).toEqual([t4Emitidas]);
  });

  it("los meses se cuentan a través del cambio de año", () => {
    const diciembre = { periodType: "MONTHLY" as const, periodMonth: 12, periodYear: 2026 };
    expect(periodsOverlap(diciembre, { periodType: "QUARTERLY", periodMonth: 1, periodYear: 2027 })).toBe(false);
    expect(periodsOverlap(diciembre, { periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026 })).toBe(true);
  });

  it("en trimestral el mes se guarda como el primero del trimestre", () => {
    expect(storedPeriodMonth("QUARTERLY", 11)).toBe(10);
    expect(storedPeriodMonth("QUARTERLY", 1)).toBe(1);
    expect(storedPeriodMonth("MONTHLY", 11)).toBe(11);
  });
});

describe("textos de los lotes", () => {
  it("como en las tarjetas de Lotes", () => {
    expect(batchLabel(octubre)).toBe("Octubre 2026 · Recibidas");
    expect(batchLabel({ ...t4, type: "SALE" })).toBe("T4 2026 · Emitidas");
  });

  it("lo que tiene pendiente", () => {
    expect(openBatchCounts({ pending: 12, toExport: 0 })).toBe("12 por revisar");
    expect(openBatchCounts({ pending: 0, toExport: 1 })).toBe("1 validada sin exportar");
    expect(openBatchCounts({ pending: 12, toExport: 3 })).toBe("12 por revisar y 3 validadas sin exportar");
  });
});

describe("planBatchMove: qué se mueve de un lote", () => {
  const row = (id: string, status: MoveRow["status"], over: Partial<MoveRow> = {}): MoveRow => ({
    id, status, splitFromId: null, everExported: false, ...over,
  });

  it("se mueve todo lo que no salió en un Excel; lo exportado (y el EXPORTED de antes) se queda", () => {
    const plan = planBatchMove([
      row("pendiente", "PENDING_REVIEW"),
      row("ocr", "ANALYZING"),
      row("validada", "VALIDATED"),
      row("rechazada", "REJECTED"),
      row("exportada", "VALIDATED", { everExported: true }),
      row("legacy", "EXPORTED"),
    ]);
    expect(plan.moveIds.sort()).toEqual(["ocr", "pendiente", "rechazada", "validada"]);
    expect([plan.moved, plan.stay]).toEqual([4, 2]);
  });

  it("la original de una división va con sus hijas y no cuenta como factura", () => {
    const plan = planBatchMove([
      row("original", "SPLIT_SOURCE"),
      row("hija1", "PENDING_REVIEW", { splitFromId: "original" }),
      row("hija2", "VALIDATED", { splitFromId: "original", everExported: true }),
      // Sus hijas ya están en un Excel: se queda con ellas.
      row("original2", "SPLIT_SOURCE"),
      row("hija3", "VALIDATED", { splitFromId: "original2", everExported: true }),
    ]);
    expect(plan.moveIds.sort()).toEqual(["hija1", "original"]);
    expect([plan.moved, plan.stay]).toEqual([1, 2]);
  });

  it("un lote vacío o todo exportado: nada que mover", () => {
    expect(planBatchMove([])).toEqual({ moveIds: [], moved: 0, stay: 0 });
    expect(planBatchMove([row("x", "VALIDATED", { everExported: true })])).toEqual({ moveIds: [], moved: 0, stay: 1 });
  });
});

describe("moveTargetsFor: a qué lotes se puede mover uno", () => {
  const card = { clientId: "c1", periodType: "MONTHLY" as const, periodMonth: 11, periodYear: 2026, type: "PURCHASE" as const, total: 30 };
  const lots = [
    card,
    { ...card, periodMonth: 9, total: 4 },
    { ...card, periodMonth: 10, total: 12 },
    { ...card, periodType: "QUARTERLY" as const, periodMonth: 10, total: 5 },
    { ...card, periodMonth: 10, type: "SALE" as const, total: 8 },
    { ...card, clientId: "c2", periodMonth: 10, total: 9 },
  ];

  it("los demás del mismo cliente y tipo, los más recientes primero; los cerrados, marcados", () => {
    const targets = moveTargetsFor(card, lots, (l) => l.periodMonth === 9);
    expect(targets).toEqual([
      { periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, total: 12, closed: false },
      { periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, total: 5, closed: false },
      { periodType: "MONTHLY", periodMonth: 9, periodYear: 2026, total: 4, closed: true },
    ]);
  });
});

describe("parseBatchPeriod: el periodo que llega del formulario", () => {
  it("mensual tal cual; en trimestral, el primer mes del trimestre", () => {
    expect(parseBatchPeriod({ periodType: "MONTHLY", month: "11", year: "2026" })).toEqual({ periodType: "MONTHLY", periodMonth: 11, periodYear: 2026 });
    expect(parseBatchPeriod({ periodType: "QUARTERLY", month: "11", year: "2026" })).toEqual({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026 });
  });

  it.each([
    ["una agrupación que no existe", { periodType: "ANUAL", month: "11", year: "2026" }],
    ["el mes 13", { periodType: "MONTHLY", month: "13", year: "2026" }],
    ["el mes 0", { periodType: "MONTHLY", month: "0", year: "2026" }],
    ["un mes vacío", { periodType: "MONTHLY", month: "", year: "2026" }],
    ["un mes con decimales", { periodType: "MONTHLY", month: "10.5", year: "2026" }],
    ["un año fuera de rango", { periodType: "MONTHLY", month: "11", year: "1999" }],
    ["un año que no es un número", { periodType: "MONTHLY", month: "11", year: "abc" }],
    ["sin campos", { periodType: null, month: null, year: null }],
  ])("%s: null", (_caso, raw) => {
    expect(parseBatchPeriod(raw)).toBeNull();
  });
});

describe("previousPeriod", () => {
  it("vive en period.ts y Exportar lo sigue importando de exportPage", () => {
    expect(previousPeriodFromExportPage).toBe(previousPeriod);
    expect(previousPeriod("MONTHLY", now)).toEqual({ month: 10, year: 2026 });
  });
});

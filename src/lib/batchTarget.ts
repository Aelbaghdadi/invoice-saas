/**
 * A qué lote van las facturas: el que propone «Subir facturas» y los lotes a
 * los que se puede mover uno desde Lotes. Sin Prisma ni Next: lo usan el
 * formulario de subida (en el navegador), las pantallas de Lotes y la acción
 * de mover.
 *
 * Un lote es cliente + periodo + agrupación (mensual o trimestral; en
 * trimestral el periodo es su primer mes) + tipo, la misma clave que batchKey
 * (batchGroups.ts). Octubre y T4 son lotes distintos aunque compartan meses.
 */
import type { InvoiceStatus } from "@prisma/client";
import { yearMonthInMadrid } from "@/lib/dates";
import { periodLabel, previousPeriod, quarterFromMonth, quarterStartMonth, type PeriodTypeName } from "@/lib/period";

export type BatchInvoiceType = "PURCHASE" | "SALE";

/** Periodo de un lote, con su agrupación. */
export type BatchPeriod = {
  periodType: PeriodTypeName;
  /** En trimestral, el primer mes del trimestre. */
  periodMonth: number;
  periodYear: number;
};

/** Periodo y tipo de un lote (el cliente va aparte). */
export type BatchRef = BatchPeriod & { type: BatchInvoiceType };

/** Un lote con algo pendiente: por revisar o validadas sin exportar. */
export type OpenBatch = BatchRef & {
  clientId: string;
  /** Por revisar, también las que el OCR aún está leyendo. */
  pending: number;
  /** Validadas que no van en ningún Excel. */
  toExport: number;
};

/** Lo que se elige al subir: el tipo puede ser «Detectar automáticamente». */
export type UploadSelection = BatchPeriod & { type: BatchInvoiceType | "UNKNOWN" };

/** Un periodo de un cliente con cierre activo, con la clave de PeriodClosure. */
export type ClosedPeriod = { month: number; year: number };

const TYPE_LABEL: Record<BatchInvoiceType, string> = { PURCHASE: "Recibidas", SALE: "Emitidas" };

/** «Octubre 2026 · Recibidas», como lo pintan las tarjetas de Lotes. */
export function batchLabel(ref: BatchRef): string {
  return `${periodLabel(ref.periodType, ref.periodMonth, ref.periodYear)} · ${TYPE_LABEL[ref.type]}`;
}

/** «12 por revisar», «3 validadas sin exportar» o las dos cosas. */
export function openBatchCounts(batch: Pick<OpenBatch, "pending" | "toExport">): string {
  const parts: string[] = [];
  if (batch.pending > 0) parts.push(`${batch.pending} por revisar`);
  if (batch.toExport > 0) parts.push(`${batch.toExport} validada${batch.toExport !== 1 ? "s" : ""} sin exportar`);
  return parts.join(" y ");
}

/** El mes como se guarda: en trimestral, el primero del trimestre. */
export function storedPeriodMonth(periodType: PeriodTypeName, month: number): number {
  return periodType === "QUARTERLY" ? quarterStartMonth(quarterFromMonth(month)) : month;
}

/** Meses que cubre un periodo, como índices (año × 12 + mes − 1). */
export function periodSpan(period: BatchPeriod): { from: number; to: number } {
  const from = period.periodYear * 12 + storedPeriodMonth(period.periodType, period.periodMonth) - 1;
  return { from, to: period.periodType === "QUARTERLY" ? from + 2 : from };
}

/** ¿Comparten algún mes? Octubre y T4 sí; T3 y octubre no. */
export function periodsOverlap(a: BatchPeriod, b: BatchPeriod): boolean {
  const x = periodSpan(a);
  const y = periodSpan(b);
  return x.from <= y.to && y.from <= x.to;
}

/** Mismo periodo con la misma agrupación. */
export function samePeriod(a: BatchPeriod, b: BatchPeriod): boolean {
  return a.periodType === b.periodType && a.periodMonth === b.periodMonth && a.periodYear === b.periodYear;
}

/**
 * ¿Tiene cierre activo? Con la misma clave que comprueba la subida
 * (assertUploadPeriodOpen): el mes que se guarda, en trimestral el primero.
 */
export function isPeriodClosed(closedPeriods: ClosedPeriod[], period: BatchPeriod): boolean {
  const month = storedPeriodMonth(period.periodType, period.periodMonth);
  return closedPeriods.some((c) => c.month === month && c.year === period.periodYear);
}

/** El periodo con esta agrupación que contiene ese mes: en trimestral, su trimestre. */
function periodOfMonth(periodType: PeriodTypeName, month: number, year: number): BatchPeriod {
  return { periodType, periodMonth: storedPeriodMonth(periodType, month), periodYear: year };
}

// «Detectar automáticamente»: cada factura acaba en el lote de su tipo, así
// que vale el de cualquiera de los dos.
function typeMatches(batch: BatchRef, type: BatchInvoiceType | "UNKNOWN"): boolean {
  return type === "UNKNOWN" || batch.type === type;
}

/** Los lotes abiertos en los que caerían las facturas con lo elegido. */
export function matchingOpenBatches(openBatches: OpenBatch[], selection: UploadSelection): OpenBatch[] {
  return openBatches.filter((b) => samePeriod(b, selection) && typeMatches(b, selection.type));
}

/**
 * Lotes abiertos con la otra agrupación que comparten meses con lo elegido:
 * un T4 abierto al elegir octubre, u octubre y noviembre al elegir T4.
 */
export function overlappingOpenBatches(openBatches: OpenBatch[], selection: UploadSelection): OpenBatch[] {
  return openBatches.filter(
    (b) => b.periodType !== selection.periodType && periodsOverlap(b, selection) && typeMatches(b, selection.type),
  );
}

export type UploadTarget = BatchPeriod & {
  /** El lote abierto que se propone, o null si las facturas abren uno. */
  batch: OpenBatch | null;
};

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * El periodo que propone «Subir facturas» al elegir cliente o tipo:
 * - Un lote abierto del cliente de ese tipo, si lo hay: es lo que pidió el
 *   asesor («que las ponga en el mismo lote»). Solo desde el periodo del mes
 *   anterior: un lote viejo con una factura atascada no se tiene que llevar
 *   lo que se sube ahora, ni uno de un mes que aún no ha llegado. Entre
 *   varios, el de ese periodo.
 * - Si no, el periodo del mes anterior: las facturas se suben de media un mes
 *   después de su fecha (las de octubre, en noviembre). En trimestral, el
 *   trimestre de ese mes: en noviembre el T4, no el T3 que propone Exportar,
 *   que ya está terminado. Con la agrupación de la última subida del cliente,
 *   o mensual si no hay.
 * - Si ese periodo está cerrado (ya se procesó y se cerró), el que está en
 *   curso: en un periodo cerrado la subida se rechaza. Si también lo está, se
 *   deja el del mes anterior y el formulario avisa.
 */
export function defaultUploadTarget(input: {
  openBatches: OpenBatch[];
  type: BatchInvoiceType | "UNKNOWN";
  lastPeriodType: PeriodTypeName | null;
  /** Periodos del cliente con cierre activo (loadOpenBatches). */
  closedPeriods?: ClosedPeriod[];
  now?: Date;
}): UploadTarget {
  const now = input.now ?? new Date();
  const closedPeriods = input.closedPeriods ?? [];
  const periodType = input.lastPeriodType ?? "MONTHLY";
  const lastMonth = previousPeriod("MONTHLY", now);
  const expected = periodOfMonth(periodType, lastMonth.month, lastMonth.year);
  const today = yearMonthInMadrid(now);
  const current = periodOfMonth(periodType, today.month, today.year);
  const currentIndex = today.year * 12 + today.month - 1;
  const earliest = periodSpan(expected).from;

  const candidates = input.openBatches.filter((b) => {
    const span = periodSpan(b);
    return typeMatches(b, input.type) && span.to >= earliest && span.from <= currentIndex && !isPeriodClosed(closedPeriods, b);
  });
  const rank = (b: OpenBatch) => [
    samePeriod(b, expected) ? 0 : 1,
    periodsOverlap(b, expected) ? 0 : 1,
    b.periodType === periodType ? 0 : 1,
    -periodSpan(b).from,
    -b.pending,
  ];
  const batch = [...candidates].sort((a, b) => compareRanks(rank(a), rank(b)))[0] ?? null;
  if (batch) return { periodType: batch.periodType, periodMonth: batch.periodMonth, periodYear: batch.periodYear, batch };
  const period = [expected, current].find((p) => !isPeriodClosed(closedPeriods, p)) ?? expected;
  return { ...period, batch: null };
}

/** Lo que se dice bajo los lotes abiertos: a dónde van las facturas con lo elegido. */
export type UploadNotice = {
  /** «closed»: periodo cerrado, no se puede subir; «open»: a un lote abierto; «none»: sin lote abierto. */
  tone: "closed" | "open" | "none";
  text: string;
};

/**
 * El aviso del formulario de subida. Con un tipo elegido nombra el lote
 * entero, tipo incluido. Con «Detectar automáticamente» cada factura va al
 * lote de su tipo, así que dice cuáles de ese periodo están abiertos. Sin
 * lote abierto no dice «se abrirá un lote»: puede que ya exista terminado y
 * las facturas vayan a él.
 */
export function uploadNotice(selection: UploadSelection, matching: OpenBatch[], closed: boolean): UploadNotice {
  const label = periodLabel(selection.periodType, selection.periodMonth, selection.periodYear);
  if (closed) {
    return { tone: "closed", text: `${label} está cerrado para este cliente: no se pueden subir facturas. Elige otro periodo.` };
  }
  const change = "¿Son de otro periodo? Cámbialo abajo.";
  if (selection.type === "UNKNOWN") {
    if (matching.length === 0) return { tone: "none", text: `No hay ningún lote abierto de ${label}: irán a ese periodo.` };
    const open = matching.map((b) => `el de ${TYPE_LABEL[b.type]} (${openBatchCounts(b)})`).join(" y ");
    const verb = matching.length === 1 ? "está abierto" : "están abiertos";
    return { tone: "open", text: `Irán a ${label}, cada una al lote de su tipo: ya ${verb} ${open}. ${change}` };
  }
  const batch = matching.find((b) => b.type === selection.type);
  if (!batch) {
    return { tone: "none", text: `No hay ningún lote abierto de ${batchLabel({ ...selection, type: selection.type })}: irán a ese periodo.` };
  }
  return { tone: "open", text: `Se añadirán al lote abierto de ${batchLabel(batch)} (${openBatchCounts(batch)}). ${change}` };
}

/**
 * El botón de un lote abierto al subir. Si es del otro tipo, elegirlo cambia
 * también el tipo de lo que se sube, y el botón lo dice. Con «Detectar
 * automáticamente» solo se toma el periodo.
 */
export function pickBatchLabel(batchType: BatchInvoiceType, selectedType: BatchInvoiceType | "UNKNOWN"): string {
  if (selectedType === "UNKNOWN" || batchType === selectedType) return "Añadir a este lote";
  return `Cambiar a ${batchType === "SALE" ? "emitidas" : "recibidas"} y añadir`;
}

/** Un lote al que se puede mover otro, desde la tarjeta de Lotes. */
export type MoveTarget = BatchPeriod & {
  total: number;
  /** Periodo con cierre activo: se enseña, pero la acción lo rechaza. */
  closed: boolean;
};

/** Los demás lotes del mismo cliente y tipo, los más recientes primero. */
export function moveTargetsFor<T extends BatchRef & { clientId: string; total: number }>(
  lot: BatchRef & { clientId: string },
  lots: T[],
  isClosed: (lot: T) => boolean,
): MoveTarget[] {
  return lots
    .filter((l) => l.clientId === lot.clientId && l.type === lot.type && !samePeriod(l, lot))
    .sort((a, b) =>
      periodSpan(b).from - periodSpan(a).from
      || (a.periodType === b.periodType ? 0 : a.periodType === "MONTHLY" ? -1 : 1))
    .map((l) => ({
      periodType: l.periodType,
      periodMonth: l.periodMonth,
      periodYear: l.periodYear,
      total: l.total,
      closed: isClosed(l),
    }));
}

/** Una factura del lote que se quiere mover, con lo justo para decidir. */
export type MoveRow = {
  id: string;
  status: InvoiceStatus;
  splitFromId: string | null;
  /** Salió alguna vez en un Excel (tiene ExportBatchItem). */
  everExported: boolean;
};

/**
 * Qué facturas de un lote se mueven:
 * - Las que ya salieron en un Excel se quedan: están en la contabilidad del
 *   cliente con el periodo de este lote. EXPORTED (legacy) es lo mismo.
 * - La original de una división (SPLIT_SOURCE) va con sus hijas: se mueve si
 *   se mueve alguna.
 * `moved` y `stay` cuentan facturas, sin las originales (el lote tampoco las
 * cuenta).
 */
export function planBatchMove(rows: MoveRow[]): { moveIds: string[]; moved: number; stay: number } {
  const invoices = rows.filter((r) => r.status !== "SPLIT_SOURCE");
  const moving = invoices.filter((r) => !r.everExported && r.status !== "EXPORTED");
  const parents = new Set(moving.flatMap((r) => (r.splitFromId ? [r.splitFromId] : [])));
  const originals = rows.filter((r) => r.status === "SPLIT_SOURCE" && parents.has(r.id));
  return {
    moveIds: [...moving, ...originals].map((r) => r.id),
    moved: moving.length,
    stay: invoices.length - moving.length,
  };
}

/** Periodo que llega de un formulario, o null si algo no vale. */
export function parseBatchPeriod(raw: { periodType: unknown; month: unknown; year: unknown }): BatchPeriod | null {
  const periodType = raw.periodType === "MONTHLY" || raw.periodType === "QUARTERLY" ? raw.periodType : null;
  const month = typeof raw.month === "string" && raw.month.trim() ? Number(raw.month) : NaN;
  const year = typeof raw.year === "string" && raw.year.trim() ? Number(raw.year) : NaN;
  if (!periodType || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { periodType, periodMonth: storedPeriodMonth(periodType, month), periodYear: year };
}

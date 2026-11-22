/**
 * Cifras del archivo por cliente y ejercicio (las del anexo de la entrega A,
 * que sustituyen a R21 en la interfaz): Facturas · Recibidas · Emitidas ·
 * Electrónico · Papel · Por confirmar · Registradas · Sin registrar ·
 * Conservar más · Conservar hasta, y aparte las rechazadas. Con la entrega
 * del papel, también el papel y lo «Por confirmar» sin ubicación (B-R13).
 * Módulo puro: las filas las agrupa la BD (loadArchiveMetricsRows) y la
 * pestaña Archivo de un cliente suma aquí las suyas, para que las dos pantallas
 * digan lo mismo.
 */
import type { InvoiceStatus, InvoiceType, OriginalMedium } from "@prisma/client";
import { fiscalYearLabel, fiscalYearOf, retainUntil, type ArchivePeriodFields, type FiscalYear } from "@/lib/archiveRules";
import { IN_ANALYSIS, PENDING_WORK } from "@/lib/invoiceStatuses";
import { invoicePeriod } from "@/lib/period";

/** No están en el archivo: la original de una división (cuentan sus partes)
 *  y lo que sigue en el buzón por clasificar. */
export const ARCHIVE_EXCLUDED_STATUSES: InvoiceStatus[] = ["SPLIT_SOURCE", "PENDING_ROUTING"];

export function isInArchive(status: InvoiceStatus): boolean {
  return !ARCHIVE_EXCLUDED_STATUSES.includes(status);
}

/** Facturas (o un grupo de facturas iguales a estos efectos). */
export type ArchiveMetricsRow = ArchivePeriodFields & {
  clientId: string;
  type: InvoiceType;
  status: InvoiceStatus;
  /** null = «Por confirmar». */
  medium: OriginalMedium | null;
  registered: boolean;
  retentionHold: boolean;
  /** La fecha de factura más tardía del grupo: con ella sale el «conservar
   *  hasta» más tardío. */
  lastInvoiceDate: Date | null;
  count: number;
  /** ¿Tiene ubicación? En un taco (de llegada con nº o puesto a mano) o la
   *  guarda el cliente (B-R13). undefined = no se sabe y no cuenta. */
  located?: boolean;
};

export type ArchiveCell = {
  /** Sin las rechazadas, que van aparte. */
  invoices: number;
  received: number;
  issued: number;
  electronic: number;
  paper: number;
  /** Medio null: «Por confirmar». No cuenta como papel. */
  unconfirmed: number;
  /** «Papel sin ubicación» (B-R13): papel que no está en ningún taco ni lo guarda el cliente. */
  paperWithoutLocation: number;
  /** «Por confirmar» sin ubicación (sin las que aún se analizan): va al lado
   *  de la anterior, porque todo el papel de antes del archivo está «Por confirmar». */
  unconfirmedWithoutLocation: number;
  registered: number;
  unregistered: number;
  /** «Conservar más». */
  retentionHold: number;
  /** Lo más tardío de lo que no se conserva de más (rechazadas incluidas:
   *  también se conservan). null si no hay ninguna con fecha. */
  retainUntil: Date | null;
  rejected: number;
  /** Aún sin validar (subidas, en análisis, por revisar…). */
  pendingValidation: number;
};

export function emptyArchiveCell(): ArchiveCell {
  return {
    invoices: 0,
    received: 0,
    issued: 0,
    electronic: 0,
    paper: 0,
    unconfirmed: 0,
    paperWithoutLocation: 0,
    unconfirmedWithoutLocation: 0,
    registered: 0,
    unregistered: 0,
    retentionHold: 0,
    retainUntil: null,
    rejected: 0,
    pendingValidation: 0,
  };
}

/** Ejercicio de una factura: el que contiene el primer mes de su periodo de
 *  deducción (R3). */
export function archiveFiscalYearOf(row: ArchivePeriodFields, fiscalYearStartMonth: number): FiscalYear {
  const { year, month } = invoicePeriod(row);
  return fiscalYearOf(year, month, fiscalYearStartMonth);
}

/** Suma una fila (o un grupo) a las cifras de su ejercicio. */
export function addToArchiveCell(cell: ArchiveCell, row: ArchiveMetricsRow, fiscalYearStartMonth: number): void {
  if (!isInArchive(row.status)) return;
  if (!row.retentionHold) {
    const until = retainUntil({ ...row, invoiceDate: row.lastInvoiceDate }, fiscalYearStartMonth);
    if (until && (!cell.retainUntil || until.getTime() > cell.retainUntil.getTime())) cell.retainUntil = until;
  }
  if (row.status === "REJECTED") {
    cell.rejected += row.count;
    return;
  }
  cell.invoices += row.count;
  if (row.type === "PURCHASE") cell.received += row.count;
  else cell.issued += row.count;
  if (row.medium === "ELECTRONIC") cell.electronic += row.count;
  else if (row.medium === "PAPER") cell.paper += row.count;
  else cell.unconfirmed += row.count;
  if (row.located === false) {
    if (row.medium === "PAPER") cell.paperWithoutLocation += row.count;
    // Lo que aún se analiza no se ofrece para ubicar: el análisis puede decir que es electrónica.
    else if (row.medium == null && !IN_ANALYSIS.includes(row.status)) cell.unconfirmedWithoutLocation += row.count;
  }
  if (row.registered) cell.registered += row.count;
  else cell.unregistered += row.count;
  if (row.retentionHold) cell.retentionHold += row.count;
  if (PENDING_WORK.includes(row.status)) cell.pendingValidation += row.count;
}

export type ArchiveMetricsYear = ArchiveCell & FiscalYear;

export type ArchiveMetricsClient = {
  clientId: string;
  name: string;
  fiscalYearStartMonth: number;
  /** Del más reciente al más antiguo; solo los que tienen facturas. */
  years: ArchiveMetricsYear[];
};

export type ArchiveMetrics = {
  /** En el orden en que llegan los clientes. */
  clients: ArchiveMetricsClient[];
  /** Años de inicio de ejercicio con alguna factura, del más reciente al más
   *  antiguo: las columnas de la matriz. */
  startYears: number[];
  /** Suma de todos los clientes por año de inicio, en el mismo orden. Con
   *  ejercicios de distinto inicio, la etiqueta es la del año natural. */
  totals: ArchiveMetricsYear[];
};

/**
 * Matriz cliente × ejercicio. Cada cliente agrupa por su propio ejercicio
 * (fiscalYearStartMonth); las filas de clientes que no vienen en `clients`
 * se ignoran.
 */
export function buildArchiveMetrics(
  rows: readonly ArchiveMetricsRow[],
  clients: readonly { id: string; name: string; fiscalYearStartMonth: number }[],
): ArchiveMetrics {
  const byClient = new Map<string, { client: (typeof clients)[number]; years: Map<number, ArchiveMetricsYear> }>();
  for (const client of clients) byClient.set(client.id, { client, years: new Map() });

  const totals = new Map<number, ArchiveMetricsYear>();
  for (const row of rows) {
    const entry = byClient.get(row.clientId);
    if (!entry || !isInArchive(row.status)) continue;
    const startMonth = entry.client.fiscalYearStartMonth;
    const fiscalYear = archiveFiscalYearOf(row, startMonth);
    let cell = entry.years.get(fiscalYear.startYear);
    if (!cell) {
      cell = { ...emptyArchiveCell(), ...fiscalYear };
      entry.years.set(fiscalYear.startYear, cell);
    }
    addToArchiveCell(cell, row, startMonth);

    let total = totals.get(fiscalYear.startYear);
    if (!total) {
      total = { ...emptyArchiveCell(), startYear: fiscalYear.startYear, label: fiscalYearLabel(fiscalYear.startYear, 1) };
      totals.set(fiscalYear.startYear, total);
    }
    addToArchiveCell(total, row, startMonth);
  }

  const descending = (a: number, b: number) => b - a;
  return {
    clients: [...byClient.values()].map(({ client, years }) => ({
      clientId: client.id,
      name: client.name,
      fiscalYearStartMonth: client.fiscalYearStartMonth,
      years: [...years.values()].sort((a, b) => descending(a.startYear, b.startYear)),
    })),
    startYears: [...totals.keys()].sort(descending),
    totals: [...totals.values()].sort((a, b) => descending(a.startYear, b.startYear)),
  };
}

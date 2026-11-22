/**
 * Lectura de tandas y tacos (entrega B): la pestaña Tacos del archivo, el
 * detalle de una tanda o taco con sus páginas (y su hoja para imprimir) y los
 * avisos del Resumen. Todo pasa por uploadBatchVisibleWhere (B-R20: una sola
 * definición de quién ve una tanda) y va acotado a la asesoría.
 *
 * Como el archivo, los tacos de la asesoría se filtran y paginan en memoria:
 * son cientos, no millones, y el estado de un taco (sin guardar, vacío…)
 * depende de sus facturas.
 */
import { Prisma, type InvoiceType, type PeriodType, type UploadBatchOrigin } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadBatchVisibleWhere, type TacoViewer } from "@/lib/archiveAccess";
import { compareArchiveOrder, fiscalYearLabel, retainUntil } from "@/lib/archiveRules";
import { ARCHIVE_EXCLUDED_STATUSES } from "@/lib/archiveMetrics";
import { boxLabelKey } from "@/lib/boxProposal";
import { IN_ANALYSIS } from "@/lib/invoiceStatuses";
import { pageWindow, PAGE_SIZE, type PageWindow } from "@/lib/listing";
import { mediumReasonLabel } from "@/lib/originalMedium";
import { tacoSlots, tacoState, tacoStateLabel, type TacoSlot, type TacoSlotRow, type TacoState } from "@/lib/paperLocation";
import { formatRegisterNumber } from "@/lib/registerNumbers";
import { invoiceCountText, tacoLotLabel } from "@/lib/tacoSplitReview";
import { pendingTacoSplits, type PendingTacoSplit } from "@/lib/tacoSplit";
import type { TacoListEstado } from "@/lib/tacoListParams";

const DAY_MS = 24 * 60 * 60 * 1000;
/** «Subidas digitales»: las de los últimos 30 días (para «Era papel: crear taco»). */
export const DIGITAL_BATCHES_DAYS = 30;

// ── Lo común ────────────────────────────────────────────────────────────────

/** «Octubre 2026 · Recibidas»; en un taco ARCHIVE, «Ejercicio 2026 · papel ubicado a mano». */
function lotLabelOf(batch: {
  origin: UploadBatchOrigin;
  periodType: PeriodType | null;
  periodMonth: number | null;
  periodYear: number;
  invoiceType: string | null;
  client: { fiscalYearStartMonth: number } | null;
}): string {
  if (batch.origin === "ARCHIVE" || !batch.periodType || batch.periodMonth == null || !batch.invoiceType) {
    return `Ejercicio ${fiscalYearLabel(batch.periodYear, batch.client?.fiscalYearStartMonth ?? 1)} · papel ubicado a mano`;
  }
  return tacoLotLabel({
    periodType: batch.periodType,
    periodMonth: batch.periodMonth,
    periodYear: batch.periodYear,
    invoiceType: batch.invoiceType,
  });
}

/** Nombres de quienes crearon, guardaron o anularon (sin clave foránea: se buscan en la asesoría). */
async function userNames(firmId: string, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id != null))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique }, advisoryFirmId: firmId }, select: { id: true, name: true } });
  return new Map(users.map((user) => [user.id, user.name]));
}

// ── Pestaña Tacos ───────────────────────────────────────────────────────────

export type TacoListFilters = {
  estado?: TacoListEstado;
  /** Un cliente, o «varios» (los tacos de «Clasificar entre varios»). */
  clientId?: string | "varios";
  /** Año del lote. */
  year?: number;
  /** Texto que contiene la caja (sin tildes ni mayúsculas). */
  caja?: string;
  page?: number;
};

export type TacoListRow = {
  id: string;
  /** null: tanda digital. */
  tacoNumber: number | null;
  origin: UploadBatchOrigin;
  wholePdf: boolean;
  /** null: «Varios clientes». */
  clientName: string | null;
  lotLabel: string;
  createdAt: Date;
  createdByName: string | null;
  /** «52 · 2 sin factura», «87 del PDF (sin dividir)», «12 facturas»; en una tanda digital, los ficheros. */
  pagesText: string;
  /** null en una tanda digital. */
  state: TacoState | null;
  stateLabel: string | null;
  /** «Guardar en caja…» en la fila: lo mismo que el filtro y el aviso «Sin guardar»
   *  (un taco entero sin dividir también, aunque su estado diga «Por dividir»). */
  canFile: boolean;
  voidReason: string | null;
  boxLabel: string | null;
  returnedAt: Date | null;
};

export type TacoList = {
  rows: TacoListRow[];
  window: PageWindow;
  /** Para el filtro «Cliente»: los del ámbito. */
  clients: { id: string; name: string }[];
  /** Para el filtro «Año»: los de los lotes de lo que ve, del más reciente al más antiguo. */
  years: number[];
};

const LIST_SELECT = {
  id: true,
  tacoNumber: true,
  origin: true,
  wholePdf: true,
  clientId: true,
  client: { select: { name: true, fiscalYearStartMonth: true } },
  periodType: true,
  periodMonth: true,
  periodYear: true,
  invoiceType: true,
  createdAt: true,
  createdById: true,
  fileCount: true,
  pdfPageCount: true,
  pdfSplitAt: true,
  boxLabel: true,
  returnedAt: true,
  filedAt: true,
  voidedAt: true,
  voidReason: true,
  _count: {
    select: {
      // Las originales de una división no son una factura más: lo son sus partes.
      archives: { where: { invoice: { status: { not: "SPLIT_SOURCE" } } } },
      paperArchives: { where: { invoice: { status: { not: "SPLIT_SOURCE" } } } },
    },
  },
} satisfies Prisma.UploadBatchSelect;

type ListedBatch = Prisma.UploadBatchGetPayload<{ select: typeof LIST_SELECT }>;

function stateOf(batch: ListedBatch): TacoState {
  return tacoState({ ...batch, invoiceCount: batch._count.archives + batch._count.paperArchives });
}

/** Papel sin guardar: un taco sin anular, sin caja ni devolver, con facturas o entero (su PDF ya es papel). */
function isUnfiled(batch: ListedBatch): boolean {
  return batch.tacoNumber != null && !batch.voidedAt && !batch.boxLabel && !batch.returnedAt
    && (batch.wholePdf || batch._count.archives + batch._count.paperArchives > 0);
}

function matchesEstado(batch: ListedBatch, estado: TacoListEstado): boolean {
  switch (estado) {
    case "todos":
    case "digitales":
      return true;
    case "sin-guardar":
      return isUnfiled(batch);
    case "guardados":
      return !batch.voidedAt && batch.boxLabel != null;
    case "devueltos":
      return !batch.voidedAt && batch.boxLabel == null && batch.returnedAt != null;
    case "por-dividir":
      return batch.wholePdf && !batch.pdfSplitAt && !batch.voidedAt;
    case "anulados":
      return batch.voidedAt != null;
  }
}

/** Páginas que tienen alguna factura, por taco (B-R18: lo demás son huecos «sin factura»). */
async function occupiedPages(batchIds: readonly string[]): Promise<Map<string, Set<number>>> {
  const byBatch = new Map<string, Set<number>>();
  if (batchIds.length === 0) return byBatch;
  const rows = await prisma.invoiceArchive.groupBy({
    by: ["uploadBatchId", "uploadPosition"],
    where: { uploadBatchId: { in: [...batchIds] }, uploadPosition: { not: null } },
  });
  for (const row of rows) {
    if (!row.uploadBatchId || row.uploadPosition == null) continue;
    const set = byBatch.get(row.uploadBatchId) ?? new Set<number>();
    set.add(row.uploadPosition);
    byBatch.set(row.uploadBatchId, set);
  }
  return byBatch;
}

function listPagesText(batch: ListedBatch, occupied: Set<number> | undefined): string {
  if (batch.tacoNumber == null) return batch.fileCount.toLocaleString("es-ES");
  if (batch.origin === "ARCHIVE") return invoiceCountText(batch._count.paperArchives);
  if (batch.wholePdf) {
    const total = (batch.pdfPageCount ?? 0).toLocaleString("es-ES");
    return batch.pdfSplitAt ? `${total} del PDF · ${invoiceCountText(occupied?.size ?? 0)}` : `${total} del PDF (sin dividir)`;
  }
  const filled = [...(occupied ?? [])].filter((page) => page >= 1 && page <= batch.fileCount).length;
  const empty = batch.fileCount - filled;
  return empty > 0 ? `${batch.fileCount.toLocaleString("es-ES")} · ${empty.toLocaleString("es-ES")} sin factura` : batch.fileCount.toLocaleString("es-ES");
}

/**
 * La pestaña Tacos (5.6): los tacos que ve (anulados incluidos), del más
 * reciente al más antiguo, o con «Subidas digitales», las tandas sin nº de los
 * últimos 30 días. Filtros de estado, cliente, año del lote y caja.
 */
export async function listTacos(viewer: TacoViewer, filters: TacoListFilters): Promise<TacoList> {
  const estado = filters.estado ?? "todos";
  const digital = estado === "digitales";
  const kind: Prisma.UploadBatchWhereInput = digital
    ? { tacoNumber: null, origin: "UPLOAD", createdAt: { gte: new Date(Date.now() - DIGITAL_BATCHES_DAYS * DAY_MS) } }
    : { tacoNumber: { not: null } };
  const [batches, clients] = await Promise.all([
    prisma.uploadBatch.findMany({
      where: { AND: [uploadBatchVisibleWhere(viewer), kind] },
      select: LIST_SELECT,
      orderBy: [{ createdAt: "desc" }, { tacoNumber: "desc" }, { id: "desc" }],
    }),
    viewer.clientIds.length > 0
      ? prisma.client.findMany({
        where: { id: { in: viewer.clientIds }, advisoryFirmId: viewer.firmId, isUnclassifiedBucket: false },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
      : Promise.resolve([]),
  ]);

  const caja = filters.caja ? boxLabelKey(filters.caja) : "";
  const filtered = batches.filter((batch) =>
    matchesEstado(batch, estado)
    && (filters.clientId == null || (filters.clientId === "varios" ? batch.clientId == null : batch.clientId === filters.clientId))
    && (filters.year == null || batch.periodYear === filters.year)
    && (!caja || (batch.boxLabel != null && boxLabelKey(batch.boxLabel).includes(caja))));

  const window = pageWindow(filters.page ?? 1, filtered.length, PAGE_SIZE);
  const page = filtered.slice(window.skip, window.skip + window.take);
  const [occupied, names] = await Promise.all([
    occupiedPages(page.filter((batch) => batch.tacoNumber != null && batch.origin === "UPLOAD").map((batch) => batch.id)),
    userNames(viewer.firmId, page.map((batch) => batch.createdById)),
  ]);

  const rows: TacoListRow[] = page.map((batch) => {
    const state = batch.tacoNumber == null ? null : stateOf(batch);
    return {
      id: batch.id,
      tacoNumber: batch.tacoNumber,
      origin: batch.origin,
      wholePdf: batch.wholePdf,
      clientName: batch.client?.name ?? null,
      lotLabel: lotLabelOf(batch),
      createdAt: batch.createdAt,
      createdByName: names.get(batch.createdById) ?? null,
      pagesText: listPagesText(batch, occupied.get(batch.id)),
      state,
      stateLabel: state ? tacoStateLabel(state, batch) : null,
      canFile: isUnfiled(batch),
      voidReason: batch.voidReason,
      boxLabel: batch.boxLabel,
      returnedAt: batch.returnedAt,
    };
  });
  const years = [...new Set(batches.map((batch) => batch.periodYear))].sort((x, y) => y - x);
  return { rows, window, clients, years };
}

// ── Avisos del Resumen ──────────────────────────────────────────────────────

export type TacoAlerts = {
  /** Tacos sin guardar en caja (ni devueltos), con papel, y sus páginas. */
  unfiled: number;
  unfiledPages: number;
  pendingSplits: PendingTacoSplit[];
  /** B-R13, en todos los ejercicios de los clientes que ve. */
  paperWithoutLocation: number;
  unconfirmedWithoutLocation: number;
};

/** Los avisos del Resumen del archivo (5.5), con lo que ve (B-R20). */
export async function tacoAlerts(viewer: TacoViewer): Promise<TacoAlerts> {
  const [unfiledBatches, pendingSplits, withoutLocation] = await Promise.all([
    prisma.uploadBatch.findMany({
      where: {
        AND: [
          uploadBatchVisibleWhere(viewer),
          { tacoNumber: { not: null }, origin: "UPLOAD", voidedAt: null, boxLabel: null, returnedAt: null },
        ],
      },
      select: LIST_SELECT,
    }),
    pendingTacoSplits(viewer),
    viewer.clientIds.length > 0
      ? prisma.$queryRaw<{ paper: number; unconfirmed: number }[]>`
        SELECT COUNT(*) FILTER (WHERE a."originalMedium" = 'PAPER')::int AS paper,
               COUNT(*) FILTER (WHERE a."originalMedium" IS NULL
                 AND i."status"::text NOT IN (${Prisma.join(IN_ANALYSIS)}))::int AS unconfirmed
        FROM "Invoice" i
        JOIN "Client" c ON c."id" = i."clientId"
        LEFT JOIN "InvoiceArchive" a ON a."invoiceId" = i."id"
        LEFT JOIN "UploadBatch" ub ON ub."id" = a."uploadBatchId"
        WHERE c."advisoryFirmId" = ${viewer.firmId}
          AND c."isUnclassifiedBucket" = false
          AND i."clientId" = ANY(${viewer.clientIds}::text[])
          AND i."status"::text NOT IN (${Prisma.join([...ARCHIVE_EXCLUDED_STATUSES, "REJECTED"])})
          AND NOT (COALESCE(a."paperHeldByClient", false) OR a."paperBatchId" IS NOT NULL OR ub."tacoNumber" IS NOT NULL)`
      : Promise.resolve([{ paper: 0, unconfirmed: 0 }]),
  ]);
  const unfiled = unfiledBatches.filter(isUnfiled);
  return {
    unfiled: unfiled.length,
    unfiledPages: unfiled.reduce((sum, batch) => sum + (batch.wholePdf ? batch.pdfPageCount ?? 0 : batch.fileCount), 0),
    pendingSplits,
    paperWithoutLocation: withoutLocation[0]?.paper ?? 0,
    unconfirmedWithoutLocation: withoutLocation[0]?.unconfirmed ?? 0,
  };
}

// ── Detalle de una tanda o taco (y su hoja) ─────────────────────────────────

/** Una factura del taco: la fila de huecos (TacoSlotRow) con lo que se enseña. */
export type TacoDetailRow = TacoSlotRow & {
  /** De un cliente que el gestor no tiene: «Factura de otra empresa», sin datos ni enlace (B-R20). */
  masked: boolean;
  type: InvoiceType;
  clientName: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  totalAmount: number | null;
  currency: string | null;
  thirdPartyName: string | null;
  thirdPartyCif: string | null;
  /** El nombre del fichero: mientras se analiza, es lo que casa con la carpeta del escáner. */
  filename: string | null;
  registerNumber: string | null;
  rejectionReason: string | null;
  mediumReasonLabel: string | null;
  analyzing: boolean;
};

export type TacoDetailKind = "taco" | "digital" | "archive";

export type TacoDetail = {
  id: string;
  kind: TacoDetailKind;
  tacoNumber: number | null;
  wholePdf: boolean;
  /** Un taco entero ya dividido. */
  split: boolean;
  fileCount: number;
  pdfPageCount: number | null;
  firmName: string;
  /** null: «Varios clientes». */
  client: { id: string; name: string; cif: string } | null;
  lotLabel: string;
  /** El lote, para subir con «Completar el taco» (null en ARCHIVE). */
  lot: { periodType: PeriodType; periodMonth: number; periodYear: number; invoiceType: "PURCHASE" | "SALE" | "UNKNOWN" } | null;
  createdAt: Date;
  createdByName: string | null;
  boxLabel: string | null;
  returnedAt: Date | null;
  filedAt: Date | null;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  /** null en una tanda digital. */
  state: TacoState | null;
  stateLabel: string | null;
  /** Las páginas con sus facturas (taco subido); vacío en una tanda digital, un ARCHIVE o un entero sin dividir. */
  slots: TacoSlot<TacoDetailRow>[];
  /** Tanda digital: sus facturas por orden de subida. ARCHIVE: su papel, en el orden del archivo. */
  rows: TacoDetailRow[];
  /** Facturas que se ven (sin las originales de una división). */
  invoiceCount: number;
  analyzingCount: number;
  /** Para AutoRefresh: cambia cuando cambia algún estado. */
  statusSignature: string;
  /** Huella de las páginas ya subidas: «Completar el taco» reconoce lo que ya está. */
  occupied: { position: number; fileHash: string }[];
  /** En un taco de varios, las empresas candidatas con las que se completa (las que ve). */
  completeCandidateIds: string[];
  canFile: boolean;
  canVoid: boolean;
  canComplete: boolean;
  canConvert: boolean;
  canSplit: boolean;
  /** «Conservar hasta (como mínimo)»: el más tardío de su papel; null si no hay. */
  retainUntil: Date | null;
  /** Alguna se conserva más: «sin fecha». */
  retainOpen: boolean;
  tacoPdfUrl: string | null;
};

const DETAIL_SELECT = {
  id: true,
  advisoryFirmId: true,
  advisoryFirm: { select: { name: true } },
  tacoNumber: true,
  origin: true,
  wholePdf: true,
  clientId: true,
  client: { select: { id: true, name: true, cif: true, fiscalYearStartMonth: true } },
  routingCandidateIds: true,
  periodType: true,
  periodMonth: true,
  periodYear: true,
  invoiceType: true,
  createdAt: true,
  createdById: true,
  fileCount: true,
  pdfPageCount: true,
  pdfSplitAt: true,
  boxLabel: true,
  returnedAt: true,
  filedAt: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
} satisfies Prisma.UploadBatchSelect;

const DETAIL_ROW_SELECT = {
  invoiceId: true,
  uploadPosition: true,
  splitPart: true,
  receivedAt: true,
  originalMedium: true,
  originalMediumReason: true,
  paperHeldByClient: true,
  paperBatchId: true,
  paperBatch: { select: { tacoNumber: true, returnedAt: true, origin: true } },
  registerNumber: true,
  registerSeries: { select: { type: true, year: true } },
  retentionHold: true,
  invoice: {
    select: {
      id: true,
      clientId: true,
      status: true,
      splitFromId: true,
      type: true,
      invoiceNumber: true,
      invoiceDate: true,
      totalAmount: true,
      currency: true,
      issuerName: true,
      issuerCif: true,
      receiverName: true,
      receiverCif: true,
      filename: true,
      fileHash: true,
      rejectionReason: true,
      routingCandidateIds: true,
      periodType: true,
      periodMonth: true,
      periodYear: true,
      accountingPeriodMonth: true,
      accountingPeriodYear: true,
      createdAt: true,
      client: { select: { name: true, isUnclassifiedBucket: true, fiscalYearStartMonth: true } },
    },
  },
} satisfies Prisma.InvoiceArchiveSelect;

type DetailArchiveRow = Prisma.InvoiceArchiveGetPayload<{ select: typeof DETAIL_ROW_SELECT }>;

/** ¿La ve sin enmascarar? El ADMIN, todas; el gestor, las de sus clientes (o, en el buzón, de sus candidatos). */
function visibleTo(viewer: TacoViewer, row: DetailArchiveRow): boolean {
  if (viewer.role === "ADMIN") return true;
  const { invoice } = row;
  if (viewer.clientIds.includes(invoice.clientId)) return true;
  return invoice.client.isUnclassifiedBucket && invoice.routingCandidateIds.some((id) => viewer.clientIds.includes(id));
}

function detailRowOf(viewer: TacoViewer, row: DetailArchiveRow): TacoDetailRow {
  const { invoice } = row;
  const slot: TacoSlotRow = {
    invoiceId: invoice.id,
    clientId: invoice.clientId,
    status: invoice.status,
    splitFromId: invoice.splitFromId,
    uploadPosition: row.uploadPosition,
    splitPart: row.splitPart,
    medium: row.originalMedium,
    paperHeldByClient: row.paperHeldByClient,
    paperBatchId: row.paperBatchId,
    paperTacoNumber: row.paperBatch?.tacoNumber ?? null,
    paperTacoReturnedAt: row.paperBatch?.returnedAt ?? null,
    paperTacoOrigin: row.paperBatch?.origin ?? null,
  };
  const analyzing = IN_ANALYSIS.includes(invoice.status);
  if (!visibleTo(viewer, row)) {
    return {
      ...slot,
      masked: true,
      type: invoice.type,
      clientName: null,
      invoiceNumber: null,
      invoiceDate: null,
      totalAmount: null,
      currency: null,
      thirdPartyName: null,
      thirdPartyCif: null,
      filename: null,
      registerNumber: null,
      rejectionReason: null,
      mediumReasonLabel: null,
      analyzing,
    };
  }
  const sale = invoice.type === "SALE";
  return {
    ...slot,
    masked: false,
    type: invoice.type,
    clientName: invoice.client.name,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    totalAmount: invoice.totalAmount != null ? Number(invoice.totalAmount) : null,
    currency: invoice.currency,
    thirdPartyName: sale ? invoice.receiverName : invoice.issuerName,
    thirdPartyCif: sale ? invoice.receiverCif : invoice.issuerCif,
    filename: invoice.filename,
    registerNumber: row.registerNumber != null && row.registerSeries ? formatRegisterNumber(row.registerSeries, row.registerNumber) : null,
    rejectionReason: invoice.rejectionReason,
    mediumReasonLabel: mediumReasonLabel(row.originalMediumReason),
    analyzing,
  };
}

function archiveOrderOf(row: DetailArchiveRow) {
  const { invoice } = row;
  return {
    id: invoice.id,
    type: invoice.type,
    periodType: invoice.periodType,
    periodMonth: invoice.periodMonth,
    periodYear: invoice.periodYear,
    accountingPeriodMonth: invoice.accountingPeriodMonth,
    accountingPeriodYear: invoice.accountingPeriodYear,
    receivedAt: row.receivedAt,
    uploadPosition: row.uploadPosition,
    splitPart: row.splitPart,
    createdAt: invoice.createdAt,
    invoiceDate: invoice.invoiceDate,
    invoiceNumber: invoice.invoiceNumber,
  };
}

/** «Conservar hasta» del papel del taco: la fecha más tardía, o abierta si alguna se conserva más. */
function retentionOf(rows: readonly DetailArchiveRow[]): { retainUntil: Date | null; retainOpen: boolean } {
  let latest: Date | null = null;
  let open = false;
  for (const row of rows) {
    const until = retainUntil({ ...archiveOrderOf(row), retentionHold: row.retentionHold }, row.invoice.client.fiscalYearStartMonth);
    if (until == null) open = true;
    else if (!latest || until.getTime() > latest.getTime()) latest = until;
  }
  return { retainUntil: latest, retainOpen: open };
}

/**
 * Una tanda o taco que ve (B-R20), con sus facturas y sus páginas (5.7, 5.14),
 * o null. Al gestor, las facturas de clientes que no tiene le salen como
 * «Factura de otra empresa».
 */
export async function loadTacoDetail(viewer: TacoViewer, batchId: string): Promise<TacoDetail | null> {
  const batch = await prisma.uploadBatch.findFirst({
    where: { AND: [{ id: batchId, advisoryFirmId: viewer.firmId }, uploadBatchVisibleWhere(viewer)] },
    select: DETAIL_SELECT,
  });
  if (!batch) return null;

  const archiveKind = batch.origin === "ARCHIVE";
  const kind: TacoDetailKind = archiveKind ? "archive" : batch.tacoNumber == null ? "digital" : "taco";
  const inFirm = { invoice: { client: { advisoryFirmId: viewer.firmId } } };
  const [arrived, placed, names] = await Promise.all([
    archiveKind
      ? Promise.resolve([] as DetailArchiveRow[])
      : prisma.invoiceArchive.findMany({ where: { uploadBatchId: batch.id, ...inFirm }, select: DETAIL_ROW_SELECT }),
    prisma.invoiceArchive.findMany({ where: { paperBatchId: batch.id, ...inFirm }, select: DETAIL_ROW_SELECT }),
    userNames(viewer.firmId, [batch.createdById, batch.voidedById]),
  ]);

  const detailRows = (list: readonly DetailArchiveRow[]) => list.map((row) => detailRowOf(viewer, row));
  const shown = (row: DetailArchiveRow) => row.invoice.status !== "SPLIT_SOURCE";
  const split = batch.pdfSplitAt != null;

  let slots: TacoSlot<TacoDetailRow>[] = [];
  let rows: TacoDetailRow[] = [];
  let paperRows: DetailArchiveRow[] = [];
  if (kind === "taco") {
    slots = tacoSlots({
      batchId: batch.id,
      fileCount: batch.fileCount,
      wholePdf: batch.wholePdf,
      pdfPageCount: batch.pdfPageCount,
      split,
      rows: detailRows(arrived),
    });
    // El papel del taco: lo que llegó en él y no está en otro sitio.
    paperRows = arrived.filter((row) => shown(row) && row.originalMedium !== "ELECTRONIC" && !row.paperHeldByClient
      && (row.paperBatchId == null || row.paperBatchId === batch.id));
  } else if (kind === "digital") {
    const ordered = arrived.filter(shown).sort((x, y) =>
      (x.uploadPosition ?? 0) - (y.uploadPosition ?? 0) || x.splitPart - y.splitPart || (x.invoiceId < y.invoiceId ? -1 : 1));
    rows = detailRows(ordered);
  } else {
    paperRows = placed.filter(shown).sort((x, y) => compareArchiveOrder(archiveOrderOf(x), archiveOrderOf(y)));
    rows = detailRows(paperRows);
  }

  const visibleRows = kind === "taco" ? detailRows(arrived.filter(shown)) : rows;
  const analyzingCount = visibleRows.filter((row) => row.analyzing).length;
  const statusCounts = new Map<string, number>();
  for (const row of visibleRows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  const statusSignature = [...statusCounts.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([s, n]) => `${s}:${n}`).join(",");

  const voided = batch.voidedAt != null;
  const uploaded = batch.origin === "UPLOAD" && batch.tacoNumber != null;
  const alive = arrived.some((row) => row.invoice.status !== "REJECTED" && row.invoice.status !== "SPLIT_SOURCE");
  const state = batch.tacoNumber == null
    ? null
    : tacoState({ ...batch, invoiceCount: arrived.filter(shown).length + placed.filter(shown).length });

  const lot = !archiveKind && batch.periodType && batch.periodMonth != null && batch.invoiceType
    ? {
      periodType: batch.periodType,
      periodMonth: batch.periodMonth,
      periodYear: batch.periodYear,
      invoiceType: batch.invoiceType as "PURCHASE" | "SALE" | "UNKNOWN",
    }
    : null;

  return {
    id: batch.id,
    kind,
    tacoNumber: batch.tacoNumber,
    wholePdf: batch.wholePdf,
    split,
    fileCount: batch.fileCount,
    pdfPageCount: batch.pdfPageCount,
    firmName: batch.advisoryFirm.name,
    client: batch.client ? { id: batch.client.id, name: batch.client.name, cif: batch.client.cif } : null,
    lotLabel: lotLabelOf(batch),
    lot,
    createdAt: batch.createdAt,
    createdByName: names.get(batch.createdById) ?? null,
    boxLabel: batch.boxLabel,
    returnedAt: batch.returnedAt,
    filedAt: batch.filedAt,
    voidedAt: batch.voidedAt,
    voidedByName: batch.voidedById ? names.get(batch.voidedById) ?? null : null,
    voidReason: batch.voidReason,
    state,
    stateLabel: state ? tacoStateLabel(state, batch) : null,
    slots,
    rows,
    invoiceCount: visibleRows.length,
    analyzingCount,
    statusSignature,
    occupied: arrived
      .filter((row) => row.splitPart === 0 && row.uploadPosition != null && row.invoice.fileHash)
      .map((row) => ({ position: row.uploadPosition as number, fileHash: row.invoice.fileHash as string })),
    completeCandidateIds: batch.clientId == null
      ? batch.routingCandidateIds.filter((id) => viewer.role === "ADMIN" || viewer.clientIds.includes(id))
      : [],
    canFile: batch.tacoNumber != null && !voided,
    canVoid: uploaded && !voided && !alive && placed.length === 0,
    canComplete: uploaded && !voided && !batch.wholePdf,
    canConvert: batch.origin === "UPLOAD" && batch.tacoNumber == null,
    canSplit: batch.wholePdf && !split && !voided,
    ...retentionOf(paperRows),
    tacoPdfUrl: batch.wholePdf ? `/api/archive/tacos/${batch.id}/pdf` : null,
  };
}

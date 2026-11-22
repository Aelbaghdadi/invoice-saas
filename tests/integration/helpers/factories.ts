import type { Invoice, InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { TestSessionUser } from "./session";

/**
 * Datos de prueba. makeFirm crea una asesoria completa (admin, gestor
 * asignado a un cliente con acceso al portal y un par de facturas);
 * makeTwoFirms crea dos, «A» y «B», para los tests de aislamiento entre
 * asesorias. Los CIF y emails llevan la etiqueta para no chocar.
 *
 * No se genera passwordHash real: estos usuarios no pasan por el login.
 */
export type FirmWorld = {
  tag: string;
  firm: { id: string; name: string };
  admin: TestSessionUser & { username: string };
  worker: TestSessionUser & { username: string };
  clientUser: TestSessionUser & { username: string };
  client: { id: string; name: string; cif: string; advisoryFirmId: string };
  invoices: { pending: Invoice; validated: Invoice };
};

let sequence = 0;
const next = () => ++sequence;

/** CIF con formato de sociedad (letra + 8 digitos); unico en la ejecucion. */
function fakeCif(letter: string) {
  return `${letter}${String(10_000_000 + next()).slice(-8)}`;
}

export async function makeUser(
  firmId: string | null,
  role: "ADMIN" | "WORKER" | "CLIENT",
  label: string,
) {
  const n = next();
  const user = await prisma.user.create({
    data: {
      username: `${label}${n}`,
      email: `${label}${n}@pruebas.es`,
      passwordHash: "sin-login",
      name: label,
      role,
      advisoryFirmId: firmId,
    },
  });
  return { id: user.id, role, advisoryFirmId: firmId, username: user.username };
}

export async function makeInvoice(
  client: { id: string },
  overrides: Partial<Prisma.InvoiceUncheckedCreateInput> & { status?: InvoiceStatus } = {},
): Promise<Invoice> {
  const n = next();
  return prisma.invoice.create({
    data: {
      filename: `f${n}.pdf`,
      storageKey: `${client.id}/2026-09/f${n}.pdf`,
      fileType: "application/pdf",
      type: "PURCHASE",
      periodMonth: 9,
      periodYear: 2026,
      clientId: client.id,
      status: "PENDING_REVIEW",
      invoiceNumber: `F-${n}`,
      invoiceDate: new Date("2026-09-10"),
      issuerName: "Proveedor SL",
      issuerCif: "B12345674",
      taxBase: 100,
      vatRate: 21,
      vatAmount: 21,
      totalAmount: 121,
      // Una factura completa: sin cuentas, el export la deja fuera (F-025).
      supplierAccount: "40000001",
      expenseAccount: "60000001",
      ...overrides,
    },
  });
}

/** `demo`: asesoría marcada isDemo, la única cuyo reset pueden borrar los
 *  triggers del archivo. En la app solo se marca a mano en la BD. */
export async function makeFirm(tag: string, options: { demo?: boolean } = {}): Promise<FirmWorld> {
  const firm = await prisma.advisoryFirm.create({
    data: { name: `Asesoría ${tag}`, cif: fakeCif("A"), isDemo: options.demo ?? false },
  });
  const admin = await makeUser(firm.id, "ADMIN", `admin${tag.toLowerCase()}`);
  const worker = await makeUser(firm.id, "WORKER", `gestor${tag.toLowerCase()}`);
  const clientUser = await makeUser(null, "CLIENT", `cliente${tag.toLowerCase()}`);
  const client = await prisma.client.create({
    data: {
      name: `Cliente ${tag} SL`,
      cif: fakeCif("B"),
      email: `contacto-${tag.toLowerCase()}${next()}@pruebas.es`,
      advisoryFirmId: firm.id,
      userId: clientUser.id,
    },
  });
  await prisma.workerClientAssignment.create({ data: { workerId: worker.id, clientId: client.id } });
  const pending = await makeInvoice(client, { status: "PENDING_REVIEW" });
  const validated = await makeInvoice(client, { status: "VALIDATED" });
  return {
    tag,
    firm: { id: firm.id, name: firm.name },
    admin,
    worker,
    clientUser,
    client: { id: client.id, name: client.name, cif: client.cif, advisoryFirmId: firm.id },
    invoices: { pending, validated },
  };
}

export async function makeTwoFirms() {
  return { a: await makeFirm("A"), b: await makeFirm("B") };
}

export type MakeTacoOptions = {
  /** Sin poner, el siguiente libre de la asesoría; null, una tanda digital (sin nº). */
  tacoNumber?: number | null;
  /** Taco entero en un PDF: crea antes su Document del cliente. */
  wholePdf?: { pageCount: number; fileHash?: string; split?: { byId: string; at?: Date } };
  /** null = tanda de varios (con candidateIds). Por defecto, el cliente de la asesoría. */
  clientId?: string | null;
  candidateIds?: string[];
  createdById?: string;
  fileCount?: number;
  createdAt?: Date;
  period?: { periodType: "MONTHLY" | "QUARTERLY"; periodMonth: number; periodYear: number };
  invoiceType?: "PURCHASE" | "SALE" | "UNKNOWN";
  filed?: { boxLabel: string; at?: Date } | { returned: true; at?: Date };
  origin?: "UPLOAD" | "ARCHIVE";
  voided?: { reason: string; byId?: string };
};

/**
 * Una tanda o taco insertado a mano (sin pasar por la subida), para los tests
 * de tacos. Por defecto, un taco de factura a factura del cliente de la
 * asesoría, de compras de septiembre de 2026, con 3 páginas. Un taco ARCHIVE
 * (papel ubicado a mano) lleva solo el año y 0 ficheros.
 */
export async function makeTaco(w: FirmWorld, options: MakeTacoOptions = {}) {
  const origin = options.origin ?? "UPLOAD";
  const archive = origin === "ARCHIVE";
  const clientId = options.clientId === undefined ? w.client.id : options.clientId;
  const createdById = options.createdById ?? w.worker.id;
  let tacoNumber = options.tacoNumber;
  if (tacoNumber === undefined) {
    const [row] = await prisma.$queryRaw<{ next: number }[]>`
      SELECT (COALESCE(MAX("tacoNumber"), 0) + 1)::int AS next FROM "UploadBatch" WHERE "advisoryFirmId" = ${w.firm.id}`;
    tacoNumber = row.next;
  }
  const period = options.period ?? { periodType: "MONTHLY" as const, periodMonth: 9, periodYear: 2026 };
  let pdfDocumentId: string | null = null;
  if (options.wholePdf) {
    const n = next();
    const document = await prisma.document.create({
      data: {
        filename: `taco-${n}.pdf`,
        storageKey: `${clientId}/2026-09/taco-${n}.pdf`,
        fileType: "application/pdf",
        fileHash: options.wholePdf.fileHash ?? `huella-taco-${n}`,
        sizeBytes: 1000,
        uploadedBy: createdById,
        clientId: clientId as string,
      },
    });
    pdfDocumentId = document.id;
  }
  const filedAt = options.filed ? options.filed.at ?? new Date() : null;
  const voidedAt = options.voided ? new Date() : null;
  return prisma.uploadBatch.create({
    data: {
      advisoryFirmId: w.firm.id,
      clientId,
      routingCandidateIds: options.candidateIds ?? [],
      origin,
      createdById,
      fileCount: options.fileCount ?? (archive ? 0 : options.wholePdf ? 1 : 3),
      periodType: archive ? null : period.periodType,
      periodMonth: archive ? null : period.periodMonth,
      periodYear: period.periodYear,
      invoiceType: archive ? null : options.invoiceType ?? "PURCHASE",
      tacoNumber,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.filed
        ? "returned" in options.filed
          ? { returnedAt: filedAt, filedAt, filedById: createdById }
          : { boxLabel: options.filed.boxLabel, filedAt, filedById: createdById }
        : {}),
      ...(options.wholePdf
        ? {
            wholePdf: true,
            pdfDocumentId,
            pdfPageCount: options.wholePdf.pageCount,
            ...(options.wholePdf.split
              ? { pdfSplitAt: options.wholePdf.split.at ?? new Date(), pdfSplitById: options.wholePdf.split.byId }
              : {}),
          }
        : {}),
      ...(options.voided
        ? { voidedAt, voidedById: options.voided.byId ?? createdById, voidReason: options.voided.reason }
        : {}),
    },
  });
}

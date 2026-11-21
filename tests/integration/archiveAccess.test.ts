// Archivo, paso 6: quién entra (archiveAccess), la lectura del archivo
// (archiveData) y el original a un clic (/api/archive/invoices/[id]/original).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Invoice, Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { blankPdf } from "./helpers/fixtures";
import { signInAs, signOut, type TestSessionUser } from "./helpers/session";
import { appendAuditLogs } from "@/lib/auditLog";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { archiveScope, canAccessArchiveInvoice, canAccessUploadBatch, type ArchiveScope } from "@/lib/archiveAccess";
import { loadArchiveInvoice, loadArchiveMetrics, loadClientArchive, searchArchive } from "@/lib/archiveData";
import { GET as original } from "@/app/api/archive/invoices/[id]/original/route";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function getOriginal(user: TestSessionUser | null, id: string, query = "") {
  if (user) signInAs(user);
  else signOut();
  const res = await original(new NextRequest(`http://x/api/archive/invoices/${id}/original${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

/** Un PDF distinto por marca, para saber qué fichero se ha servido. */
async function pdfWith(marker: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setTitle(marker);
  return Buffer.from(await doc.save());
}

let clientSeq = 0;
/** Un cliente más de la asesoría, sin facturas ni gestor. */
function makeClient(w: FirmWorld, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) {
  clientSeq++;
  return prisma.client.create({
    data: { name: `Archivo ${w.tag} ${clientSeq} SL`, cif: `X${w.tag}${Date.now()}${clientSeq}`, advisoryFirmId: w.firm.id, ...data },
  });
}

/** Nº de registro puesto como al exportar: serie del cliente, tipo y año de deducción. */
async function register(invoice: Invoice, number: number) {
  const year = invoice.accountingPeriodYear ?? invoice.periodYear;
  const series = await prisma.invoiceRegisterSeries.upsert({
    where: { clientId_type_year: { clientId: invoice.clientId, type: invoice.type, year } },
    create: { clientId: invoice.clientId, type: invoice.type, year, lastNumber: 1000 },
    update: {},
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: { registerSeriesId: series.id, registerNumber: number, registeredAt: new Date("2026-10-05T10:00:00Z") },
  });
}

const setReceived = (invoice: { id: string }, iso: string) =>
  prisma.invoiceArchive.update({ where: { invoiceId: invoice.id }, data: { receivedAt: new Date(iso) } });

async function scopeOf(user: TestSessionUser): Promise<ArchiveScope> {
  const scope = await archiveScope({ user });
  if (!scope) throw new Error("sin ámbito de archivo");
  return scope;
}

describe("el original a un clic (/api/archive/invoices/[id]/original)", () => {
  it("el admin de su asesoría lo ve: el PDF en línea y sin caché", async () => {
    const bytes = await pdfWith("validada");
    fakeS3().put(a.invoices.validated.storageKey, bytes);
    const r = await getOriginal(a.admin, a.invoices.validated.id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.body.equals(bytes)).toBe(true);
  });

  it("sin sesión 401; el admin o el gestor de otra asesoría, un gestor sin el cliente y el portal, 404", async () => {
    const id = a.invoices.validated.id;
    fakeS3().put(a.invoices.validated.storageKey, await blankPdf(1));
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    expect((await getOriginal(null, id)).status).toBe(401);
    for (const user of [b.admin, b.worker, stranger, a.clientUser]) {
      const r = await getOriginal(user, id);
      expect(r.status).toBe(404);
      expect(r.body.toString()).not.toContain("%PDF");
    }
    expect((await getOriginal(a.worker, id)).status).toBe(200);
  });

  it("en el buzón, el gestor que tiene asignado un candidato sí lo ve; otro, no", async () => {
    const bucket = await getOrCreateUnclassifiedClient(a.firm.id);
    const other = await makeClient(a);
    const routed = await makeInvoice(bucket, { status: "PENDING_ROUTING", routingCandidateIds: [a.client.id, other.id] });
    const foreign = await makeInvoice(bucket, { status: "PENDING_ROUTING", routingCandidateIds: [other.id] });
    for (const inv of [routed, foreign]) fakeS3().put(inv.storageKey, await blankPdf(1));
    expect((await getOriginal(a.worker, routed.id)).status).toBe(200);
    expect((await getOriginal(a.worker, foreign.id)).status).toBe(404);
    expect((await getOriginal(a.admin, foreign.id)).status).toBe(200);
    expect((await getOriginal(b.admin, routed.id)).status).toBe(404);
  });

  it("una parte de una división sirve el documento entero; con ?copia=1, la parte", async () => {
    const root = await makeInvoice(a.client, { status: "SPLIT_SOURCE", storageKey: "k-root", filename: "entero.pdf" });
    const part = await makeInvoice(a.client, { status: "SPLIT_SOURCE", storageKey: "k-part", splitFromId: root.id });
    const grand = await makeInvoice(a.client, { storageKey: "k-grand", splitFromId: part.id });
    const bytes = { root: await pdfWith("entero"), part: await pdfWith("parte"), grand: await pdfWith("nieta") };
    fakeS3().put("k-root", bytes.root);
    fakeS3().put("k-part", bytes.part);
    fakeS3().put("k-grand", bytes.grand);
    expect((await getOriginal(a.worker, grand.id)).body.equals(bytes.root)).toBe(true);
    expect((await getOriginal(a.worker, grand.id, "?copia=1")).body.equals(bytes.grand)).toBe(true);
  });

  it("con un Word adjunto, el original es el Word como descarga y ?copia=1 sirve el PDF", async () => {
    const pdf = await pdfWith("copia");
    const word = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01]);
    const invoice = a.invoices.validated;
    fakeS3().put(invoice.storageKey, pdf);
    const document = await prisma.document.create({
      data: {
        filename: "Factura Añil.doc",
        storageKey: `${a.client.id}/originales/1-u-Factura_Anil.doc`,
        fileType: "application/msword",
        sizeBytes: word.length,
        clientId: a.client.id,
      },
    });
    fakeS3().put(document.storageKey, word);
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { originalDocumentId: document.id, originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "other_format" },
    });

    const r = await getOriginal(a.worker, invoice.id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="Factura_Anil\.doc"; filename\*=UTF-8''Factura%20A%C3%B1il\.doc$/);
    expect(r.body.equals(word)).toBe(true);

    const copy = await getOriginal(a.worker, invoice.id, "?copia=1");
    expect(copy.headers.get("content-type")).toBe("application/pdf");
    expect(copy.body.equals(pdf)).toBe(true);
  });

  it("una parte cuya original tiene un Word adjunto: el original es ese Word (el de toda la familia) y ?copia=1 sirve la parte", async () => {
    const root = await makeInvoice(a.client, { status: "SPLIT_SOURCE", storageKey: "k-root-word", filename: "entero.pdf" });
    const part = await makeInvoice(a.client, { storageKey: "k-part-word", splitFromId: root.id, invoiceNumber: "PW-1" });
    const bytes = { root: await pdfWith("entero"), part: await pdfWith("parte") };
    fakeS3().put("k-root-word", bytes.root);
    fakeS3().put("k-part-word", bytes.part);
    const word = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x02]);
    const document = await prisma.document.create({
      data: {
        filename: "Factura entera.doc",
        storageKey: `${a.client.id}/originales/3-u-Factura_entera.doc`,
        fileType: "application/msword",
        sizeBytes: word.length,
        clientId: a.client.id,
      },
    });
    fakeS3().put(document.storageKey, word);
    await prisma.invoiceArchive.update({
      where: { invoiceId: root.id },
      data: { originalDocumentId: document.id, originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "other_format" },
    });

    const r = await getOriginal(a.worker, part.id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="Factura_entera\.doc"/);
    expect(r.body.equals(word)).toBe(true);
    expect((await getOriginal(a.worker, part.id, "?copia=1")).body.equals(bytes.part)).toBe(true);

    const row = (await loadClientArchive({ firmId: a.firm.id, clientId: a.client.id }))?.rows.find((x) => x.invoiceId === part.id);
    expect(row?.originalDocument).toEqual({ filename: "Factura entera.doc", fileType: "application/msword" });
    expect((await loadArchiveInvoice(part.id, a.firm.id))?.originalDocument).toMatchObject({
      id: document.id, filename: "Factura entera.doc", fromSplitRoot: true,
    });
  });

  it("si el original no está en el almacenamiento: 404 con el aviso", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await getOriginal(a.admin, a.invoices.pending.id);
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body.toString())).toEqual({ error: "El original no está en el almacenamiento." });
      expect(quiet).toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("quién entra", () => {
  it("canAccessArchiveInvoice: el admin de la asesoría y el gestor del cliente; nadie de fuera", async () => {
    const id = a.invoices.pending.id;
    expect(await canAccessArchiveInvoice({ user: a.admin }, id)).toBe(true);
    expect(await canAccessArchiveInvoice({ user: a.worker }, id)).toBe(true);
    expect(await canAccessArchiveInvoice({ user: b.admin }, id)).toBe(false);
    expect(await canAccessArchiveInvoice({ user: a.clientUser }, id)).toBe(false);
    expect(await canAccessArchiveInvoice({ user: a.admin }, "no-existe")).toBe(false);
  });

  it("archiveScope: el admin, toda su asesoría sin el buzón; el gestor, sus clientes; el portal, nada", async () => {
    const other = await makeClient(a);
    await getOrCreateUnclassifiedClient(a.firm.id);
    expect((await scopeOf(a.admin)).clientIds.sort()).toEqual([a.client.id, other.id].sort());
    expect(await scopeOf(a.worker)).toEqual({ firmId: a.firm.id, clientIds: [a.client.id] });
    expect(await archiveScope({ user: a.clientUser })).toBeNull();
  });

  it("canAccessUploadBatch: el admin de la asesoría, quien la subió y el gestor del cliente", async () => {
    const stranger = await makeUser(a.firm.id, "WORKER", "gestortanda");
    const mine = await prisma.uploadBatch.create({
      data: { advisoryFirmId: a.firm.id, clientId: a.client.id, createdById: a.admin.id, fileCount: 3, periodYear: 2026 },
    });
    const several = await prisma.uploadBatch.create({
      data: { advisoryFirmId: a.firm.id, clientId: null, createdById: stranger.id, fileCount: 2, periodYear: 2026 },
    });
    expect(await canAccessUploadBatch({ user: a.admin }, mine.id)).toBe(true);
    expect(await canAccessUploadBatch({ user: a.worker }, mine.id)).toBe(true);
    expect(await canAccessUploadBatch({ user: stranger }, mine.id)).toBe(false);
    expect(await canAccessUploadBatch({ user: stranger }, several.id)).toBe(true);
    expect(await canAccessUploadBatch({ user: a.worker }, several.id)).toBe(false);
    expect(await canAccessUploadBatch({ user: b.admin }, mine.id)).toBe(false);
    expect(await canAccessUploadBatch({ user: b.worker }, several.id)).toBe(false);
  });
});

describe("buscador «¿Dónde está?» (searchArchive)", () => {
  /** Lo mismo en las dos asesorías: el buscador de A no puede traer lo de B. */
  async function seed(w: FirmWorld) {
    const registered = await makeInvoice(w.client, {
      status: "VALIDATED", invoiceNumber: "ZX-77", issuerCif: "B76543210", totalAmount: 1134.6, issuerName: "Proveedor Norte SL",
    });
    await register(registered, 1);
    const ticket = await makeInvoice(w.client, { invoiceNumber: "T3", issuerName: "Caja 3 Rural SA", totalAmount: 50 });
    return { registered, ticket };
  }

  it("por nº de registro, NIF, importe, «T3» y «caja 3» no mezcla asesorías y dice por qué casa", async () => {
    const mine = await seed(a);
    await seed(b);
    const scope = await scopeOf(a.admin);
    const found = async (q: string) => (await searchArchive(scope, q)).map((r) => [r.invoiceId, r.matchedBy, r.exact]);
    expect(await found("R-2026/1")).toEqual([[mine.registered.id, ["registro"], true]]);
    expect(await found("r 2026/0001")).toEqual([[mine.registered.id, ["registro"], true]]);
    expect(await found("B-76543210")).toEqual([[mine.registered.id, ["nif"], true]]);
    expect(await found("B76543210")).toEqual([[mine.registered.id, ["nif", "texto"], true]]);
    expect(await found("1.134,60")).toEqual([[mine.registered.id, ["importe"], true]]);
    expect(await found("T3")).toEqual([[mine.ticket.id, ["numero", "texto"], true]]);
    expect(await found("caja 3")).toEqual([[mine.ticket.id, ["texto"], false]]);

    const [result] = await searchArchive(scope, "R-2026/1");
    expect(result).toMatchObject({
      clientName: a.client.name,
      registerNumber: "R-2026/0001",
      thirdPartyName: "Proveedor Norte SL",
      totalAmount: 1134.6,
      fiscalYearLabel: "2026",
      retainUntil: utc("2032-12-31"),
    });
  });

  it("una consulta solo de puntos, guiones o espacios no casa por NIF ni por nº de factura con lo que no los tiene", async () => {
    // Las facturas recibidas no suelen llevar NIF de receptor: compactada, la
    // consulta quedaba vacía y casaba con todas como «NIF» exacto.
    await seed(a);
    const scope = await scopeOf(a.admin);
    for (const q of ["-", ".", " . - "]) {
      const results = await searchArchive(scope, q);
      expect(results.filter((r) => r.exact || r.matchedBy.includes("nif") || r.matchedBy.includes("numero")), q).toEqual([]);
    }
  });

  it("las coincidencias exactas van primero aunque sean más antiguas", async () => {
    const exact = await makeInvoice(a.client, { invoiceNumber: "ZX-7" });
    const newer = await makeInvoice(a.client, { invoiceNumber: "ZX-71" });
    const results = await searchArchive(await scopeOf(a.admin), "zx-7");
    expect(results.map((r) => r.invoiceId)).toEqual([exact.id, newer.id]);
    expect(results.map((r) => r.exact)).toEqual([true, false]);
  });

  it("el gestor solo busca en sus clientes; el admin, en toda su asesoría", async () => {
    const other = await makeClient(a);
    const hidden = await makeInvoice(other, { invoiceNumber: "ZQ-1" });
    expect(await searchArchive(await scopeOf(a.worker), "ZQ-1")).toEqual([]);
    expect((await searchArchive(await scopeOf(a.admin), "ZQ-1")).map((r) => r.invoiceId)).toEqual([hidden.id]);
  });

  it("no salen las originales divididas ni lo del buzón", async () => {
    await makeInvoice(a.client, { invoiceNumber: "ZW-1", status: "SPLIT_SOURCE" });
    const bucket = await getOrCreateUnclassifiedClient(a.firm.id);
    await makeInvoice(bucket, { invoiceNumber: "ZW-2", status: "PENDING_ROUTING", routingCandidateIds: [a.client.id] });
    expect(await searchArchive(await scopeOf(a.admin), "ZW-")).toEqual([]);
  });
});

describe("cifras del archivo (loadArchiveMetrics)", () => {
  it("las del gestor solo traen sus clientes; las del admin, toda su asesoría; nunca otra", async () => {
    const other = await makeClient(a, { name: "Otro cliente SL" });
    await makeInvoice(other, { type: "SALE", status: "REJECTED" });
    await makeInvoice(b.client, { status: "VALIDATED" });
    const bucket = await getOrCreateUnclassifiedClient(a.firm.id);
    await makeInvoice(bucket, { status: "PENDING_ROUTING" });

    const worker = await loadArchiveMetrics(await scopeOf(a.worker));
    expect(worker.clients.map((c) => c.clientId)).toEqual([a.client.id]);
    expect(worker.clients[0].years).toEqual([expect.objectContaining({
      startYear: 2026, label: "2026", invoices: 2, received: 2, unconfirmed: 2, unregistered: 2, pendingValidation: 1,
      rejected: 0, retainUntil: utc("2032-12-31"),
    })]);

    const admin = await loadArchiveMetrics(await scopeOf(a.admin));
    expect(admin.clients.map((c) => c.clientId).sort()).toEqual([a.client.id, other.id].sort());
    expect(admin.totals).toEqual([expect.objectContaining({ startYear: 2026, invoices: 2, rejected: 1 })]);
  });

  it("electrónico, papel, registradas y «conservar más» salen de la consulta de verdad; lo retenido no cuenta en «conservar hasta»", async () => {
    const c = await makeClient(a, { name: "Cifras SL" });
    // Electrónica y retenida, con fecha de 2027: si contara, el ejercicio se conservaría hasta 2033.
    const held = await makeInvoice(c, { status: "VALIDATED", periodMonth: 12, invoiceDate: utc("2027-01-15") });
    await prisma.invoiceArchive.update({
      where: { invoiceId: held.id },
      data: { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", retentionHold: true, retentionHoldReason: "FIXED_ASSET" },
    });
    const paper = await makeInvoice(c, { status: "EXPORTED", periodMonth: 3, invoiceDate: utc("2026-03-10") });
    await prisma.invoiceArchive.update({
      where: { invoiceId: paper.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });
    await register(paper, 1);
    await makeInvoice(c, { status: "VALIDATED", periodMonth: 5, invoiceDate: utc("2026-05-10") });

    const years = (await loadArchiveMetrics(await scopeOf(a.admin))).clients.find((x) => x.clientId === c.id)?.years;
    expect(years).toEqual([expect.objectContaining({
      startYear: 2026, invoices: 3, electronic: 1, paper: 1, unconfirmed: 1, registered: 1, unregistered: 2, retentionHold: 1,
      retainUntil: utc("2032-12-31"),
    })]);
  });
});

describe("el archivo de un cliente (loadClientArchive)", () => {
  let c: { id: string };
  let invoices: Record<string, Invoice>;

  beforeEach(async () => {
    c = await makeClient(a);
    const p1 = await makeInvoice(c, { invoiceNumber: "P-1" });
    const p2 = await makeInvoice(c, { invoiceNumber: "P-2" });
    await setReceived(p1, "2026-10-02T09:00:00Z");
    await setReceived(p2, "2026-10-01T09:00:00Z");
    const s1 = await makeInvoice(c, { type: "SALE", invoiceNumber: "F-10", invoiceDate: utc("2026-09-20"), receiverName: "Comprador SA" });
    const s2 = await makeInvoice(c, { type: "SALE", invoiceNumber: "F-2", invoiceDate: utc("2026-09-20") });
    const p3 = await makeInvoice(c, { periodMonth: 10, invoiceNumber: "P-3", totalAmount: 1134.6 });
    const p4 = await makeInvoice(c, { accountingPeriodMonth: 8, accountingPeriodYear: 2026, invoiceNumber: "P-4" });
    invoices = { p1, p2, s1, s2, p3, p4 };
  });

  const load = (options: Partial<Parameters<typeof loadClientArchive>[0]> = {}) =>
    loadClientArchive({ firmId: a.firm.id, clientId: c.id, ...options });
  const numbers = (archive: Awaited<ReturnType<typeof load>>) => archive!.rows.map((r) => r.invoiceNumber);

  it("en el orden del archivo, con los periodos y las cifras del ejercicio", async () => {
    const archive = await load();
    expect(archive?.fiscalYear).toEqual({ startYear: 2026, label: "2026" });
    expect(archive?.fiscalYears).toEqual([{ startYear: 2026, label: "2026" }]);
    expect(numbers(archive)).toEqual(["P-4", "P-2", "P-1", "F-2", "F-10", "P-3"]);
    expect(archive?.periods.map((p) => [p.label, p.count])).toEqual([["Agosto 2026", 1], ["Septiembre 2026", 4], ["Octubre 2026", 1]]);
    expect(archive?.summary).toMatchObject({
      invoices: 6, received: 4, issued: 2, unconfirmed: 6, unregistered: 6, pendingValidation: 6, rejected: 0,
      retainUntil: utc("2032-12-31"),
    });
    const s1 = archive!.rows.find((r) => r.invoiceNumber === "F-10");
    expect(s1).toMatchObject({ thirdPartyName: "Comprador SA", type: "SALE", retainUntil: utc("2032-12-31"), medium: null });
    const p3 = archive!.rows.find((r) => r.invoiceNumber === "P-3");
    expect(p3?.warnings.map((w) => w.label)).toEqual(["Fecha de otro periodo"]);
  });

  it("filtros: tipo, original, rechazadas y texto (nº de factura, nº de registro e importe impreso)", async () => {
    const { p1, p2 } = invoices;
    await prisma.invoiceArchive.update({ where: { invoiceId: p1.id }, data: { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" } });
    await prisma.invoiceArchive.update({ where: { invoiceId: p2.id }, data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" } });
    await register(p2, 1);
    await makeInvoice(c, { status: "REJECTED", invoiceNumber: "R-9", rejectionReason: "Ilegible" });

    expect(numbers(await load({ filters: { type: "emitidas" } }))).toEqual(["F-2", "F-10"]);
    expect(numbers(await load({ filters: { type: "recibidas" } }))).toEqual(["P-4", "P-2", "P-1", "P-3"]);
    expect(numbers(await load({ filters: { medium: "electronico" } }))).toEqual(["P-1"]);
    expect(numbers(await load({ filters: { medium: "papel" } }))).toEqual(["P-2"]);
    expect(numbers(await load({ filters: { medium: "por-confirmar" } }))).toEqual(["P-4", "F-2", "F-10", "P-3"]);

    const withoutRejected = await load();
    expect(numbers(withoutRejected)).not.toContain("R-9");
    expect(withoutRejected?.summary).toMatchObject({ invoices: 6, rejected: 1, electronic: 1, paper: 1, unconfirmed: 4, registered: 1 });
    const withRejected = await load({ filters: { includeRejected: true } });
    expect(withRejected?.rows.find((r) => r.invoiceNumber === "R-9")).toMatchObject({ status: "REJECTED", rejectionReason: "Ilegible" });

    expect(numbers(await load({ filters: { q: "f-2" } }))).toEqual(["F-2"]);
    expect(numbers(await load({ filters: { q: "R-2026/0001" } }))).toEqual(["P-2"]);
    expect(numbers(await load({ filters: { q: "r 2026/1" } }))).toEqual(["P-2"]);
    expect(numbers(await load({ filters: { q: "1.134,60" } }))).toEqual(["P-3"]);
    expect((await load({ filters: { q: "R-2026/0001" } }))?.rows[0]).toMatchObject({
      registerNumber: "R-2026/0001", medium: "PAPER", mediumReasonLabel: "Puesto a mano",
    });
  });

  it("«conservar más» cuenta en las cifras de la pestaña y no entra en su «conservar hasta»", async () => {
    // Con fecha de 2027: sin la marca, alarga el «conservar hasta» del ejercicio.
    const late = await makeInvoice(c, { periodMonth: 12, invoiceDate: utc("2027-01-20"), invoiceNumber: "P-INM" });
    await prisma.invoiceArchive.update({ where: { invoiceId: late.id }, data: { retentionHold: true, retentionHoldReason: "FIXED_ASSET" } });
    expect((await load())?.summary).toMatchObject({ invoices: 7, retentionHold: 1, retainUntil: utc("2032-12-31") });
    await prisma.invoiceArchive.update({ where: { invoiceId: late.id }, data: { retentionHold: false, retentionHoldReason: null } });
    expect((await load())?.summary).toMatchObject({ invoices: 7, retentionHold: 0, retainUntil: utc("2033-12-31") });
  });

  it("pagina en memoria, sin perder el orden ni los periodos", async () => {
    const archive = await load({ page: 2, pageSize: 2 });
    expect(numbers(archive)).toEqual(["P-1", "F-2"]);
    expect(archive?.window).toMatchObject({ page: 2, totalPages: 3, total: 6, from: 3, to: 4 });
    expect(archive?.periods.map((p) => p.count)).toEqual([1, 4, 1]);
    // Sin pedirlas, no hay ids para elegir más allá de la página.
    expect(archive?.selectableIds).toEqual([]);
  });

  it("lo que se puede elegir de una vez: todo lo filtrado, en orden y hasta el tope, aunque vaya en varias páginas", async () => {
    const { p1, p2, p3, p4, s1, s2 } = invoices;
    const all = await load({ page: 3, pageSize: 2, selectionLimit: 200 });
    expect(all?.selectableIds).toEqual([p4, p2, p1, s2, s1, p3].map((i) => i.id));
    const received = await load({ pageSize: 2, selectionLimit: 200, filters: { type: "recibidas" } });
    expect(received?.selectableIds).toEqual([p4, p2, p1, p3].map((i) => i.id));
    expect((await load({ pageSize: 2, selectionLimit: 3 }))?.selectableIds).toEqual([p4, p2, p1].map((i) => i.id));
  });

  it("«Registrada tarde» mira toda la serie, también lo que no sale en la página", async () => {
    const { p1, p3 } = invoices;
    await register(p3, 1);
    await register(p1, 2);
    const firstPage = await load({ page: 1, pageSize: 3 });
    expect(firstPage?.rows.find((r) => r.invoiceNumber === "P-1")?.warnings.map((w) => w.label)).toEqual(["Registrada tarde"]);
    const lastPage = await load({ page: 2, pageSize: 3 });
    expect(lastPage?.rows.find((r) => r.invoiceNumber === "P-3")?.warnings.map((w) => w.label)).toEqual(["Fecha de otro periodo"]);
  });

  it("un cliente de otra asesoría, o el buzón, no tiene archivo", async () => {
    expect(await loadClientArchive({ firmId: b.firm.id, clientId: c.id })).toBeNull();
    const bucket = await getOrCreateUnclassifiedClient(a.firm.id);
    expect(await loadClientArchive({ firmId: a.firm.id, clientId: bucket.id })).toBeNull();
  });
});

describe("el archivo: ejercicios y divisiones", () => {
  it("con el ejercicio de julio a junio agrupa y conserva por ese ejercicio", async () => {
    const c = await makeClient(a, { fiscalYearStartMonth: 7 });
    await makeInvoice(c, { periodMonth: 3, invoiceNumber: "MAR", invoiceDate: utc("2026-03-05") });
    await makeInvoice(c, { periodMonth: 9, invoiceNumber: "SEP" });
    const latest = await loadClientArchive({ firmId: a.firm.id, clientId: c.id });
    expect(latest?.fiscalYears.map((y) => y.label)).toEqual(["2026-27", "2025-26"]);
    expect(latest?.fiscalYear).toEqual({ startYear: 2026, label: "2026-27" });
    expect(latest?.rows.map((r) => r.invoiceNumber)).toEqual(["SEP"]);
    const previous = await loadClientArchive({ firmId: a.firm.id, clientId: c.id, fiscalYear: 2025 });
    expect(previous?.fiscalYear).toEqual({ startYear: 2025, label: "2025-26" });
    expect(previous?.rows.map((r) => [r.invoiceNumber, r.retainUntil])).toEqual([["MAR", utc("2032-06-30")]]);
  });

  it("un cliente trimestral: lo del lote T3 y lo pasado a julio desde el T2 van en un solo grupo, seguido (R2: por el primer mes)", async () => {
    const c = await makeClient(a);
    const quarterly = { periodType: "QUARTERLY" as const, invoiceDate: utc("2026-07-15") };
    const first = await makeInvoice(c, { ...quarterly, periodMonth: 7, invoiceNumber: "T3-A" });
    const moved = await makeInvoice(c, { ...quarterly, periodMonth: 4, accountingPeriodMonth: 7, accountingPeriodYear: 2026, invoiceNumber: "T2-JUL" });
    const last = await makeInvoice(c, { ...quarterly, periodMonth: 7, invoiceNumber: "T3-B" });
    await makeInvoice(c, { ...quarterly, periodMonth: 4, accountingPeriodMonth: 8, accountingPeriodYear: 2026, invoiceNumber: "T2-AGO" });
    await setReceived(first, "2026-10-01T09:00:00Z");
    await setReceived(moved, "2026-10-02T09:00:00Z");
    await setReceived(last, "2026-10-03T09:00:00Z");

    const archive = (await loadClientArchive({ firmId: a.firm.id, clientId: c.id }))!;
    expect(archive.rows.map((r) => [r.invoiceNumber, r.periodLabel])).toEqual([
      ["T3-A", "T3 2026"],
      ["T2-JUL", "T3 2026"],
      ["T3-B", "T3 2026"],
      ["T2-AGO", "Agosto 2026"],
    ]);
    expect(archive.periods.map((p) => [p.label, p.count])).toEqual([["T3 2026", 3], ["Agosto 2026", 1]]);
    expect(archive.rows.map((r) => r.periodKey)).toEqual([archive.periods[0].key, archive.periods[0].key, archive.periods[0].key, archive.periods[1].key]);
    // El subtítulo no cambia con los filtros: sigue siendo el del trimestre.
    const onlyMoved = (await loadClientArchive({ firmId: a.firm.id, clientId: c.id, filters: { q: "T2-JUL" } }))!;
    expect(onlyMoved.periods.map((p) => [p.label, p.count])).toEqual([["T3 2026", 1]]);
  });

  it("las originales divididas no salen; sus partes, con «Parte 1 de 2» (y una parte dividida otra vez deja paso a sus hijas)", async () => {
    const c = await makeClient(a);
    const root = await makeInvoice(c, { status: "SPLIT_SOURCE", invoiceNumber: "ENTERA" });
    const parts: Invoice[] = [];
    for (const [n, number] of [[1, "K-1"], [2, "K-2"]] as const) {
      const part = await makeInvoice(c, { splitFromId: root.id, invoiceNumber: number });
      await prisma.invoiceArchive.update({ where: { invoiceId: part.id }, data: { splitPart: n, receivedAt: root.createdAt } });
      parts.push(part);
    }
    const split = (await loadClientArchive({ firmId: a.firm.id, clientId: c.id }))!;
    expect(split.rows.map((r) => [r.invoiceNumber, r.warnings.map((w) => w.label)])).toEqual([
      ["K-1", ["Parte 1 de 2"]],
      ["K-2", ["Parte 2 de 2"]],
    ]);
    expect(split.rows[0].split).toEqual({ rootId: root.id, index: 1, count: 2 });
    expect(split.summary.invoices).toBe(2);

    await prisma.invoice.update({ where: { id: parts[0].id }, data: { status: "SPLIT_SOURCE" } });
    for (const [n, number] of [[3, "K-1a"], [4, "K-1b"]] as const) {
      const grand = await makeInvoice(c, { splitFromId: parts[0].id, invoiceNumber: number });
      await prisma.invoiceArchive.update({ where: { invoiceId: grand.id }, data: { splitPart: n, receivedAt: root.createdAt } });
    }
    const resplit = (await loadClientArchive({ firmId: a.firm.id, clientId: c.id }))!;
    expect(resplit.rows.map((r) => [r.invoiceNumber, r.split?.index, r.split?.count, r.split?.rootId])).toEqual([
      ["K-2", 1, 3, root.id],
      ["K-1a", 2, 3, root.id],
      ["K-1b", 3, 3, root.id],
    ]);
  });

  it("una parte que va «igual que el documento dividido» dice el motivo de su raíz: en la tabla, en la ficha y en el buscador", async () => {
    const c = await makeClient(a);
    // Una foto con varios tickets, dividida: la raíz dice por qué está «Por confirmar».
    const root = await makeInvoice(c, { status: "SPLIT_SOURCE", invoiceNumber: null });
    await prisma.invoiceArchive.update({
      where: { invoiceId: root.id },
      data: { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "image_unconfirmed" },
    });
    const auto = await makeInvoice(c, { splitFromId: root.id, invoiceNumber: "TK-1" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: auto.id },
      data: { splitPart: 1, originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "split" },
    });
    const manual = await makeInvoice(c, { splitFromId: root.id, invoiceNumber: "TK-2" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: manual.id },
      data: { splitPart: 2, originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });

    const label = "Foto: falta confirmar si hay papel (todo el documento dividido)";
    const rows = (await loadClientArchive({ firmId: a.firm.id, clientId: c.id }))!.rows;
    expect(Object.fromEntries(rows.map((r) => [r.invoiceNumber, r.mediumReasonLabel]))).toEqual({ "TK-1": label, "TK-2": "Puesto a mano" });
    expect((await loadArchiveInvoice(auto.id, a.firm.id))?.row.mediumReasonLabel).toBe(label);
    expect((await searchArchive(await scopeOf(a.admin), "TK-1")).map((r) => [r.invoiceNumber, r.mediumReasonLabel])).toEqual([["TK-1", label]]);
    // La raíz de otra asesoría no cuenta, y si la raíz ya tiene otro medio, el
    // motivo de la raíz no explica el de la parte.
    expect(await loadArchiveInvoice(auto.id, b.firm.id)).toBeNull();
    await prisma.invoiceArchive.update({
      where: { invoiceId: root.id },
      data: { originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" },
    });
    expect((await loadArchiveInvoice(auto.id, a.firm.id))?.row.mediumReasonLabel).toBe("Igual que el documento dividido del que sale");
  });
});

describe("ficha de archivo (loadArchiveInvoice)", () => {
  it("la fila, el documento entero de una parte, el original adjunto, la sugerencia de inmovilizado y solo el historial del archivo", async () => {
    const root = await makeInvoice(a.client, { status: "SPLIT_SOURCE", filename: "entero.pdf" });
    const part = await makeInvoice(a.client, { splitFromId: root.id, status: "VALIDATED", expenseAccount: "21300000" });
    const document = await prisma.document.create({
      data: { filename: "factura.docx", storageKey: `${a.client.id}/originales/2-u-factura.docx`, fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", clientId: a.client.id },
    });
    await prisma.invoiceArchive.update({
      where: { invoiceId: part.id },
      data: { splitPart: 1, originalDocumentId: document.id, originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "other_format", pdfProducer: "Microsoft Word" },
    });
    await appendAuditLogs([
      { invoiceId: part.id, userId: a.admin.id, field: "status", oldValue: "PENDING_REVIEW", newValue: "VALIDATED" },
      { invoiceId: part.id, userId: a.admin.id, field: "originalMedium", oldValue: null, newValue: "ELECTRONIC" },
    ]);

    const detail = await loadArchiveInvoice(part.id, a.firm.id);
    expect(detail).toMatchObject({
      client: { id: a.client.id, fiscalYearStartMonth: 1 },
      fiscalYear: { startYear: 2026, label: "2026" },
      splitRoot: { id: root.id, filename: "entero.pdf" },
      originalDocument: { id: document.id, filename: "factura.docx" },
      pdfProducer: "Microsoft Word",
      suggestedRetentionHold: "FIXED_ASSET",
      splitPart: 1,
    });
    expect(detail?.row).toMatchObject({ medium: "ELECTRONIC", mediumReasonLabel: "Hay un original en otro formato adjunto", split: { rootId: root.id, index: 1, count: 1 } });
    expect(detail?.history.map((h) => [h.field, h.newValue])).toEqual([["originalMedium", "ELECTRONIC"]]);
    expect(await loadArchiveInvoice(part.id, b.firm.id)).toBeNull();
  });
});

// Entrega B, I5: dónde está el papel en las lecturas del archivo (B-R12), lo
// que no tiene ubicación (B-R13) en el filtro y en las cifras, el buscador por
// taco y por caja (B-R19) y el bloque «Ubicación» de la ficha. Con tacos
// insertados a mano (makeTaco) y facturas puestas en ellos.
import { describe, it, expect, beforeEach } from "vitest";
import type { InvoiceStatus, OriginalMedium, OriginalMediumSource, UploadBatch } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeTaco, makeUser, type FirmWorld } from "./helpers/factories";
import { archiveScope } from "@/lib/archiveAccess";
import { loadArchiveInvoice, loadArchiveMetrics, loadClientArchive, searchArchive } from "@/lib/archiveData";
import { boxLabelPrefix } from "@/lib/boxProposal";
import { formatDayEs } from "@/lib/dates";
import { shortPaperLocationText } from "@/lib/paperLocation";
import { tacoAlerts } from "@/lib/tacoData";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

const today = () => formatDayEs(new Date());

type PaperOptions = {
  medium?: OriginalMedium | null;
  source?: OriginalMediumSource | null;
  reason?: string | null;
  held?: boolean;
  paperBatchId?: string;
  status?: InvoiceStatus;
  number?: string;
  client?: { id: string };
};

/** Una factura que llegó en `batch`, en su posición; por defecto papel del taco (PAPER/TACO). */
async function arrivedIn(batch: Pick<UploadBatch, "id" | "createdAt">, position: number, options: PaperOptions = {}) {
  const invoice = await makeInvoice(options.client ?? a.client, {
    status: options.status ?? "VALIDATED",
    ...(options.number ? { invoiceNumber: options.number } : {}),
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: {
      uploadBatchId: batch.id,
      uploadPosition: position,
      receivedAt: batch.createdAt,
      originalMedium: options.medium === undefined ? "PAPER" : options.medium,
      originalMediumSource: options.source === undefined ? "TACO" : options.source,
      originalMediumReason: options.reason === undefined ? "taco" : options.reason,
      paperHeldByClient: options.held ?? false,
      ...(options.paperBatchId ? { paperBatchId: options.paperBatchId } : {}),
    },
  });
  return invoice;
}

/** Una factura sin tanda: papel a mano, «Por confirmar», electrónica… */
async function loose(medium: OriginalMedium | null, options: PaperOptions = {}) {
  const invoice = await makeInvoice(options.client ?? a.client, {
    status: options.status ?? "VALIDATED",
    ...(options.number ? { invoiceNumber: options.number } : {}),
  });
  const data =
    medium === "PAPER" ? { originalMedium: medium, originalMediumSource: "MANUAL" as const, originalMediumReason: "manual" }
    : medium === "ELECTRONIC" ? { originalMedium: medium, originalMediumSource: "AUTO" as const, originalMediumReason: "pdf_text" }
    : { originalMedium: null, originalMediumSource: null, originalMediumReason: null };
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: { ...data, paperHeldByClient: options.held ?? false, ...(options.paperBatchId ? { paperBatchId: options.paperBatchId } : {}) },
  });
  return invoice;
}

/** Un cliente más de la asesoría, sin facturas (las de makeFirm están «Por confirmar»). */
async function freshClient(w: FirmWorld, name: string) {
  return prisma.client.create({ data: { name, cif: `B9${String(Math.random()).slice(2, 9)}`, advisoryFirmId: w.firm.id } });
}

const rowsByNumber = async (clientId: string, filters = {}) => {
  const archive = await loadClientArchive({ firmId: a.firm.id, clientId, fiscalYear: 2026, filters, pageSize: 200 });
  return new Map(archive!.rows.map((row) => [row.invoiceNumber, row]));
};

const PREFIX = "Cliente A SL · 2026 · Caja ";

describe("la ubicación en las filas del archivo (B-R12)", () => {
  it("cada caso con su texto exacto y su forma corta en la pestaña del cliente", async () => {
    const boxed = await makeTaco(a, { filed: { boxLabel: `${PREFIX}3` } });
    const returned = await makeTaco(a, { filed: { returned: true } });
    const unfiled = await makeTaco(a);
    const voided = await makeTaco(a, { voided: { reason: "Subido al cliente equivocado" } });
    const whole = await makeTaco(a, { wholePdf: { pageCount: 6, split: { byId: a.worker.id } } });
    const manual = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Estantería B" } });
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 4 });

    await arrivedIn(boxed, 2, { number: "BOX" });
    await arrivedIn(returned, 1, { number: "RET" });
    await arrivedIn(unfiled, 1, { number: "UNF" });
    await arrivedIn(voided, 1, { number: "VOID", status: "REJECTED" });
    await arrivedIn(whole, 4, { number: "WHOLE" });
    await arrivedIn(boxed, 3, { number: "ELEC", medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text" });
    await arrivedIn(boxed, 1, { number: "HELD", source: "MANUAL", reason: "manual", held: true });
    await loose("PAPER", { number: "HAND", paperBatchId: manual.id });
    await loose(null, { number: "UNC" });
    await loose("PAPER", { number: "NONE" });
    await arrivedIn(digital, 2, { number: "DIG", medium: null, source: null, reason: null });

    const rows = await rowsByNumber(a.client.id, { includeRejected: true });
    const text = (n: string) => rows.get(n)!.location.text;
    expect(text("BOX")).toBe(`${PREFIX}3 · Taco ${boxed.tacoNumber} · Pág. 2`);
    expect(text("RET")).toBe(`Devuelto al cliente el ${today()} · Taco ${returned.tacoNumber} · Pág. 1`);
    expect(text("UNF")).toBe(`Taco ${unfiled.tacoNumber} · Pág. 1 (sin guardar)`);
    expect(text("VOID")).toBe(`Taco ${voided.tacoNumber} · Pág. 1 (taco anulado)`);
    expect(text("WHOLE")).toBe(`Taco ${whole.tacoNumber} · Pág. 4 del PDF (sin guardar)`);
    expect(text("ELEC")).toBe("Original electrónico");
    expect(text("HELD")).toBe("Lo guarda el cliente");
    expect(text("HAND")).toBe("Estantería B · papel ubicado a mano");
    expect(text("UNC")).toBe("Por confirmar");
    expect(text("NONE")).toBe("Sin ubicación");
    expect(text("DIG")).toBe("Por confirmar");

    // El taco de cada una enlaza a su detalle; la que llegó en una subida digital, a la subida.
    expect(rows.get("BOX")!.location.tacoId).toBe(boxed.id);
    expect(rows.get("HAND")!.location.tacoId).toBe(manual.id);
    expect(rows.get("DIG")!.arrivalBatch).toEqual({ id: digital.id, createdAt: digital.createdAt, fileCount: 4 });
    expect(rows.get("BOX")!.arrivalBatch).toBeNull();

    // Forma corta de la pestaña: sin «Cliente A SL · 2026 · ».
    const prefix = boxLabelPrefix({ mode: "PER_CLIENT_YEAR", clientName: "Cliente A SL", fiscalYearLabel: "2026" });
    expect(shortPaperLocationText(rows.get("BOX")!.location, prefix)).toBe(`Caja 3 · T${boxed.tacoNumber} · Pág. 2`);
    expect(shortPaperLocationText(rows.get("HAND")!.location, prefix)).toBe("Estantería B · papel ubicado a mano");
    expect(shortPaperLocationText(rows.get("UNF")!.location, prefix)).toBe(`T${unfiled.tacoNumber} · Pág. 1 (sin guardar)`);
  });

  it("«Solo sin ubicación» trae el papel y lo «Por confirmar» sin ubicación, sin rechazadas; y el resumen las cuenta", async () => {
    const client = await freshClient(a, "Panadería López SL");
    const taco = await makeTaco(a, { clientId: client.id });
    await loose("PAPER", { client, number: "P1" });
    await loose("PAPER", { client, number: "P2" });
    await loose(null, { client, number: "U1" });
    await loose(null, { client, number: "R1", status: "REJECTED" });
    await loose("PAPER", { client, number: "H1", held: true });
    await loose("ELECTRONIC", { client, number: "E1" });
    await arrivedIn(taco, 1, { client, number: "T1" });

    const archive = await loadClientArchive({
      firmId: a.firm.id, clientId: client.id, fiscalYear: 2026, filters: { withoutLocation: true, includeRejected: true },
    });
    expect(archive!.rows.map((row) => row.invoiceNumber).sort()).toEqual(["P1", "P2", "U1"]);
    expect(archive!.summary).toMatchObject({ paperWithoutLocation: 2, unconfirmedWithoutLocation: 1, paper: 4 });
  });

  it("las cifras de la asesoría: 3 de papel y 2 «Por confirmar» sin ubicación, por cliente y ejercicio", async () => {
    const client = await freshClient(a, "Bar Pepe SL");
    const taco = await makeTaco(a, { clientId: client.id });
    for (const n of ["P1", "P2", "P3"]) await loose("PAPER", { client, number: n });
    for (const n of ["U1", "U2"]) await loose(null, { client, number: n });
    await loose("PAPER", { client, number: "H", held: true });
    await loose("PAPER", { client, number: "X", status: "REJECTED" });
    await arrivedIn(taco, 1, { client, number: "T" });

    const metrics = await loadArchiveMetrics({ firmId: a.firm.id, clientIds: [client.id] });
    expect(metrics.clients[0].years[0]).toMatchObject({ startYear: 2026, paper: 5, paperWithoutLocation: 3, unconfirmedWithoutLocation: 2 });
    expect(metrics.totals[0]).toMatchObject({ paperWithoutLocation: 3, unconfirmedWithoutLocation: 2 });
  });

  it("lo «Por confirmar» que espera su análisis o se analiza no cuenta como sin ubicación (cifras, filtro y aviso del Resumen)", async () => {
    const client = await freshClient(a, "Taller Ruiz SL");
    await loose(null, { client, number: "U1" });
    await loose(null, { client, number: "W1", status: "UPLOADED" });
    await loose(null, { client, number: "W2", status: "ANALYZING" });

    const archive = await loadClientArchive({ firmId: a.firm.id, clientId: client.id, fiscalYear: 2026, filters: { withoutLocation: true } });
    expect(archive!.rows.map((row) => row.invoiceNumber)).toEqual(["U1"]);
    expect(archive!.summary).toMatchObject({ unconfirmed: 3, unconfirmedWithoutLocation: 1 });
    const metrics = await loadArchiveMetrics({ firmId: a.firm.id, clientIds: [client.id] });
    expect(metrics.clients[0].years[0]).toMatchObject({ unconfirmed: 3, unconfirmedWithoutLocation: 1 });
    const alerts = await tacoAlerts({ firmId: a.firm.id, userId: a.admin.id, role: "ADMIN", clientIds: [client.id] });
    expect(alerts).toMatchObject({ paperWithoutLocation: 0, unconfirmedWithoutLocation: 1 });
  });
});

describe("el buscador por taco y por caja (B-R19)", () => {
  it("«T1», «taco 1 pág 2», la página de un taco entero, «caja 3» y las palabras de la caja; nunca de otra asesoría", async () => {
    const t1 = await makeTaco(a, { filed: { boxLabel: `${PREFIX}3` } });
    const t2 = await makeTaco(a, { wholePdf: { pageCount: 6, split: { byId: a.worker.id } } });
    const t3 = await makeTaco(a, { filed: { boxLabel: `${PREFIX}13` } });
    const p1 = await arrivedIn(t1, 1, { number: "UNO" });
    const p2 = await arrivedIn(t1, 2, { number: "DOS" });
    const w1 = await arrivedIn(t2, 1, { number: "W-1" });
    const w4 = await arrivedIn(t2, 4, { number: "W-4" });
    const c13 = await arrivedIn(t3, 1, { number: "TRECE" });
    // El mismo nº de taco en la otra asesoría.
    const other = await makeTaco(b, { tacoNumber: t1.tacoNumber, filed: { boxLabel: "Cliente B SL · 2026 · Caja 3" } });
    await arrivedIn(other, 1, { client: b.client, number: "DE-B" });

    const scope = (await archiveScope({ user: a.admin }))!;
    const ids = async (q: string) => (await searchArchive(scope, q)).map((r) => r.invoiceId).sort();
    expect(await ids(`T${t1.tacoNumber}`)).toEqual([p1.id, p2.id].sort());
    expect(await ids(`taco ${t1.tacoNumber} pág 2`)).toEqual([p2.id]);
    // En el taco entero, la que cubre la página: la que empieza en la 4 llega a la 6.
    expect(await ids(`T${t2.tacoNumber} pág 5`)).toEqual([w4.id]);
    expect(await ids(`T${t2.tacoNumber}/3`)).toEqual([w1.id]);
    expect(await ids("caja 3")).toEqual([p1.id, p2.id].sort());
    expect(await ids("cliente a 2026 caja")).toEqual([p1.id, p2.id, c13.id].sort());

    const [first] = await searchArchive(scope, `taco ${t1.tacoNumber} pág 2`);
    expect(first).toMatchObject({ matchedBy: expect.arrayContaining(["taco"]), exact: true });
    expect(first.location.text).toBe(`${PREFIX}3 · Taco ${t1.tacoNumber} · Pág. 2`);
    expect((await searchArchive(scope, "caja 3"))[0].matchedBy).toContain("caja");

    // Desde la otra asesoría, el mismo nº solo trae lo suyo.
    const scopeB = (await archiveScope({ user: b.admin }))!;
    expect((await searchArchive(scopeB, `T${t1.tacoNumber}`)).map((r) => r.invoiceNumber)).toEqual(["DE-B"]);
  });

  it("las palabras de una caja no tapan lo que se busca: el cliente o el año solos no traen su papel guardado, y cuentan como texto", async () => {
    const taco = await makeTaco(a, { fileCount: 60, filed: { boxLabel: `${PREFIX}1` } });
    for (let page = 1; page <= 60; page++) await arrivedIn(taco, page, { number: `P-${page}` });
    const wanted = await makeInvoice(a.client, {
      status: "VALIDATED", invoiceNumber: "FRA-2026-0077", createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const scope = (await archiveScope({ user: a.admin }))!;

    // «2026» está en la etiqueta de las 60, pero solo como el ejercicio del cliente.
    const byYear = await searchArchive(scope, "2026");
    expect(byYear.map((r) => r.invoiceId)).toContain(wanted.id);
    expect(byYear.filter((r) => r.matchedBy.includes("caja"))).toEqual([]);
    // Con una palabra de lo escrito en la caja, sí, pero como texto (no exacta); «caja 1» sigue siendo exacta.
    const byWords = await searchArchive(scope, "cliente a 2026 caja 1");
    expect(byWords).toHaveLength(50);
    expect(byWords.every((r) => r.matchedBy.includes("caja") && !r.exact)).toBe(true);
    const byNumber = await searchArchive(scope, "caja 1");
    expect(byNumber.every((r) => r.matchedBy.includes("caja") && r.exact)).toBe(true);

    // El filtro de la pestaña del cliente, igual.
    const tab = async (q: string) => [...(await rowsByNumber(a.client.id, { q })).keys()];
    expect(await tab("2026")).toContain("FRA-2026-0077");
    expect(await tab("2026")).not.toContain("P-1");
    expect(await tab("Cliente")).not.toContain("P-1");
    expect(await tab("cliente a 2026 caja 1")).toContain("P-1");
    expect(await tab("caja 1")).toHaveLength(60);
  });

  it("el filtro de la pestaña entiende el taco como el buscador: la página de un taco entero y lo que se sacó del taco", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 30, split: { byId: a.worker.id } } });
    await arrivedIn(whole, 1, { number: "W-1" });
    await arrivedIn(whole, 27, { number: "W-27" });
    const taco = await makeTaco(a, { fileCount: 2, filed: { boxLabel: `${PREFIX}2` } });
    await arrivedIn(taco, 1, { number: "QUEDA" });
    const moved = await arrivedIn(taco, 2, { number: "SACADA" });
    const archived = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Estantería C" } });
    await prisma.invoiceArchive.update({ where: { invoiceId: moved.id }, data: { paperBatchId: archived.id } });

    const tab = async (q: string) => [...(await rowsByNumber(a.client.id, { q })).keys()].sort();
    const scope = (await archiveScope({ user: a.admin }))!;
    const search = async (q: string) => (await searchArchive(scope, q)).map((r) => r.invoiceNumber).sort();
    for (const q of [`T${whole.tacoNumber} pág 28`, `T${taco.tacoNumber}`, `T${taco.tacoNumber} pág 2`, `T${archived.tacoNumber}`]) {
      expect(await tab(q)).toEqual(await search(q));
    }
    expect(await tab(`T${whole.tacoNumber} pág 28`)).toEqual(["W-27"]);
    expect(await tab(`T${taco.tacoNumber}`)).toEqual(["QUEDA", "SACADA"]);
  });

  it("el gestor solo encuentra los tacos de sus clientes", async () => {
    const outsider = await freshClient(a, "Ajeno SL");
    const mine = await makeTaco(a);
    const theirs = await makeTaco(a, { clientId: outsider.id });
    await arrivedIn(mine, 1, { number: "MIA" });
    await arrivedIn(theirs, 1, { client: outsider, number: "AJENA" });

    const worker = (await archiveScope({ user: a.worker }))!;
    expect((await searchArchive(worker, `T${theirs.tacoNumber}`))).toEqual([]);
    expect((await searchArchive(worker, `T${mine.tacoNumber}`)).map((r) => r.invoiceNumber)).toEqual(["MIA"]);
    const admin = (await archiveScope({ user: a.admin }))!;
    expect((await searchArchive(admin, `T${theirs.tacoNumber}`)).map((r) => r.invoiceNumber)).toEqual(["AJENA"]);
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsolo");
    expect(await searchArchive((await archiveScope({ user: stranger }))!, `T${mine.tacoNumber}`)).toEqual([]);
  });
});

describe("el bloque «Ubicación» de la ficha", () => {
  it("en un taco entero, sus páginas del PDF, su orden y el enlace al PDF; de una subida digital, la subida", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 6, split: { byId: a.worker.id } } });
    await arrivedIn(whole, 1, { number: "W-1" });
    const second = await arrivedIn(whole, 4, { number: "W-4" });
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 2 });
    const fromDigital = await arrivedIn(digital, 1, { number: "D-1", medium: null, source: null, reason: null });

    const detail = await loadArchiveInvoice(second.id, a.firm.id);
    expect(detail!.row.location).toMatchObject({ kind: "unfiled", tacoId: whole.id, page: 4 });
    expect(detail!.wholeTacoRange).toEqual({ tacoId: whole.id, tacoNumber: whole.tacoNumber, start: 4, end: 6, order: 2 });
    expect(detail!.tacoPdfUrl).toBe(`/api/archive/tacos/${whole.id}/pdf`);

    const plain = await loadArchiveInvoice(fromDigital.id, a.firm.id);
    expect(plain!.row.location.kind).toBe("unconfirmed");
    expect(plain!.row.arrivalBatch).toEqual({ id: digital.id, createdAt: digital.createdAt, fileCount: 2 });
    expect(plain!.wholeTacoRange).toBeNull();
    expect(plain!.tacoPdfUrl).toBeNull();
  });
});

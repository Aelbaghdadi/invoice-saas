// Archivo, paso 10 (R20): el archivo de un ejercicio en un ZIP, con los
// originales de verdad en el orden del archivo, indice.xlsx, LEEME.txt y
// ERRORES.txt. El test descomprime con fflate y lee el índice con xlsx.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { strFromU8, strToU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import type { Invoice, Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, makeTaco, type FirmWorld } from "./helpers/factories";
import { signInAs, signOut } from "./helpers/session";
import { GET as archiveZip } from "@/app/api/archive/clients/[id]/zip/route";
import { CLIENT_EXPORT_LIMITS } from "@/lib/clientDataExport";
import { ARCHIVE_INDEX_HEADERS } from "@/lib/archiveExportFormat";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Nº de serie de Excel de un día: el índice guarda así las fechas (sin zona). */
const excelDay = (day: string) => (Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const ERRORS_HEADER = "Originales que faltan o que no coinciden con lo que se subió (ruta y motivo):\r\n\r\n";

const limits = { ...CLIENT_EXPORT_LIMITS };
afterEach(() => Object.assign(CLIENT_EXPORT_LIMITS, limits));

let w: FirmWorld;
let client: { id: string; name: string; cif: string };
let sequence = 0;
/** Lo que se guardó de cada original, por factura. */
const contents = new Map<string, string>();

beforeEach(async () => {
  w = await makeFirm("A");
  client = await prisma.client.create({
    data: { name: "Panadería López SL", cif: `B7${String(Date.now()).slice(-7)}`, advisoryFirmId: w.firm.id },
    select: { id: true, name: true, cif: true },
  });
});

const call = (clientId: string, query: string) =>
  archiveZip(new NextRequest(`http://x/api/archive/clients/${clientId}/zip${query}`), { params: Promise.resolve({ id: clientId }) });

/** Una factura con su original en el S3 falso (content null: no está) y su llegada. */
async function stored(
  overrides: Partial<Prisma.InvoiceUncheckedCreateInput>,
  options: { receivedAt: string; content?: string | null; hash?: string | null; owner?: { id: string } },
): Promise<Invoice> {
  const n = ++sequence;
  const content = options.content === undefined ? `%PDF-1.4 factura ${n}` : options.content;
  const owner = options.owner ?? client;
  const storageKey = `${owner.id}/2026/f${n}.pdf`;
  const invoice = await makeInvoice(owner, {
    storageKey,
    filename: `f${n}.pdf`,
    fileHash: options.hash === undefined ? (content == null ? null : sha256(content)) : options.hash,
    ...overrides,
  });
  if (content != null) {
    fakeS3().put(storageKey, content);
    contents.set(invoice.id, content);
  }
  await prisma.invoiceArchive.update({ where: { invoiceId: invoice.id }, data: { receivedAt: new Date(options.receivedAt) } });
  return invoice;
}

/** Nº de registro puesto a mano, en la serie del cliente, el tipo y el año de deducción. */
async function register(invoice: Invoice, number: number) {
  const year = invoice.accountingPeriodYear ?? invoice.periodYear;
  const series = await prisma.invoiceRegisterSeries.upsert({
    where: { clientId_type_year: { clientId: invoice.clientId, type: invoice.type, year } },
    create: { clientId: invoice.clientId, type: invoice.type, year, lastNumber: 100 },
    update: {},
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: { registerSeriesId: series.id, registerNumber: number, registeredAt: new Date("2026-04-02T10:00:00Z") },
  });
}

/** Un ejercicio 2026 con todo lo que importa, y una de 2025. */
async function seedYear() {
  const r1 = await stored({ periodMonth: 1, status: "EXPORTED", invoiceNumber: "F-R1" }, { receivedAt: "2026-01-10T09:00:00Z" });
  await register(r1, 1);
  // De diciembre de 2025 contabilizada en febrero de 2026: va en 2026.
  const r2 = await stored(
    { periodMonth: 12, periodYear: 2025, accountingPeriodMonth: 2, accountingPeriodYear: 2026, status: "EXPORTED", invoiceNumber: "F-R2" },
    { receivedAt: "2026-01-05T09:00:00Z" },
  );
  await register(r2, 2);
  const word = await stored({ periodMonth: 2, status: "EXPORTED", invoiceNumber: "F-W" }, { receivedAt: "2026-02-10T09:00:00Z" });
  await register(word, 3);
  const docx = strToU8("contenido del docx");
  const document = await prisma.document.create({
    data: {
      clientId: client.id, filename: "Factura W.docx", storageKey: `${client.id}/originales/w.docx`, fileType: DOCX,
      fileHash: sha256(docx), sizeBytes: docx.length,
    },
  });
  fakeS3().put(document.storageKey, Buffer.from(docx));
  await prisma.invoiceArchive.update({ where: { invoiceId: word.id }, data: { originalDocumentId: document.id } });
  const old = await stored({ periodMonth: 11, periodYear: 2025, status: "EXPORTED", invoiceNumber: "F-OLD" }, { receivedAt: "2025-11-10T09:00:00Z" });
  const pending = await stored({ periodMonth: 3, status: "PENDING_REVIEW", invoiceNumber: "F-P" }, { receivedAt: "2026-03-01T09:00:00Z" });
  const root = await stored({ periodMonth: 3, status: "SPLIT_SOURCE", invoiceNumber: null, filename: "tickets.pdf" }, { receivedAt: "2026-03-02T09:00:00Z" });
  const partA = await stored({ periodMonth: 3, status: "EXPORTED", splitFromId: root.id, invoiceNumber: "T-1" }, { receivedAt: "2026-03-02T09:00:00Z" });
  const partB = await stored({ periodMonth: 3, status: "PENDING_REVIEW", splitFromId: root.id, invoiceNumber: "T-2" }, { receivedAt: "2026-03-02T09:00:00Z" });
  await prisma.invoiceArchive.update({ where: { invoiceId: partA.id }, data: { splitPart: 1 } });
  await prisma.invoiceArchive.update({ where: { invoiceId: partB.id }, data: { splitPart: 2 } });
  await register(partA, 4);
  const missing = await stored({ periodMonth: 3, status: "VALIDATED", invoiceNumber: "F-M" }, { receivedAt: "2026-03-05T09:00:00Z", content: null });
  const badHash = await stored({ periodMonth: 3, status: "VALIDATED", invoiceNumber: "F-H" }, { receivedAt: "2026-03-06T09:00:00Z", hash: "0".repeat(64) });
  // Numerada al exportarla, corregida después (conserva su número) y rechazada.
  const rejected = await stored(
    { periodMonth: 3, status: "REJECTED", invoiceNumber: "F-X", rejectionReason: "Duplicada" },
    { receivedAt: "2026-03-07T09:00:00Z" },
  );
  await register(rejected, 5);
  const sale = await stored(
    { periodMonth: 3, type: "SALE", status: "EXPORTED", invoiceNumber: "V-1", receiverName: "Cliente final SA", receiverCif: "A11111111" },
    { receivedAt: "2026-03-08T09:00:00Z" },
  );
  await register(sale, 1);
  const q2 = await stored({ periodMonth: 5, status: "VALIDATED", invoiceNumber: "F-Q2" }, { receivedAt: "2026-05-02T09:00:00Z" });
  return { r1, r2, word, old, pending, root, partA, partB, missing, badHash, rejected, sale, q2 };
}

async function unzip(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/zip");
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  // Sin cellDates: xlsx pasaría las fechas a la zona del equipo.
  const book = files["indice.xlsx"] ? XLSX.read(files["indice.xlsx"]) : null;
  const sheet = (name: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(book!.Sheets[name]);
  return { names: Object.keys(files), files, text: (name: string) => strFromU8(files[name]), book, sheet };
}

const archiveExportTrail = () =>
  prisma.auditLog.findMany({ where: { field: "archiveExport" }, select: { invoiceId: true, userId: true, newValue: true } });

describe("el ZIP del ejercicio", () => {
  it("lleva el ejercicio pedido por periodo de deducción, en el orden del archivo, con el índice, el LEEME y los errores", async () => {
    const s = await seedYear();
    signInAs(w.admin);
    const res = await call(client.id, "?ejercicio=2026");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="archivo-${client.cif}-2026.zip"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const zip = await unzip(res);

    const wholeDocument = "recibidas/2026-03/R-2026-0004 T-1 Proveedor SL (documento entero).pdf";
    expect(zip.names).toEqual([
      "recibidas/2026-01/R-2026-0001 F-R1 Proveedor SL.pdf",
      "recibidas/2026-02/R-2026-0002 F-R2 Proveedor SL.pdf",
      "recibidas/2026-02/R-2026-0003 F-W Proveedor SL.docx",
      "recibidas/2026-02/R-2026-0003 F-W Proveedor SL (copia).pdf",
      `sin-registrar/2026-03/SR-${s.pending.id} F-P Proveedor SL.pdf`,
      wholeDocument,
      `sin-registrar/2026-03/SR-${s.badHash.id} F-H Proveedor SL.pdf`,
      "emitidas/2026-03/E-2026-0001 V-1 Cliente final SA.pdf",
      `sin-registrar/2026-05/SR-${s.q2.id} F-Q2 Proveedor SL.pdf`,
      "indice.xlsx",
      "LEEME.txt",
      "ERRORES.txt",
    ]);
    // El original de verdad: el Word con su copia, y de la división el documento entero (una vez).
    expect(zip.text("recibidas/2026-02/R-2026-0003 F-W Proveedor SL.docx")).toBe("contenido del docx");
    expect(zip.text(wholeDocument)).toBe(contents.get(s.root.id));
    expect(zip.names.some((name) => name.includes("F-OLD") || name.includes("F-X"))).toBe(false);

    // Solo lo que falla de verdad: ni las partes ni el Word.
    expect(zip.text("ERRORES.txt")).toBe(ERRORS_HEADER + [
      `sin-registrar/2026-03/SR-${s.missing.id} F-M Proveedor SL.pdf\tno está en el almacenamiento`,
      `sin-registrar/2026-03/SR-${s.badHash.id} F-H Proveedor SL.pdf\tla huella SHA-256 no coincide con la que se guardó al subirlo (guardada ${"0".repeat(64)}; la del fichero del ZIP es ${sha256(contents.get(s.badHash.id)!)})`,
    ].join("\r\n") + "\r\n");

    expect(zip.book!.SheetNames).toEqual(["Recibidas", "Emitidas", "Sin registrar"]);
    const [headers] = XLSX.utils.sheet_to_json<string[]>(zip.book!.Sheets.Recibidas, { header: 1 });
    expect(headers).toEqual([...ARCHIVE_INDEX_HEADERS]);
    // Una emitida no se recibe: se sube.
    const arrivalOf = (sheet: string) =>
      XLSX.utils.sheet_to_json<string[]>(zip.book!.Sheets[sheet], { header: 1 })[0][ARCHIVE_INDEX_HEADERS.indexOf("Recibida el")];
    expect(["Emitidas", "Sin registrar"].map(arrivalOf)).toEqual(["Subida el", "Recibida o subida el"]);
    const numbers = (name: string) => zip.sheet(name).map((row) => row["Nº de factura"]);
    expect(numbers("Recibidas")).toEqual(["F-R1", "F-R2", "F-W", "T-1"]);
    expect(numbers("Emitidas")).toEqual(["V-1"]);
    expect(numbers("Sin registrar")).toEqual(["F-P", "T-2", "F-M", "F-H", "F-Q2"]);
    const row = (name: string, number: string) => zip.sheet(name).find((r) => r["Nº de factura"] === number)!;
    expect(row("Recibidas", "F-R1")).toMatchObject({
      "Nº de registro": "R-2026/0001",
      Periodo: "Enero 2026",
      "Fichero en el ZIP": "recibidas/2026-01/R-2026-0001 F-R1 Proveedor SL.pdf",
      "SHA-256": sha256(contents.get(s.r1.id)!),
      Total: 121,
      "Recibida el": excelDay("2026-01-10"),
    });
    expect(row("Recibidas", "F-R2").Periodo).toBe("Febrero 2026");
    expect(row("Recibidas", "F-W")).toMatchObject({ Formato: "Word (.docx), con copia en PDF", "SHA-256": sha256(strToU8("contenido del docx")) });
    expect(row("Recibidas", "T-1").Avisos).toContain("Parte 1 de 2");
    expect(row("Sin registrar", "T-2")["Fichero en el ZIP"]).toBe(wholeDocument);
    // Las partes llevan la huella del documento entero, que es el que va en el ZIP.
    for (const part of [row("Recibidas", "T-1"), row("Sin registrar", "T-2")]) {
      expect(part["SHA-256"]).toBe(sha256(contents.get(s.root.id)!));
    }
    for (const ok of [row("Recibidas", "T-1"), row("Sin registrar", "T-2"), row("Recibidas", "F-W")]) {
      expect(String(ok.Avisos ?? "")).not.toMatch(/ERRORES\.txt/);
    }
    expect(row("Sin registrar", "F-M").Avisos).toContain("Falta el original: ver ERRORES.txt");
    expect(row("Sin registrar", "F-H").Avisos).toContain("El original no coincide con el que se subió");

    const readme = zip.text("LEEME.txt");
    expect(readme).toContain(`Archivo de facturas de ${client.name} (CIF ${client.cif})`);
    expect(readme).toContain("puede no coincidir con él");
    expect(readme).not.toMatch(/@/);

    // El rastro: una entrada por factura del ZIP, del administrador.
    const trail = await archiveExportTrail();
    expect(trail.map((t) => t.invoiceId).sort()).toEqual(
      [s.r1, s.r2, s.word, s.pending, s.partA, s.partB, s.missing, s.badHash, s.sale, s.q2].map((i) => i.id).sort(),
    );
    expect(new Set(trail.map((t) => `${t.userId}|${t.newValue}`))).toEqual(new Set([`${w.admin.id}|ZIP del ejercicio 2026`]));
  });

  it("otro ejercicio trae solo lo suyo: la de 2025 contabilizada en 2026 no está en 2025", async () => {
    const s = await seedYear();
    signInAs(w.admin);
    const zip = await unzip(await call(client.id, "?ejercicio=2025"));
    expect(zip.names).toEqual([`sin-registrar/2025-11/SR-${s.old.id} F-OLD Proveedor SL.pdf`, "indice.xlsx", "LEEME.txt"]);
  });

  it("dos facturas antiguas con la misma clave: cada una se compara con su huella y las dos llevan el aviso", async () => {
    // Se subieron con el mismo nombre en el mismo milisegundo (antes de
    // uploadStorageKey) y la segunda pisó a la primera en el almacenamiento.
    const key = `${client.id}/2026-04/1700000000000-Factura.pdf`;
    const first = await makeInvoice(client, { periodMonth: 4, invoiceDate: new Date("2026-04-15"), status: "VALIDATED", invoiceNumber: "A-1", storageKey: key, fileHash: sha256("contenido A") });
    const second = await makeInvoice(client, { periodMonth: 4, invoiceDate: new Date("2026-04-15"), status: "VALIDATED", invoiceNumber: "B-2", storageKey: key, fileHash: sha256("contenido B") });
    await prisma.invoiceArchive.update({ where: { invoiceId: first.id }, data: { receivedAt: new Date("2026-04-01T10:00:00Z") } });
    await prisma.invoiceArchive.update({ where: { invoiceId: second.id }, data: { receivedAt: new Date("2026-04-01T10:00:01Z") } });
    fakeS3().put(key, "contenido B");
    signInAs(w.admin);
    const zip = await unzip(await call(client.id, "?ejercicio=2026"));
    const path = `sin-registrar/2026-04/SR-${first.id} A-1 Proveedor SL.pdf`;
    expect(zip.names).toEqual([path, "indice.xlsx", "LEEME.txt", "ERRORES.txt"]);
    const shared = "El fichero guardado es el mismo que el de otra factura: ver ERRORES.txt";
    expect(zip.sheet("Sin registrar").map((r) => [r["Nº de factura"], r["Fichero en el ZIP"], r["SHA-256"], r.Avisos])).toEqual([
      ["A-1", path, sha256("contenido B"), `El original no coincide con el que se subió: ver ERRORES.txt; ${shared}`],
      ["B-2", path, sha256("contenido B"), shared],
    ]);
    expect(zip.text("ERRORES.txt")).toBe(ERRORS_HEADER + [
      `${path}\tes el mismo fichero guardado de varias facturas (nº A-1, nº B-2): se subieron con el mismo nombre y solo se conserva uno`,
      `${path}\tnº A-1: la huella SHA-256 no coincide con la que se guardó al subirlo (guardada ${sha256("contenido A")}; la del fichero del ZIP es ${sha256("contenido B")})`,
    ].join("\r\n") + "\r\n");
  });

  it("sin rechazadas salvo que se pidan; «solo registradas» deja fuera las que no tienen número y las rechazadas", async () => {
    const s = await seedYear();
    signInAs(w.admin);
    const withRejected = await unzip(await call(client.id, "?ejercicio=2026&rechazadas=1"));
    // Va a rechazadas/ aunque tenga nº de registro, con su número en el nombre.
    expect(withRejected.names).toContain("rechazadas/2026-03/R-2026-0005 F-X Proveedor SL.pdf");
    expect(withRejected.book!.SheetNames).toEqual(["Recibidas", "Emitidas", "Sin registrar", "Rechazadas"]);
    expect(withRejected.sheet("Rechazadas")).toEqual([
      expect.objectContaining({ "Nº de factura": "F-X", Estado: "Rechazada", Avisos: expect.stringContaining("Rechazada: Duplicada") }),
    ]);

    const registered = await unzip(await call(client.id, "?ejercicio=2026&solo=registradas&rechazadas=1"));
    expect(registered.names.filter((n) => !["indice.xlsx", "LEEME.txt"].includes(n))).toEqual([
      "recibidas/2026-01/R-2026-0001 F-R1 Proveedor SL.pdf",
      "recibidas/2026-02/R-2026-0002 F-R2 Proveedor SL.pdf",
      "recibidas/2026-02/R-2026-0003 F-W Proveedor SL.docx",
      "recibidas/2026-02/R-2026-0003 F-W Proveedor SL (copia).pdf",
      "recibidas/2026-03/R-2026-0004 T-1 Proveedor SL (documento entero).pdf",
      "emitidas/2026-03/E-2026-0001 V-1 Cliente final SA.pdf",
    ]);
    expect(registered.book!.SheetNames).toEqual(["Recibidas", "Emitidas"]);
    // La rechazada numerada no está en ninguna hoja.
    const indexed = registered.book!.SheetNames.flatMap((name) => registered.sheet(name).map((r) => r["Nº de factura"]));
    expect(indexed).toEqual(["F-R1", "F-R2", "F-W", "T-1", "V-1"]);
    expect(registered.text("LEEME.txt")).toContain("solo las facturas registradas");
    expect((await archiveExportTrail()).filter((t) => t.invoiceId === s.rejected.id).map((t) => t.newValue))
      .toEqual(["ZIP del ejercicio 2026, con las rechazadas"]);
  });

  it("por trimestres del ejercicio, también con un ejercicio de julio a junio", async () => {
    const s = await seedYear();
    signInAs(w.admin);
    const q2 = await unzip(await call(client.id, "?ejercicio=2026&trimestre=2"));
    expect(q2.names).toEqual([`sin-registrar/2026-05/SR-${s.q2.id} F-Q2 Proveedor SL.pdf`, "indice.xlsx", "LEEME.txt"]);

    const july = await prisma.client.create({
      data: { name: "Bodega Julio SL", cif: "B6" + String(Date.now()).slice(-7), advisoryFirmId: w.firm.id, fiscalYearStartMonth: 7 },
      select: { id: true, cif: true },
    });
    await stored({ periodMonth: 8, periodYear: 2025, invoiceNumber: "J-AGO" }, { receivedAt: "2025-08-03T09:00:00Z", owner: july });
    await stored({ periodMonth: 2, periodYear: 2026, invoiceNumber: "J-FEB" }, { receivedAt: "2026-02-03T09:00:00Z", owner: july });
    await stored({ periodMonth: 8, periodYear: 2026, invoiceNumber: "J-AGO2" }, { receivedAt: "2026-08-03T09:00:00Z", owner: july });
    const year = await call(july.id, "?ejercicio=2025");
    expect(year.headers.get("Content-Disposition")).toBe(`attachment; filename="archivo-${july.cif}-2025-26.zip"`);
    const yearZip = await unzip(year);
    expect(yearZip.sheet("Sin registrar").map((r) => r["Nº de factura"])).toEqual(["J-AGO", "J-FEB"]);
    const quarter = await call(july.id, "?ejercicio=2025&trimestre=3");
    expect(quarter.headers.get("Content-Disposition")).toBe(`attachment; filename="archivo-${july.cif}-2025-26-T3.zip"`);
    const quarterZip = await unzip(quarter);
    expect(quarterZip.sheet("Sin registrar").map((r) => r["Nº de factura"])).toEqual(["J-FEB"]);
    expect(quarterZip.text("LEEME.txt")).toContain("Ejercicio 2025-26 · T3 (Enero – Marzo 2026)");
  });

  it("el rastro archiveExport queda antes del primer byte", async () => {
    const s = await seedYear();
    signInAs(w.admin);
    fakeS3().setMode("hold");
    const res = await call(client.id, "?ejercicio=2026&solo=registradas");
    expect(res.status).toBe(200);
    // El ZIP está parado en el primer original y el rastro ya está.
    await expect.poll(() => fakeS3().heldGets()).toBeGreaterThan(0);
    expect((await archiveExportTrail()).map((t) => t.invoiceId).sort())
      .toEqual([s.r1, s.r2, s.word, s.partA, s.sale].map((i) => i.id).sort());
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    const zip = await unzip(res);
    expect(zip.names).toContain("LEEME.txt");
  });
});

describe("límites (los de la descarga de datos)", () => {
  it("por encima del nº de facturas: 413 que propone los trimestres, sin descarga ni rastro", async () => {
    await seedYear();
    CLIENT_EXPORT_LIMITS.maxInvoices = 3;
    signInAs(w.admin);
    const check = await call(client.id, "?ejercicio=2026&check=1");
    expect(check.status).toBe(413);
    expect((await check.json()).error).toBe(
      "El ejercicio 2026 tiene 10 facturas y se pueden descargar como mucho 3 de una vez. Descárgalo por trimestres.",
    );
    expect((await call(client.id, "?ejercicio=2026")).status).toBe(413);
    expect((await call(client.id, "?ejercicio=2026&trimestre=2&check=1")).status).toBe(200);
    expect(await archiveExportTrail()).toEqual([]);
  });

  it("los bytes suman cada fichero una vez: el Word y su copia, y el documento entero de una división, no sus partes (anexo C8)", async () => {
    const doc = (sizeBytes: number, name: string) => prisma.document.create({
      data: { clientId: client.id, filename: name, storageKey: `${client.id}/${name}`, fileType: "application/pdf", sizeBytes },
    });
    const withWord = await stored({ periodMonth: 2, invoiceNumber: "W", documentId: (await doc(500, "w.pdf")).id }, { receivedAt: "2026-02-01T09:00:00Z" });
    const word = await prisma.document.create({
      data: { clientId: client.id, filename: "w.docx", storageKey: `${client.id}/originales/w.docx`, fileType: DOCX, sizeBytes: 1_000 },
    });
    await prisma.invoiceArchive.update({ where: { invoiceId: withWord.id }, data: { originalDocumentId: word.id } });
    const root = await stored({ periodMonth: 2, status: "SPLIT_SOURCE", documentId: (await doc(2_000, "root.pdf")).id }, { receivedAt: "2026-02-02T09:00:00Z" });
    for (const name of ["p1.pdf", "p2.pdf"]) {
      await stored({ periodMonth: 2, splitFromId: root.id, documentId: (await doc(300, name)).id }, { receivedAt: "2026-02-02T09:00:00Z" });
    }
    signInAs(w.admin);
    CLIENT_EXPORT_LIMITS.maxBytes = 3_499;
    const over = await call(client.id, "?ejercicio=2026&check=1");
    expect(over.status).toBe(413);
    expect((await over.json()).error).toMatch(/^Los originales del ejercicio 2026 ocupan 3,4 KB .* Descárgalo por trimestres\.$/);
    CLIENT_EXPORT_LIMITS.maxBytes = 3_500;
    expect(await (await call(client.id, "?ejercicio=2026&check=1")).json()).toEqual({ ok: true, invoices: 3 });
  });
});

describe("acceso", () => {
  it("solo el administrador de la asesoría: el gestor 403, otra asesoría y el buzón 404, sin sesión 401", async () => {
    await seedYear();
    signInAs(w.worker);
    expect((await call(client.id, "?ejercicio=2026")).status).toBe(403);
    expect((await call(client.id, "?ejercicio=2026&check=1")).status).toBe(403);
    signInAs(w.clientUser);
    expect((await call(client.id, "?ejercicio=2026")).status).toBe(403);
    const b = await makeFirm("B");
    signInAs(b.admin);
    expect((await call(client.id, "?ejercicio=2026")).status).toBe(404);
    expect((await call(client.id, "?ejercicio=2026&check=1")).status).toBe(404);
    const inbox = await prisma.client.create({ data: { name: "Buzón", cif: "B44444444", advisoryFirmId: w.firm.id, isUnclassifiedBucket: true } });
    signInAs(w.admin);
    expect((await call(inbox.id, "?ejercicio=2026")).status).toBe(404);
    signOut();
    expect((await call(client.id, "?ejercicio=2026")).status).toBe(401);
    expect(await archiveExportTrail()).toEqual([]);
  });

  it("parámetros que no valen: 400 con el motivo; ?check=1 no deja rastro", async () => {
    await seedYear();
    signInAs(w.admin);
    for (const [query, error] of [
      ["", "Elige el ejercicio."],
      ["?ejercicio=dos-mil", "Elige el ejercicio."],
      ["?ejercicio=2026&trimestre=5", "El trimestre va del 1 al 4."],
      ["?ejercicio=2026&solo=todas", "Parámetros no válidos."],
    ]) {
      const res = await call(client.id, query);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect(await (await call(client.id, "?ejercicio=2026&check=1")).json()).toEqual({ ok: true, invoices: 10 });
    expect(await archiveExportTrail()).toEqual([]);
  });
});

describe("la ubicación del papel (entrega B)", () => {
  it("cada fila lleva su ubicación y el LEEME avisa de los tacos enteros sin dividir del ejercicio", async () => {
    const box = "Panadería López SL · 2026 · Caja 3";
    const taco = await makeTaco(w, { clientId: client.id, filed: { boxLabel: box }, period: { periodType: "MONTHLY", periodMonth: 3, periodYear: 2026 } });
    const paper = await stored({ periodMonth: 3, status: "VALIDATED", invoiceNumber: "F-PAPEL" }, { receivedAt: "2026-03-10T09:00:00Z" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: paper.id },
      data: { uploadBatchId: taco.id, uploadPosition: 2, originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" },
    });
    const held = await stored({ periodMonth: 3, status: "VALIDATED", invoiceNumber: "F-CLIENTE" }, { receivedAt: "2026-03-11T09:00:00Z" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: held.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual", paperHeldByClient: true },
    });
    await stored({ periodMonth: 3, status: "VALIDATED", invoiceNumber: "F-DUDA" }, { receivedAt: "2026-03-12T09:00:00Z" });
    // Sin dividir: el de abril de 2026 cuenta; el anulado y el de 2025, no.
    const pending = await makeTaco(w, { clientId: client.id, wholePdf: { pageCount: 30 }, period: { periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 } });
    await makeTaco(w, { clientId: client.id, wholePdf: { pageCount: 5 }, voided: { reason: "Subido por error" } });
    await makeTaco(w, { clientId: client.id, wholePdf: { pageCount: 5 }, period: { periodType: "MONTHLY", periodMonth: 11, periodYear: 2025 } });

    signInAs(w.admin);
    const zip = await unzip(await call(client.id, "?ejercicio=2026"));
    const location = (number: string) => zip.sheet("Sin registrar").find((r) => r["Nº de factura"] === number)!["Ubicación del papel"];
    expect(location("F-PAPEL")).toBe(`${box} · Taco ${taco.tacoNumber} · Pág. 2`);
    expect(location("F-CLIENTE")).toBe("Lo guarda el cliente");
    expect(location("F-DUDA")).toBe("Por confirmar");
    const [headers] = XLSX.utils.sheet_to_json<string[]>(zip.book!.Sheets["Sin registrar"], { header: 1 });
    expect(headers.indexOf("Ubicación del papel")).toBe(headers.indexOf("Original electrónico o en papel") + 1);

    const readme = zip.text("LEEME.txt");
    expect(readme).toContain("Ubicación del papel: dónde está el papel en la asesoría (caja, taco y página),");
    expect(readme).toContain(`Hay 1 taco entero sin dividir en este ejercicio (T${pending.tacoNumber}): sus facturas no están en el ZIP.`);
    // El de 2025 sale en el ZIP de 2025.
    const old = await unzip(await call(client.id, "?ejercicio=2025"));
    expect(old.text("LEEME.txt")).toMatch(/Hay 1 taco entero sin dividir en este ejercicio \(T\d+\)/);
    expect(old.text("LEEME.txt")).not.toContain(`T${pending.tacoNumber})`);
  });
});

// F-044 (sin borrar): todos los datos de un cliente en un ZIP.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { unzipSync, strFromU8 } from "fflate";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { appendAuditLogs } from "@/lib/auditLog";
import { CLIENT_EXPORT_LIMITS, writeClientDataZip } from "@/lib/clientDataExport";
import { GET as dataExport } from "@/app/api/admin/clients/[id]/data-export/route";

let w: FirmWorld;
beforeEach(async () => {
  w = await makeFirm("A");
  // Los originales de las dos facturas que deja makeFirm.
  for (const inv of Object.values(w.invoices)) fakeS3().put(inv.storageKey, `%PDF de ${inv.id}`);
});

const limits = { ...CLIENT_EXPORT_LIMITS };
afterEach(() => Object.assign(CLIENT_EXPORT_LIMITS, limits));

const call = (clientId: string, query = "") =>
  dataExport(new NextRequest(`http://x/api/admin/clients/${clientId}/data-export${query}`), { params: Promise.resolve({ id: clientId }) });

const unzip = async (res: Response) => {
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/zip");
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return { names: Object.keys(files).sort(), text: (name: string) => strFromU8(files[name]), bytes: (name: string) => files[name] };
};

describe("descargar los datos de un cliente (F-044)", () => {
  it("el ZIP tiene las facturas con sus líneas, los originales, la auditoría, los lotes y el LEEME", async () => {
    const inv = await makeInvoice(w.client, { storageKey: "k-zip-1", filename: "Factura: enero/1.pdf", status: "VALIDATED", periodMonth: 1, periodYear: 2026 });
    fakeS3().put("k-zip-1", "%PDF-1.4 original");
    await prisma.invoiceVatLine.createMany({ data: [
      { invoiceId: inv.id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 },
      { invoiceId: inv.id, position: 1, taxBase: 50, vatRate: 10, vatAmount: 5 },
    ] });
    await appendAuditLogs([{ invoiceId: inv.id, userId: w.worker.id, field: "status", oldValue: "PENDING_REVIEW", newValue: "VALIDATED" }]);
    const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id, clientId: w.client.id } });
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: inv.id, snapshot: JSON.stringify({ invoiceNumber: inv.invoiceNumber }) } });

    signInAs(w.admin);
    const zip = await unzip(await call(w.client.id));
    const original = `originales/2026-01/${inv.id}_Factura_ enero_1.pdf`;
    expect(zip.names).toEqual(expect.arrayContaining([
      "LEEME.txt", "facturas.json", "facturas.csv", "lineas_iva.csv", "auditoria.csv", "lotes_exportados.json", original,
    ]));
    expect(zip.names).not.toContain("ERRORES.txt");
    // Tres originales: el de este test y los dos de makeFirm.
    expect(zip.names.filter((n) => n.startsWith("originales/"))).toHaveLength(3);
    expect(zip.text(original)).toBe("%PDF-1.4 original");

    const invoices = JSON.parse(zip.text("facturas.json"));
    expect(invoices).toHaveLength(3);
    expect(invoices.find((i: { id: string }) => i.id === inv.id).vatLines.map((l: { taxBase: string }) => l.taxBase)).toEqual(["100", "50"]);
    expect(zip.text("facturas.csv").split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(zip.text("lineas_iva.csv")).toContain(`${inv.id};${inv.invoiceNumber};2;50;10;5;;`);

    // La auditoría incluye el rastro de esta misma descarga.
    const audit = zip.text("auditoria.csv");
    expect(audit).toContain("PENDING_REVIEW;VALIDATED");
    expect(audit.match(/;dataExport;/g)).toHaveLength(3);
    const trail = await prisma.auditLog.findMany({ where: { field: "dataExport" }, select: { userId: true, invoiceId: true } });
    expect(trail).toHaveLength(3);
    expect(new Set(trail.map((t) => t.userId))).toEqual(new Set([w.admin.id]));

    const batches = JSON.parse(zip.text("lotes_exportados.json"));
    expect(batches).toEqual([expect.objectContaining({ id: batch.id, formato: "a3excel", facturas: [{ id: inv.id, datosExportados: { invoiceNumber: inv.invoiceNumber } }] })]);
    expect(zip.text("LEEME.txt")).toContain(`Datos de ${w.client.name} (CIF ${w.client.cif})`);
  });

  it("un original que no está sale en ERRORES.txt y el resto se descarga", async () => {
    await makeInvoice(w.client, { storageKey: "k-no-esta", filename: "perdida.pdf" });
    signInAs(w.admin);
    const zip = await unzip(await call(w.client.id));
    expect(zip.text("ERRORES.txt")).toContain("perdida.pdf");
    expect(zip.names.filter((n) => n.startsWith("originales/"))).toHaveLength(2);
    expect(zip.text("LEEME.txt")).toContain("1 original no se pudo descargar");
  });

  it("un original que se para a mitad cierra su entrada, va a ERRORES.txt y el ZIP sigue siendo válido", async () => {
    CLIENT_EXPORT_LIMITS.fileTimeoutMs = 200;
    fakeS3().setMode("stall");
    signInAs(w.admin);
    try {
      const zip = await unzip(await call(w.client.id));
      expect(zip.text("ERRORES.txt").split("\r\n").filter((l) => l.startsWith("originales/"))).toHaveLength(2);
      expect(zip.names).toContain("LEEME.txt");
    } finally {
      fakeS3().clear();
    }
  }, 20_000);

  it("en streaming: cada trozo de un original sale antes de leer el siguiente", async () => {
    const events: string[] = [];
    async function* slowPdf() {
      for (let i = 0; i < 5; i++) {
        events.push(`lee ${i}`);
        yield new Uint8Array(64 * 1024).fill(i);
      }
    }
    const client = { id: w.client.id, name: w.client.name, cif: w.client.cif };
    let total = 0;
    await writeClientDataZip(client, "test", async (chunk) => {
      total += chunk.length;
      events.push("sale");
    }, async () => slowPdf());
    // Entre dos lecturas siempre ha salido algo: no se acumula el fichero.
    const reads = events.map((e, i) => (e.startsWith("lee") ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < reads.length; k++) expect(events.slice(reads[k - 1], reads[k])).toContain("sale");
    expect(total).toBeGreaterThan(2 * 5 * 64 * 1024);
  });

  it("un cliente sin facturas da un ZIP válido con el LEEME.txt", async () => {
    const empty = await prisma.client.create({ data: { name: "Vacío SL", cif: "B55555555", advisoryFirmId: w.firm.id } });
    signInAs(w.admin);
    const zip = await unzip(await call(empty.id));
    expect(zip.names).toContain("LEEME.txt");
    expect(JSON.parse(zip.text("facturas.json"))).toEqual([]);
    expect(zip.names.some((n) => n.startsWith("originales/"))).toBe(false);
  });

  it("el cliente de otra asesoría da 404, y un gestor no puede", async () => {
    const b = await makeFirm("B");
    signInAs(w.admin);
    expect((await call(b.client.id)).status).toBe(404);
    expect((await call(b.client.id, "?check=1")).status).toBe(404);
    signInAs(w.worker);
    expect((await call(w.client.id)).status).toBe(403);
    // Nada de rastro en la otra asesoría.
    expect(await prisma.auditLog.count({ where: { field: "dataExport" } })).toBe(0);
  });

  it("por encima del límite, un error claro y sin descarga ni rastro", async () => {
    CLIENT_EXPORT_LIMITS.maxInvoices = 1;
    signInAs(w.admin);
    const check = await call(w.client.id, "?check=1");
    expect(check.status).toBe(413);
    expect((await check.json()).error).toMatch(/tiene 2 facturas y se pueden descargar como mucho 1 de una vez/);
    expect((await call(w.client.id)).status).toBe(413);
    expect(await prisma.auditLog.count({ where: { field: "dataExport" } })).toBe(0);

  });

  it("los originales se suman por las facturas del cliente, también los subidos al buzón", async () => {
    CLIENT_EXPORT_LIMITS.maxBytes = 10;
    signInAs(w.admin);
    // Subidos en modo «clasificar»: el documento sigue con el cliente buzón.
    const inbox = await prisma.client.create({ data: { name: "Buzón", cif: "B44444444", advisoryFirmId: w.firm.id, isUnclassifiedBucket: true } });
    const doc = (sizeBytes: number | null) => prisma.document.create({
      data: { clientId: inbox.id, filename: "x.pdf", storageKey: `x${sizeBytes}`, fileType: "application/pdf", sizeBytes },
    });
    const [five, six] = [await doc(5), await doc(6)];
    await prisma.invoice.update({ where: { id: w.invoices.pending.id }, data: { documentId: five.id } });
    await prisma.invoice.update({ where: { id: w.invoices.validated.id }, data: { documentId: six.id } });
    expect((await (await call(w.client.id, "?check=1")).json()).error).toMatch(/ocupan 11 bytes y se pueden descargar como mucho 10 bytes/);

    // Sin tamaño guardado, o sin documento, cuenta como una subida del máximo (20 MB).
    CLIENT_EXPORT_LIMITS.maxBytes = 15 * 1024 ** 2;
    expect((await call(w.client.id, "?check=1")).status).toBe(200);
    await makeInvoice(w.client, { storageKey: "sin-documento" });
    expect((await (await call(w.client.id, "?check=1")).json()).error).toMatch(/ocupan 20 MB/);
    await prisma.invoice.update({ where: { id: w.invoices.pending.id }, data: { documentId: (await doc(null)).id } });
    expect((await (await call(w.client.id, "?check=1")).json()).error).toMatch(/ocupan 40 MB/);
  });

  it("si el ZIP fuera a pasar del tope de bytes (sin ZIP64), se corta y no sigue pidiendo originales", async () => {
    CLIENT_EXPORT_LIMITS.maxZipBytes = 100 * 1024;
    for (let i = 0; i < 10; i++) await makeInvoice(w.client, { storageKey: `grande-${i}` });
    let opened = 0;
    async function* big() {
      for (let i = 0; i < 4; i++) yield new Uint8Array(32 * 1024);
    }
    const client = { id: w.client.id, name: w.client.name, cif: w.client.cif };
    await expect(writeClientDataZip(client, "test", async () => {}, async () => {
      opened++;
      return big();
    })).rejects.toThrow(/El ZIP pasaría de 100 KB/);
    expect(opened).toBe(1);
  });

  it("con ?check=1 solo comprueba: ni ZIP ni rastro", async () => {
    signInAs(w.admin);
    const res = await call(w.client.id, "?check=1");
    expect(await res.json()).toEqual({ ok: true });
    expect(await prisma.auditLog.count({ where: { field: "dataExport" } })).toBe(0);
  });
});

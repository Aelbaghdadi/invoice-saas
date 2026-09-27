// F-008 (PR #4): el final del OCR no pisa lo que se hizo mientras analizaba.
// processInvoice real por el camino Facturae (sin proveedor de OCR), con un
// S3 que puede tardar o fallar a proposito.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { facturaeXml } from "./helpers/fixtures";
import { inFlight } from "./helpers/inflight";
import { processInvoice } from "@/lib/processInvoice";

let w: FirmWorld;
let id: string;

beforeEach(async () => {
  w = await makeFirm("A");
  fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif }));
  ({ id } = await makeInvoice(w.client, {
    filename: "f.xml", storageKey: "k-xml", fileType: "application/xml", status: "UPLOADED",
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
  }));
});

async function state() {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { vatLines: true } });
  return {
    status: inv.status,
    ocrAttempts: inv.ocrAttempts,
    invoiceNumber: inv.invoiceNumber,
    lines: inv.vatLines.length,
    issues: await prisma.invoiceIssue.count({ where: { invoiceId: id } }),
    extractions: await prisma.invoiceExtraction.count({ where: { invoiceId: id } }),
    history: (await prisma.invoiceStatusHistory.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "asc" } }))
      .map((h) => `${h.fromStatus}->${h.toStatus}`),
    audit: (await prisma.auditLog.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "asc" } }))
      .map((a) => `${a.field}:${a.oldValue}->${a.newValue}`),
  };
}

describe("valla del OCR (ocrAttempts)", () => {
  it("camino normal: escribe datos, líneas, extracción, historial y auditoría", async () => {
    await processInvoice(id, w.worker.id);
    const s = await state();
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(s.status);
    expect(s.invoiceNumber).toBe("F-XML-1");
    expect(s.lines).toBe(1);
    expect(s.extractions).toBe(1);
    expect(s.history).toEqual(["UPLOADED->ANALYZING", `ANALYZING->${s.status}`]);
    expect(s.audit).toEqual([`status:UPLOADED->${s.status}`]);
  });

  it("rechazada mientras analizaba: sigue rechazada, sin nada del OCR", async () => {
    fakeS3().setMode("hold");
    const run = inFlight(processInvoice(id, w.worker.id));
    // Reclamada y descargando el fichero: se rechaza en ese momento.
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    expect((await state()).status).toBe("ANALYZING");
    await prisma.invoice.updateMany({ where: { id }, data: { status: "REJECTED", rejectionReason: "Ilegible" } });
    fakeS3().releaseGets();
    await run;
    const s = await state();
    expect(s.status).toBe("REJECTED");
    expect(s.invoiceNumber).toBeNull();
    expect(s.lines).toBe(0);
    expect(s.issues).toBe(0);
    expect(s.extractions).toBe(0);
    expect(s.history).toEqual(["UPLOADED->ANALYZING"]);
    expect(s.audit).toEqual([]);
  });

  it("el error de una ejecución que ya no es la dueña no pasa a OCR_ERROR una rechazada", async () => {
    fakeS3().setMode("hold");
    const run = inFlight(processInvoice(id, w.worker.id));
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.invoice.updateMany({ where: { id }, data: { status: "REJECTED" } });
    // La descarga falla: el OCR va al catch. "down" antes de soltar, porque
    // el cliente de S3 reintenta los 500 y los reintentos no deben quedarse
    // retenidos.
    fakeS3().setMode("down");
    fakeS3().releaseGets({ fail: true });
    await run;
    const s = await state();
    expect(s.status).toBe("REJECTED");
    expect(s.history).toEqual(["UPLOADED->ANALYZING"]);
  });

  it("sin cruce, el error sí deja OCR_ERROR", async () => {
    fakeS3().setMode("down");
    await processInvoice(id, w.worker.id);
    expect((await state()).status).toBe("OCR_ERROR");
  });

  it("relanzada: la ejecución colgada no pisa a la nueva (ni su extracción)", async () => {
    fakeS3().setMode("hold");
    const colgada = inFlight(processInvoice(id, w.worker.id)); // ocrAttempts 1
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    // Lo que hace el cron: devolverla a UPLOADED y relanzar.
    await prisma.invoice.updateMany({ where: { id, status: "ANALYZING" }, data: { status: "UPLOADED" } });
    fakeS3().setMode("ok");
    await processInvoice(id, w.worker.id); // ocrAttempts 2, termina
    const trasLaNueva = await state();
    fakeS3().releaseGets(); // la colgada termina despues, con ocrAttempts 1
    await colgada;
    const s = await state();
    expect(s.ocrAttempts).toBe(2);
    expect(s).toEqual(trasLaNueva);
    expect(s.extractions).toBe(1);
    expect(s.audit).toHaveLength(1);
  });

  it("un dato del OCR que desborda la columna (P2020) acaba en ERR-OCR-002", async () => {
    fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif, taxRate: "1000.00" }));
    await processInvoice(id, w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.status).toBe("OCR_ERROR");
    expect(inv.lastOcrError).toMatch(/^\[ERR-OCR-002\]/);
  });
});

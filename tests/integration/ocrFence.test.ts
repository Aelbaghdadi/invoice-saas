// F-008 (PR #4): el final del OCR no pisa lo que se hizo mientras analizaba.
// processInvoice real por el camino Facturae (sin proveedor de OCR), con un
// S3 que puede tardar o fallar a proposito.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { facturaeXml, wait } from "./helpers/fixtures";
import { processInvoice } from "@/lib/processInvoice";

let w: FirmWorld;

beforeEach(async () => {
  w = await makeFirm("A");
  fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif }));
  await makeInvoice(w.client, {
    id: "inv1", filename: "f.xml", storageKey: "k-xml", fileType: "application/xml", status: "UPLOADED",
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
  });
});

async function state() {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: "inv1" }, include: { vatLines: true } });
  return {
    status: inv.status,
    ocrAttempts: inv.ocrAttempts,
    invoiceNumber: inv.invoiceNumber,
    lines: inv.vatLines.length,
    issues: await prisma.invoiceIssue.count({ where: { invoiceId: "inv1" } }),
    extractions: await prisma.invoiceExtraction.count({ where: { invoiceId: "inv1" } }),
    history: (await prisma.invoiceStatusHistory.findMany({ where: { invoiceId: "inv1" }, orderBy: { createdAt: "asc" } }))
      .map((h) => `${h.fromStatus}->${h.toStatus}`),
    audit: (await prisma.auditLog.findMany({ where: { invoiceId: "inv1" }, orderBy: { createdAt: "asc" } }))
      .map((a) => `${a.field}:${a.oldValue}->${a.newValue}`),
  };
}

describe("valla del OCR (ocrAttempts)", () => {
  it("camino normal: escribe datos, líneas, extracción, historial y auditoría", async () => {
    await processInvoice("inv1", w.worker.id);
    const s = await state();
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(s.status);
    expect(s.invoiceNumber).toBe("F-XML-1");
    expect(s.lines).toBe(1);
    expect(s.extractions).toBe(1);
    expect(s.history).toEqual(["UPLOADED->ANALYZING", `ANALYZING->${s.status}`]);
    expect(s.audit).toEqual([`status:UPLOADED->${s.status}`]);
  });

  it("rechazada mientras analizaba: sigue rechazada, sin nada del OCR", async () => {
    fakeS3().setMode("slow:1500");
    const run = processInvoice("inv1", w.worker.id);
    await wait(500);
    expect((await state()).status).toBe("ANALYZING");
    await prisma.invoice.updateMany({ where: { id: "inv1" }, data: { status: "REJECTED", rejectionReason: "Ilegible" } });
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
    fakeS3().setMode("slowdown:1500");
    const run = processInvoice("inv1", w.worker.id);
    await wait(500);
    await prisma.invoice.updateMany({ where: { id: "inv1" }, data: { status: "REJECTED" } });
    await run;
    const s = await state();
    expect(s.status).toBe("REJECTED");
    expect(s.history).toEqual(["UPLOADED->ANALYZING"]);
  });

  it("sin cruce, el error sí deja OCR_ERROR", async () => {
    fakeS3().setMode("slowdown:10");
    await processInvoice("inv1", w.worker.id);
    expect((await state()).status).toBe("OCR_ERROR");
  });

  it("relanzada: la ejecución colgada no pisa a la nueva (ni su extracción)", async () => {
    fakeS3().setMode("slow:2500");
    const colgada = processInvoice("inv1", w.worker.id); // ocrAttempts 1
    await wait(500);
    // Lo que hace el cron: devolverla a UPLOADED y relanzar.
    await prisma.invoice.updateMany({ where: { id: "inv1", status: "ANALYZING" }, data: { status: "UPLOADED" } });
    fakeS3().setMode("ok");
    await processInvoice("inv1", w.worker.id); // ocrAttempts 2, termina
    const trasLaNueva = await state();
    await colgada; // termina despues con ocrAttempts 1
    const s = await state();
    expect(s.ocrAttempts).toBe(2);
    expect(s).toEqual(trasLaNueva);
    expect(s.extractions).toBe(1);
    expect(s.audit).toHaveLength(1);
  });

  it("un dato del OCR que desborda la columna (P2020) acaba en ERR-OCR-002", async () => {
    fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif, taxRate: "1000.00" }));
    await processInvoice("inv1", w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: "inv1" } });
    expect(inv.status).toBe("OCR_ERROR");
    expect(inv.lastOcrError).toMatch(/^\[ERR-OCR-002\]/);
  });
});

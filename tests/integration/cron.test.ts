// Crons y facturas con el analisis parado (PR #4, F-007/F-008; PR #5, crons).
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { facturaeXml, utcMinutesAgoSql } from "./helpers/fixtures";
import { signInAs } from "./helpers/session";
import { GET as retryStuck, POST as retryStuckPost } from "@/app/api/cron/retry-stuck/route";
import { POST as closureReminders } from "@/app/api/cron/closure-reminders/route";
import { runAfterCallbacks } from "./helpers/after";
import { POST as processRoute } from "@/app/api/invoices/[id]/process/route";

let w: FirmWorld;
let id: string;

/** Una factura Facturae en S3, en `status`, con `ocrAttempts` y sin tocar desde hace `minutesAgo`. */
async function stuck(status: "ANALYZING" | "UPLOADED", ocrAttempts: number, minutesAgo: number) {
  ({ id } = await makeInvoice(w.client, {
    filename: "f.xml", storageKey: "k-xml", fileType: "application/xml", status, ocrAttempts,
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
  }));
  await prisma.$executeRawUnsafe(
    `UPDATE "Invoice" SET "updatedAt" = ${utcMinutesAgoSql(minutesAgo)}, "createdAt" = ${utcMinutesAgoSql(minutesAgo)} WHERE id = $1`,
    id,
  );
}

beforeEach(async () => {
  w = await makeFirm("A");
  fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif, buyerName: w.client.name }));
});

const inv = () => prisma.invoice.findUniqueOrThrow({ where: { id } });
const history = async () =>
  (await prisma.invoiceStatusHistory.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "asc" } }))
    .map((h) => `${h.fromStatus}->${h.toStatus}`);
const cronRequest = (secret = "cron-test") =>
  new Request("http://x/api/cron", { headers: { authorization: `Bearer ${secret}` } });
const cron = () => retryStuck(cronRequest());
const reprocess = () => {
  signInAs(w.admin);
  return processRoute(new NextRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id }) });
};

describe("crons: secreto y métodos", () => {
  it("sin el secreto, 401; con el secreto, GET y POST", async () => {
    expect((await retryStuck(cronRequest("otro"))).status).toBe(401);
    // Mismos caracteres que «Bearer cron-test» (16) pero más bytes: comparando
    // por caracteres, timingSafeEqual lanzaba y salía un 500.
    const accented = `Bearer ${"é".repeat(9)}`;
    expect(accented.length).toBe("Bearer cron-test".length);
    expect((await retryStuck(new Request("http://x/api/cron", { headers: { authorization: accented } }))).status).toBe(401);
    expect((await retryStuck(cronRequest())).status).toBe(200);
    expect((await retryStuckPost(new Request("http://x/api/cron", { method: "POST", headers: { authorization: "Bearer cron-test" } }))).status).toBe(200);
  });
});

describe("retry-stuck", () => {
  it("resetea y relanza solo las ANALYZING antiguas", async () => {
    await stuck("ANALYZING", 1, 10);
    const reciente = await makeInvoice(w.client, { status: "ANALYZING", ocrAttempts: 1 });
    const body = await (await cron()).json();
    expect(body.resetFromAnalyzing).toBe(1);
    expect((await inv()).status).not.toBe("ANALYZING");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: reciente.id } })).status).toBe("ANALYZING");
  });

  it("pasa a OCR_ERROR la que agotó los reintentos, con su historial y los análisis reales", async () => {
    await stuck("ANALYZING", 5, 10);
    const body = await (await cron()).json();
    const i = await inv();
    expect(body.exhausted).toBe(1);
    expect(i.status).toBe("OCR_ERROR");
    expect(i.lastOcrError).toBe("Se agotaron los reintentos del análisis");
    expect(await history()).toEqual(["ANALYZING->OCR_ERROR"]);
    const h = await prisma.invoiceStatusHistory.findFirstOrThrow({ where: { invoiceId: id } });
    expect(h.reason).toBe("Se agotaron los reintentos del análisis (5 análisis; ya no se reintenta sola: pulsa Reprocesar)");
  });

  it("no toca una que sigue analizando (updatedAt reciente)", async () => {
    await stuck("ANALYZING", 3, 1);
    await cron();
    expect((await inv()).status).toBe("ANALYZING");
    expect(await history()).toEqual([]);
  });

  it("relanza a nombre de un ADMIN de la asesoría si no hay documento, y se guarda el resultado", async () => {
    await stuck("UPLOADED", 0, 10);
    const body = await (await cron()).json();
    expect(body.retried).toBe(1);
    const i = await inv();
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(i.status);
    expect(i.invoiceNumber).toBe("F-XML-1");
    expect((await prisma.auditLog.findMany({ where: { invoiceId: id } })).map((a) => a.userId)).toEqual([w.admin.id]);
  });

  it("con documento, a nombre de quien lo subió", async () => {
    await stuck("UPLOADED", 0, 10);
    const doc = await prisma.document.create({
      data: { filename: "f.xml", storageKey: "k-xml", fileType: "application/xml", clientId: w.client.id, uploadedBy: w.worker.id },
    });
    await prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "documentId" = $1 WHERE id = $2`, doc.id, id);
    await cron();
    expect((await prisma.auditLog.findMany({ where: { invoiceId: id } })).map((a) => a.userId)).toEqual([w.worker.id]);
  });

  it("nunca atribuye el OCR a un ADMIN de otra asesoría; sin nadie, no la relanza", async () => {
    await makeUser((await prisma.advisoryFirm.create({ data: { name: "Otra", cif: "A99999999" } })).id, "ADMIN", "adminotra");
    await stuck("UPLOADED", 0, 10);
    await prisma.user.delete({ where: { id: w.admin.id } });
    const body = await (await cron()).json();
    expect(body.skippedNoActor).toBe(1);
    expect((await inv()).status).toBe("UPLOADED");
  });
});

describe("Reprocesar a mano una factura parada", () => {
  it("relanza una parada aunque haya agotado los intentos", async () => {
    await stuck("ANALYZING", 3, 10);
    const res = await reprocess();
    expect(res.status).toBe(200);
    // El análisis va en un after(): la respuesta sale con la factura en UPLOADED.
    expect((await res.json()).invoice.status).toBe("UPLOADED");
    await runAfterCallbacks();
    const i = await inv();
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(i.status);
    expect(i.ocrAttempts).toBe(4);
    expect((await history())[0]).toBe("ANALYZING->UPLOADED");
  });

  it("no toca una que sigue analizando", async () => {
    await stuck("ANALYZING", 1, 1);
    const res = await reprocess();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ya se está analizando");
    expect((await inv()).status).toBe("ANALYZING");
  });

  it("el admin de otra asesoría no la puede reprocesar", async () => {
    await stuck("ANALYZING", 3, 10);
    const b = await makeFirm("B");
    signInAs(b.admin);
    const res = await processRoute(new NextRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await inv()).status).toBe("ANALYZING");
  });
});

describe("closure-reminders", () => {
  it("cuenta los enviados y se salta los periodos cerrados", async () => {
    const b = await makeFirm("B");
    const now = new Date();
    const month = now.getMonth() === 0 ? 12 : now.getMonth();
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    await prisma.periodClosure.create({ data: { clientId: b.client.id, month, year, closedBy: b.admin.id } });
    const res = await closureReminders(new Request("http://x/api/cron", { method: "POST", headers: { authorization: "Bearer cron-test" } }));
    // Sin RESEND_API_KEY el envio cuenta como hecho: A recibe, B tiene el mes cerrado.
    expect(await res.json()).toEqual({ sent: 1, failed: 0, month, year });
  });
});

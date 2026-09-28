// F-040: menos correos. Una subida de 5 ficheros avisa una vez a los
// gestores; validar no manda nada al cliente hasta el cierre del periodo, y
// el cierre manda un resumen. Sin RESEND_API_KEY, cada correo deja una línea
// «[EMAIL-DEV] plantilla | To | Subject» en el log: es lo que se cuenta.
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { discardAfterCallbacks, runAfterCallbacks } from "./helpers/after";
import { reviewForm, validate, reject } from "./helpers/reviewForm";
import { POST as upload } from "@/app/api/uploads/route";
import { closePeriodFromBatch } from "@/app/dashboard/worker/batch/actions";
import { closePeriod } from "@/app/dashboard/admin/closures/actions";
import { flushUploadNotices } from "@/lib/uploadNotices";

let w: FirmWorld;
let log: MockInstance;
const emails = (template: string) => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`[EMAIL-DEV] ${template} `));

beforeEach(async () => {
  w = await makeFirm("A");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

const pdf = (n: number) => new File([`%PDF-1.4\n% factura ${n}\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n`], `f${n}.pdf`, { type: "application/pdf" });

describe("aviso de subida (F-040)", () => {
  it("5 ficheros del cliente: un solo aviso a su gestor, con las 5", async () => {
    signInAs(w.clientUser);
    for (let i = 0; i < 5; i++) {
      const form = new FormData();
      form.set("file", pdf(i));
      form.set("clientId", w.client.id);
      form.set("periodType", "MONTHLY");
      form.set("periodMonth", "4");
      form.set("periodYear", "2026");
      form.set("type", "PURCHASE");
      const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
      expect(res.status).toBe(200);
    }
    // El OCR de cada una va en su after(); aquí no hace falta.
    discardAfterCallbacks();
    expect(emails("nuevas-facturas-gestor")).toHaveLength(0);
    await flushUploadNotices();
    const sent = emails("nuevas-facturas-gestor");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("5 facturas nuevas");
  });
});

describe("validar y cerrar el periodo (F-040)", () => {
  it("validar 5 no manda nada; el cierre manda un resumen con las 5", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await makeInvoice(w.client, { status: "PENDING_REVIEW", periodMonth: 4, totalAmount: 121 + i, invoiceNumber: `V-${i}` })).id);
    signInAs(w.worker);
    for (const id of ids) {
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      const r = await validate(reviewForm(id, inv.updatedAt, w.client, { invoiceNumber: `V-${id}`, totalAmount: "121", accountingPeriodMonth: "4" }));
      if (r.error) throw new Error(JSON.stringify(r.error));
    }
    await runAfterCallbacks();
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith("[EMAIL-DEV]"))).toHaveLength(0);

    const form = new FormData();
    form.set("clientId", w.client.id);
    form.set("month", "4");
    form.set("year", "2026");
    form.set("type", "PURCHASE");
    expect(await closePeriodFromBatch({}, form)).toEqual({ ok: true });
    await runAfterCallbacks();
    const summary = emails("resumen-periodo");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("Resumen de Abril 2026: 5 validadas, 0 rechazadas");
  });

  it("el rechazo sigue siendo inmediato y sale en el resumen", async () => {
    const bad = await makeInvoice(w.client, { status: "PENDING_REVIEW", periodMonth: 4, invoiceNumber: "R-1" });
    signInAs(w.worker);
    expect(await reject(bad.id, "Ilegible")).toEqual({ error: null });
    await runAfterCallbacks();
    expect(emails("factura-rechazada")).toHaveLength(1);
    const form = new FormData();
    form.set("clientId", w.client.id);
    form.set("month", "4");
    form.set("year", "2026");
    form.set("type", "PURCHASE");
    expect(await closePeriodFromBatch({}, form)).toEqual({ ok: true });
    await runAfterCallbacks();
    expect(emails("resumen-periodo")[0]).toContain("0 validadas, 1 rechazada");
  });
});

describe("resumen de un cierre con una trimestral rechazada (revisión 1 del PR #14, punto 14)", () => {
  it("el cierre de julio llega como «Julio 2026», no como el T3", async () => {
    await makeInvoice(w.client, { status: "REJECTED", periodType: "QUARTERLY", periodMonth: 7, rejectionReason: "Subida por error" });
    await makeInvoice(w.client, { status: "VALIDATED", periodType: "MONTHLY", periodMonth: 7, totalAmount: 242 });
    signInAs(w.worker);
    const f = new FormData();
    f.set("clientId", w.client.id);
    f.set("month", "7");
    f.set("year", "2026");
    f.set("type", "PURCHASE");
    expect(await closePeriodFromBatch({}, f)).toEqual({ ok: true });
    await runAfterCallbacks();
    expect(emails("resumen-periodo")[0]).toContain("Resumen de Julio 2026: 1 validada, 1 rechazada");
  });
});

describe("cerrar desde Cierres (F-040)", () => {
  const form = (clientId: string) => {
    const f = new FormData();
    f.set("clientId", clientId);
    f.set("month", "4");
    f.set("year", "2026");
    return f;
  };

  it("el admin de otra asesoría no cierra el periodo ni manda el resumen", async () => {
    await makeInvoice(w.client, { status: "VALIDATED", periodMonth: 4 });
    const b = await makeFirm("B");
    signInAs(b.admin);
    expect(await closePeriod(form(w.client.id))).toEqual({ error: "Cliente no encontrado." });
    await runAfterCallbacks();
    expect(await prisma.periodClosure.count()).toBe(0);
    expect(emails("resumen-periodo")).toHaveLength(0);
  });

  it("el de su asesoría, sí, con el resumen", async () => {
    await makeInvoice(w.client, { status: "VALIDATED", periodMonth: 4 });
    signInAs(w.admin);
    expect(await closePeriod(form(w.client.id))).toEqual({ success: true });
    await runAfterCallbacks();
    expect(emails("resumen-periodo")).toHaveLength(1);
  });
});

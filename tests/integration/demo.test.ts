// «Reset demo»: solo en una asesoría marcada isDemo a mano (los triggers del
// archivo no dejan borrar facturas ni documentos de las demás), y las validadas
// de la demo tienen que poder exportarse (F-025: sin cuentas son bloqueantes).
import { afterEach, describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeTaco, makeTwoFirms, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { DEMO_RESET_NOT_ALLOWED, reseedDemo } from "@/lib/demoSeed";
import { isValidNIF } from "@/lib/validators";
import { validateForA3Export, type InvoiceWithClient } from "@/lib/exportFormats";
import { POST as resetDemoRoute } from "@/app/api/admin/reset-demo/route";

/** Lo que el reset borraría de una asesoría: filas, enlaces de recuperación de
 *  contraseña de sus usuarios y objetos del almacenamiento. */
async function firmFootprint(w: FirmWorld) {
  const where = { client: { advisoryFirmId: w.firm.id } };
  const users = await prisma.user.findMany({
    where: { OR: [{ advisoryFirmId: w.firm.id }, { clientProfile: { advisoryFirmId: w.firm.id } }] },
    orderBy: { id: "asc" },
  });
  return {
    clients: await prisma.client.findMany({ where: { advisoryFirmId: w.firm.id }, orderBy: { id: "asc" } }),
    users,
    tokens: await prisma.passwordResetToken.findMany({ where: { email: { in: users.map((u) => u.email) } }, orderBy: { id: "asc" } }),
    invoices: await prisma.invoice.findMany({ where, orderBy: { id: "asc" } }),
    archives: await prisma.invoiceArchive.findMany({ where: { invoice: where }, orderBy: { invoiceId: "asc" } }),
    documents: await prisma.document.findMany({ where, orderBy: { id: "asc" } }),
    batches: await prisma.uploadBatch.findMany({ where: { advisoryFirmId: w.firm.id }, orderBy: { id: "asc" } }),
    objects: fakeS3().keys().filter((k) => k.startsWith(`${w.client.id}/`)).sort(),
  };
}

/** Un documento, una tanda, un objeto en el almacenamiento y un enlace de
 *  recuperación de contraseña del gestor, además de las facturas de la factoría. */
async function withFiles(w: FirmWorld) {
  await prisma.document.create({
    data: { filename: "d.pdf", storageKey: `${w.client.id}/2026-09/d.pdf`, fileType: "application/pdf", clientId: w.client.id },
  });
  await prisma.uploadBatch.create({
    data: { advisoryFirmId: w.firm.id, clientId: w.client.id, createdById: w.worker.id, fileCount: 1, periodYear: 2026 },
  });
  fakeS3().put(`${w.client.id}/2026-09/d.pdf`, "%PDF de prueba");
  const worker = await prisma.user.findUniqueOrThrow({ where: { id: w.worker.id } });
  await prisma.passwordResetToken.create({
    data: { email: worker.email, token: `enlace-${worker.id}`, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
}

describe("Reset demo", () => {
  it("las validadas sembradas llevan cuentas y no tienen nada bloqueante para el export", async () => {
    const w = await makeFirm("A", { demo: true });
    const res = await reseedDemo(w.firm.id, w.admin.id);
    expect(res.ok).toBe(true);
    const validated = await prisma.invoice.findMany({
      where: { client: { advisoryFirmId: w.firm.id }, status: "VALIDATED" },
      include: { client: true, vatLines: { orderBy: { position: "asc" } } },
    });
    expect(validated.length).toBeGreaterThan(0);
    for (const inv of validated) {
      expect([inv.supplierAccount, inv.expenseAccount].every(Boolean)).toBe(true);
    }
    const blocked = validateForA3Export(validated as InvoiceWithClient[]).filter((r) => r.severity === "bloqueante");
    expect(blocked).toEqual([]);
  });

  it("todos los NIF sembrados son válidos (el de Repsol tenía mal el dígito de control)", async () => {
    const w = await makeFirm("A", { demo: true });
    expect((await reseedDemo(w.firm.id, w.admin.id)).ok).toBe(true);
    const invoices = await prisma.invoice.findMany({
      where: { client: { advisoryFirmId: w.firm.id } }, select: { issuerCif: true, receiverCif: true },
    });
    const entries = await prisma.accountEntry.findMany({ where: { client: { advisoryFirmId: w.firm.id } }, select: { nif: true } });
    const nifs = [...invoices.flatMap((i) => [i.issuerCif, i.receiverCif]), ...entries.map((e) => e.nif)].filter(Boolean) as string[];
    expect(nifs.length).toBeGreaterThan(0);
    expect(nifs.filter((n) => !isValidNIF(n))).toEqual([]);
  });

  it("con isDemo borra facturas, documentos, tandas, enlaces y ficheros de la demo, y la otra asesoría queda intacta", async () => {
    const demo = await makeFirm("A", { demo: true });
    const other = await makeFirm("B");
    await withFiles(demo);
    await withFiles(other);
    const otherBefore = await firmFootprint(other);
    const demoBefore = await firmFootprint(demo);
    const oldInvoiceIds = demoBefore.invoices.map((i) => i.id);
    expect(demoBefore.tokens).toHaveLength(1);
    expect(otherBefore.tokens).toHaveLength(1);

    const res = await reseedDemo(demo.firm.id, demo.admin.id);
    expect(res.ok).toBe(true);

    const after = await firmFootprint(demo);
    expect(after.clients.map((c) => c.id)).not.toContain(demo.client.id);
    expect(await prisma.invoice.count({ where: { id: { in: oldInvoiceIds } } })).toBe(0);
    expect(await prisma.invoiceArchive.count({ where: { invoiceId: { in: oldInvoiceIds } } })).toBe(0);
    expect(await prisma.document.count({ where: { clientId: demo.client.id } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { id: { in: demoBefore.tokens.map((t) => t.id) } } })).toBe(0);
    expect(after.batches).toEqual([]);
    expect(after.objects).toEqual([]);
    // Las sembradas tienen su fila de archivo (la crea el trigger), «Por
    // confirmar» y pendientes de la detección, como lo que había antes del archivo.
    expect(after.archives.map((a) => a.invoiceId).sort()).toEqual(after.invoices.map((i) => i.id).sort());
    expect(after.archives.length).toBeGreaterThan(0);
    expect(after.archives.map((a) => [a.originalMedium, a.originalMediumSource, a.originalMediumReason]))
      .toEqual(after.archives.map(() => [null, "AUTO", "backfill_pending"]));

    expect(await firmFootprint(other)).toEqual(otherBefore);
  });

  it("con un taco entero (tanda con su PDF) y uno de factura a factura, el reset lo borra todo y la otra asesoría queda igual", async () => {
    const demo = await makeFirm("A", { demo: true });
    const other = await makeFirm("B");
    for (const w of [demo, other]) {
      await withFiles(w);
      await makeTaco(w, { wholePdf: { pageCount: 7 } });
      const perInvoice = await makeTaco(w);
      await prisma.invoiceArchive.update({ where: { invoiceId: w.invoices.pending.id }, data: { uploadBatchId: perInvoice.id, uploadPosition: 1 } });
      await prisma.invoiceArchive.update({ where: { invoiceId: w.invoices.validated.id }, data: { paperBatchId: (await makeTaco(w, { origin: "ARCHIVE" })).id } });
    }
    const otherBefore = await firmFootprint(other);
    expect(otherBefore.batches.filter((batch) => batch.wholePdf)).toHaveLength(1);

    expect((await reseedDemo(demo.firm.id, demo.admin.id)).ok).toBe(true);

    const after = await firmFootprint(demo);
    expect(after.batches).toEqual([]);
    expect(await prisma.document.count({ where: { clientId: demo.client.id } })).toBe(0);
    expect(await firmFootprint(other)).toEqual(otherBefore);
  });

  it("sin isDemo devuelve ok:false y no borra ni filas ni objetos del almacenamiento", async () => {
    const { a, b } = await makeTwoFirms();
    await withFiles(a);
    await withFiles(b);
    const before = { a: await firmFootprint(a), b: await firmFootprint(b) };

    expect(await reseedDemo(a.firm.id, a.admin.id)).toEqual({ ok: false, error: DEMO_RESET_NOT_ALLOWED, reason: "not_demo" });

    expect({ a: await firmFootprint(a), b: await firmFootprint(b) }).toEqual(before);
    expect(before.a.objects).toEqual([`${a.client.id}/2026-09/d.pdf`]);
  });

  describe("POST /api/admin/reset-demo", () => {
    const previous = process.env.ALLOW_DEMO_RESET;
    afterEach(() => {
      if (previous === undefined) delete process.env.ALLOW_DEMO_RESET;
      else process.env.ALLOW_DEMO_RESET = previous;
    });

    const post = () => resetDemoRoute(new NextRequest("http://app.local/api/admin/reset-demo", {
      method: "POST",
      body: JSON.stringify({ confirm: "RESET" }),
      headers: { "Content-Type": "application/json" },
    }));

    it("responde 409 (no 500) si la asesoría no es de demostración, sin tocar nada", async () => {
      process.env.ALLOW_DEMO_RESET = "true";
      const w = await makeFirm("A");
      const before = await firmFootprint(w);
      signInAs(w.admin);
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: DEMO_RESET_NOT_ALLOWED });
      expect(await firmFootprint(w)).toEqual(before);
    });

    it("con isDemo responde 200", async () => {
      process.env.ALLOW_DEMO_RESET = "true";
      const w = await makeFirm("A", { demo: true });
      signInAs(w.admin);
      const res = await post();
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
  });
});

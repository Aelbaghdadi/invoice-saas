// Ficha de cliente: editar los datos (F-046, sin el acceso al portal) y las
// cifras y periodos que se enseñan. Otra asesoría no edita nada.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { updateClient } from "@/app/dashboard/admin/clients/[id]/actions";
import { loadClientSheet } from "@/lib/clientSheetData";
import { isValidNIF } from "@/lib/validators";

let a: FirmWorld;
let b: FirmWorld;

/** Un CIF con el digito de control bueno. */
function validCif(letter: string, digits: string): string {
  for (const control of "0123456789ABCDEFGHIJ") {
    if (isValidNIF(`${letter}${digits}${control}`)) return `${letter}${digits}${control}`;
  }
  throw new Error("sin digito de control");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const FULL = {
  name: "  Galma Skincare SL ",
  cif: validCif("B", "7654321").toLowerCase(),
  accountingProgram: "A3 Asesor",
  contactName: "Marta Pons",
  phone: "+34 612 34 56 78",
  notes: "Sube las facturas a final de mes.\r\nLas de Amazon van a la 629.",
};

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

describe("updateClient", () => {
  it("el administrador guarda la ficha: recortada, el CIF en mayúsculas y los saltos de línea normalizados", async () => {
    signInAs(a.admin);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } });
    expect(await updateClient(a.client.id, null, form(FULL))).toEqual({ success: true });
    const row = await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } });
    expect(row).toMatchObject({
      name: "Galma Skincare SL",
      cif: FULL.cif.toUpperCase(),
      accountingProgram: "A3 Asesor",
      contactName: "Marta Pons",
      phone: "+34 612 34 56 78",
      notes: "Sube las facturas a final de mes.\nLas de Amazon van a la 629.",
    });
    // El acceso al portal no se toca desde aqui.
    expect([row.email, row.userId]).toEqual([before.email, before.userId]);
  });

  it("lo que se deja vacío queda a null", async () => {
    signInAs(a.admin);
    await updateClient(a.client.id, null, form(FULL));
    expect(await updateClient(a.client.id, null, form({ ...FULL, accountingProgram: "", contactName: " ", phone: "", notes: "  \n " }))).toEqual({ success: true });
    const row = await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } });
    expect([row.accountingProgram, row.contactName, row.phone, row.notes]).toEqual([null, null, null, null]);
  });

  it("dice qué campo está mal y no cambia nada", async () => {
    signInAs(a.admin);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } });
    const res = await updateClient(a.client.id, null, form({ ...FULL, name: "G", cif: "B1234567X", phone: "llámame" }));
    expect(res?.errors).toMatchObject({
      name: [expect.stringMatching(/Mínimo 2/)],
      cif: [expect.stringMatching(/inválido/)],
      phone: [expect.stringMatching(/Solo números/)],
    });
    expect(await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } })).toEqual(before);
  });

  it("el CIF de otro cliente, aunque sea de otra asesoría, no se puede poner", async () => {
    // El de la factoria no lleva letra de control valida: se le pone uno real.
    const taken = validCif("B", "2222222");
    await prisma.client.update({ where: { id: b.client.id }, data: { cif: taken } });
    signInAs(a.admin);
    expect(await updateClient(a.client.id, null, form({ ...FULL, cif: taken }))).toEqual({ error: "Ya existe un cliente con ese CIF." });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } })).cif).toBe(a.client.cif);
  });

  it("otra asesoría, un gestor o el buzón «Sin clasificar»: nada", async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } });
    signInAs(b.admin);
    expect(await updateClient(a.client.id, null, form(FULL))).toEqual({ error: "Cliente no encontrado" });
    signInAs(a.worker);
    expect(await updateClient(a.client.id, null, form(FULL))).toEqual({ error: "No autorizado" });
    expect(await prisma.client.findUniqueOrThrow({ where: { id: a.client.id } })).toEqual(before);

    const bucket = await prisma.client.create({
      data: { name: "Sin clasificar", cif: validCif("B", "9999999"), advisoryFirmId: a.firm.id, isUnclassifiedBucket: true },
    });
    signInAs(a.admin);
    expect(await updateClient(bucket.id, null, form(FULL))).toEqual({ error: "Cliente no encontrado" });
    expect(await loadClientSheet(bucket.id)).toBeNull();
  });
});

describe("loadClientSheet", () => {
  it("las cifras y los periodos salen de las facturas del cliente, con el cierre y lo exportado", async () => {
    // makeFirm deja una por revisar y una validada en septiembre de 2026.
    await makeInvoice(a.client, { status: "REJECTED", periodMonth: 8, invoiceNumber: "F-ago" });
    await makeInvoice(a.client, { status: "SPLIT_SOURCE", periodMonth: 8, invoiceNumber: "F-split" });
    await makeInvoice(a.client, { status: "VALIDATED", periodMonth: 7, periodType: "QUARTERLY", type: "SALE", invoiceNumber: "F-t3" });
    await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 9, year: 2026, closedBy: a.admin.id } });
    // La validada de septiembre ya salio en un Excel.
    const batch = await prisma.exportBatch.create({ data: { format: "a3excel", clientId: a.client.id, periodMonth: 9, periodYear: 2026, invoiceCount: 1, userId: a.admin.id } });
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: a.invoices.validated.id, snapshot: "{}" } });
    await prisma.invoice.update({ where: { id: a.invoices.validated.id }, data: { exportBatchId: batch.id } });

    const data = (await loadClientSheet(a.client.id))!;
    expect(data.client).toMatchObject({ id: a.client.id, name: a.client.name, advisoryFirmId: a.firm.id });
    // Lista para exportar: la del T3 (validada y sin salir en ningun Excel).
    expect(data.stats).toEqual({ total: 4, pending: 1, needsAttention: 0, ocrError: 0, readyToExport: 1, exported: 1, rejected: 1, pct: 75 });
    expect(data.workers.map((w) => w.id)).toEqual([a.worker.id]);
    expect(data.groups).toEqual([]);
    expect(data.periods.map((p) => [p.label, p.purchases, p.sales, p.pending, p.validated, p.rejected, p.exported, p.closed])).toEqual([
      ["Septiembre 2026", 2, 0, 1, 1, 0, 1, true],
      ["Agosto 2026", 1, 0, 0, 0, 1, 0, false],
      ["T3 2026", 0, 1, 0, 1, 0, 0, false],
    ]);
  });
});

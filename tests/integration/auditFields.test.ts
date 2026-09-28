// F-024: la auditoria registra todo lo que se guarda en la revision, y guardar
// sin cambios no deja ninguna entrada.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm, settleAction } from "./helpers/reviewForm";
import { saveInvoiceFields } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
let id: string;
const row = () => prisma.invoice.findUniqueOrThrow({ where: { id } });
const save = async (extra: Record<string, string> = {}) =>
  settleAction(saveInvoiceFields(null, reviewForm(id, (await row()).updatedAt, w.client, extra)));
// Las entradas desde el primer guardado (la auditoria es inmutable: no se
// borran, se cuentan a partir de ahi).
let baseline = 0;
const allEntries = async () => (await prisma.auditLog.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "asc" } }))
  .map((e) => [e.field, e.oldValue, e.newValue]);
const entries = async () => (await allEntries()).slice(baseline);

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client));
  await prisma.invoiceVatLine.create({ data: { invoiceId: id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  signInAs(w.worker);
  // Primer guardado: lo que la pantalla fija al guardar (periodo contable,
  // estado…). A partir de aqui, cada test cambia una cosa.
  expect((await save()).error).toBeNull();
  baseline = (await allEntries()).length;
});

describe("auditoría completa al guardar (F-024)", () => {
  it("guardar sin cambios no deja ninguna entrada", async () => {
    expect((await save()).error).toBeNull();
    expect(await entries()).toEqual([]);
  });

  it.each([
    ["invoiceDate", { invoiceDate: "2026-09-11" }, "2026-09-10", "2026-09-11"],
    ["supplierAccount", { supplierAccount: "40000002" }, "40000001", "40000002"],
    ["expenseAccount", { expenseAccount: "62900000" }, "60000001", "62900000"],
    ["accountingPeriodMonth", { accountingPeriodMonth: "10" }, "9", "10"],
    ["accountingPeriodYear", { accountingPeriodYear: "2027" }, "2026", "2027"],
  ])("%s", async (field, extra, oldValue, newValue) => {
    expect((await save(extra)).error).toBeNull();
    expect(await entries()).toEqual([[field, oldValue, newValue]]);
  });

  it("retención: tipo y base (además del % y la cuota)", async () => {
    expect((await save({ retentionType: "PROFESSIONAL", retentionBase: "100", retentionRate: "15", retentionAmount: "15", totalAmount: "106" })).error).toBeNull();
    expect(await entries()).toEqual(expect.arrayContaining([
      ["retentionType", null, "PROFESSIONAL"],
      ["retentionBase", null, "100"],
    ]));
  });

  it("países del emisor y del receptor", async () => {
    expect((await save({ issuerCif: "DE123456789", operationType: "INTRACOM", vatLines: JSON.stringify([{ taxBase: "100", vatRate: "0", vatAmount: "0" }]), totalAmount: "100" })).error).toBeNull();
    expect(await entries()).toEqual(expect.arrayContaining([
      ["issuerCountry", null, "DE"],
      ["intracomGoodsType", null, "BIENES"],
    ]));
  });

  it("origen de bienes/servicios", async () => {
    const intracom = { issuerCif: "DE123456789", operationType: "INTRACOM", vatLines: JSON.stringify([{ taxBase: "100", vatRate: "0", vatAmount: "0" }]), totalAmount: "100" };
    expect((await save({ ...intracom, intracomGoodsSource: "IA" })).error).toBeNull();
    const before = (await entries()).length;
    expect((await save({ ...intracom, intracomGoodsSource: "MANUAL" })).error).toBeNull();
    expect((await entries()).slice(before)).toEqual([["intracomGoodsSource", "IA", "MANUAL"]]);
  });

  it("serie de la rectificada y art. 80.Tres", async () => {
    expect((await save({ isRectificative: "1", rectifiedInvoiceSeries: "A", rectifiedInvoiceNumber: "F-0", art80Tres: "1" })).error).toBeNull();
    expect(await entries()).toEqual(expect.arrayContaining([
      ["rectifiedInvoiceSeries", null, "A"],
      ["art80Tres", "false", "true"],
    ]));
  });
});

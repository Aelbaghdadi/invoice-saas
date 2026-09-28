// La incidencia del % aprendido que no es un tipo legal (F-073) se cierra al
// guardar con otro %, como las del signo; con el mismo, sigue abierta.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm, settleAction } from "./helpers/reviewForm";
import { saveInvoiceFields } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
let id: string;
const save = async (retention: Record<string, string>) => {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
  return settleAction(saveInvoiceFields(null, reviewForm(id, inv.updatedAt, w.client, {
    totalAmount: "108.5", ...retention,
  })));
};
const open = () => prisma.invoiceIssue.count({ where: { invoiceId: id, field: "irpfRate", status: "OPEN" } });

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client));
  await prisma.invoice.update({
    where: { id },
    data: { retentionType: "PROFESSIONAL", retentionBase: 100, irpfRate: 12.5, irpfAmount: 12.5, status: "NEEDS_ATTENTION" },
  });
  await prisma.invoiceVatLine.create({ data: { invoiceId: id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  await prisma.invoiceIssue.create({
    data: { invoiceId: id, type: "MANUAL", field: "irpfRate", description: "La retención aprendida del tercero (12,5 %) no es un tipo legal: revisa el % de la factura." },
  });
  signInAs(w.worker);
});

describe("incidencia del % aprendido no legal al guardar (F-073)", () => {
  it("con el mismo %, sigue abierta", async () => {
    expect(await save({ retentionType: "PROFESSIONAL", retentionBase: "100", retentionRate: "12.5", retentionAmount: "12.5" })).toEqual({ error: null });
    expect(await open()).toBe(1);
  });

  it("con otro %, se cierra", async () => {
    expect(await save({ retentionType: "PROFESSIONAL", retentionBase: "100", retentionRate: "15", retentionAmount: "15", totalAmount: "106" })).toEqual({ error: null });
    expect(await open()).toBe(0);
  });

  it("sin retención, se cierra", async () => {
    expect(await save({ totalAmount: "121" })).toEqual({ error: null });
    expect(await open()).toBe(0);
  });
});

// Reglas de validación en el servidor (paso 15: F-009, F-014, F-022, F-025,
// F-058), contra Postgres: lo que la acción rechaza no llega a la BD.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm, settleAction, validate } from "./helpers/reviewForm";
import { saveInvoiceFields } from "@/app/dashboard/worker/review/[id]/actions";
import { fakeS3 } from "./helpers/fakeS3";
import { facturaeXml } from "./helpers/fixtures";
import { processInvoice } from "@/lib/processInvoice";

let w: FirmWorld;
let id: string;
const row = () => prisma.invoice.findUniqueOrThrow({ where: { id }, include: { vatLines: true } });
const form = async (extra: Record<string, string>) => reviewForm(id, (await row()).updatedAt, w.client, extra);
const save = async (extra: Record<string, string>) => settleAction(saveInvoiceFields(null, await form(extra)));

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client));
  await prisma.invoiceVatLine.create({ data: { invoiceId: id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  signInAs(w.worker);
});

describe("líneas de IVA incompletas (F-014)", () => {
  // El caso de la auditoría: la segunda línea sin %; antes se guardaba solo
  // la primera y el total 176 quedaba descuadrado sin que nadie lo viera.
  const incompleta = {
    vatLines: JSON.stringify([
      { taxBase: "100", vatRate: "21", vatAmount: "21" },
      { taxBase: "50", vatRate: "", vatAmount: "5" },
    ]),
    totalAmount: "176",
  };
  const mensaje = "La línea 2 de IVA está incompleta: falta el % de IVA. Rellénala (0 si es exenta) o bórrala.";

  it.each([
    ["guardar", () => save(incompleta)],
    ["validar", async () => validate(await form(incompleta))],
  ])("%s: { error } con la línea que falta y la factura no cambia", async (_accion, act) => {
    const antes = await row();
    expect((await act()).error).toBe(mensaje);
    const despues = await row();
    expect(despues).toEqual(antes);
    expect(despues.vatLines).toHaveLength(1);
  });

  it("una exenta con solo la base tampoco se pierde", async () => {
    const r = await save({
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21" }, { taxBase: "50", vatRate: "", vatAmount: "" }]),
      totalAmount: "171",
    });
    expect(r.error).toBe("La línea 2 de IVA está incompleta: falta el % de IVA y la cuota. Rellénala (0 si es exenta) o bórrala.");
    expect((await row()).vatLines).toHaveLength(1);
  });

  it("completa con 0 % y cuota 0 sí se guarda, y la fila vacía se ignora", async () => {
    const r = await save({
      vatLines: JSON.stringify([
        { taxBase: "100", vatRate: "21", vatAmount: "21" },
        { taxBase: "50", vatRate: "0", vatAmount: "0" },
        { taxBase: "", vatRate: "", vatAmount: "" },
      ]),
      totalAmount: "171",
    });
    expect(r.error).toBeNull();
    const lines = (await row()).vatLines.sort((a, b) => a.position - b.position);
    expect(lines.map((l) => [Number(l.taxBase), Number(l.vatRate), Number(l.vatAmount)])).toEqual([[100, 21, 21], [50, 0, 0]]);
  });
});

describe("validar exige lo mínimo en el servidor (F-009)", () => {
  it.each([
    ["sin total", { totalAmount: "" }, "Falta el total de la factura."],
    ["sin fecha", { invoiceDate: "" }, "Falta la fecha de la factura."],
    ["sin número", { invoiceNumber: "" }, "Falta el número de factura."],
    ["sin líneas", { vatLines: "[]", totalAmount: "0" }, "Falta al menos una línea de IVA con base distinta de 0."],
    ["solo líneas a 0", { vatLines: JSON.stringify([{ taxBase: "0", vatRate: "21", vatAmount: "0" }]), totalAmount: "0" },
      "Falta al menos una línea de IVA con base distinta de 0."],
    ["descuadrada", { totalAmount: "121.01" }, "El importe no cuadra: las líneas suman 121,00 € y el total es 121,01 €."],
    ["sin NIF del proveedor", { issuerCif: "" },
      "Falta el NIF del proveedor. Si es un ticket o una factura simplificada, usa la cuenta genérica del cliente."],
    ["sin cuentas", { supplierAccount: "" }, "Faltan cuentas contables: rellénalas antes de validar."],
  ])("%s: { error } y sigue pendiente", async (_caso, extra, mensaje) => {
    const antes = await row();
    expect((await validate(await form(extra))).error).toBe(mensaje);
    expect(await row()).toEqual(antes);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("guardar sin validar no exige nada de eso", async () => {
    expect((await save({ totalAmount: "", invoiceNumber: "", issuerCif: "" })).error).toBeNull();
    const r = await row();
    expect(r.status).toBe("PENDING_REVIEW");
    expect(r.totalAmount).toBeNull();
  });

  it("tampoco se guarda así la corrección de una ya validada", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED" } });
    expect((await validate(await form({ totalAmount: "130" }))).error).toMatch(/^El importe no cuadra/);
    expect(Number((await row()).totalAmount)).toBe(121);
  });

  it("un ticket con la cuenta genérica se valida sin NIF", async () => {
    await prisma.client.update({ where: { id: w.client.id }, data: { simplifiedSupplierAccount: "40099999", simplifiedExpenseAccount: "62900000" } });
    const r = await validate(await form({ issuerCif: "", issuerName: "", supplierAccount: "40099999", expenseAccount: "62900000" }));
    expect(r.error).toBeNull();
    const after = await row();
    expect(after.status).toBe("VALIDATED");
    expect(after.issuerCif).toBeNull();
  });

  it("una rectificativa a cero se valida", async () => {
    const r = await validate(await form({
      isRectificative: "1", rectifiedInvoiceNumber: "F-0",
      vatLines: JSON.stringify([{ taxBase: "0", vatRate: "21", vatAmount: "0" }]), totalAmount: "0",
    }));
    expect(r.error).toBeNull();
    expect((await row()).status).toBe("VALIDATED");
  });

  it("una importación de un proveedor sin NIF español se valida", async () => {
    const r = await validate(await form({ issuerCif: "", operationType: "IMPORTACION" }));
    expect(r.error).toBeNull();
    expect((await row()).status).toBe("VALIDATED");
  });
});

describe("cuota = base × % por línea (F-022)", () => {
  it("el OCR la manda a «Requiere atención» con el aviso, aunque el total cuadre", async () => {
    // Facturae con 100 al 10 % y cuota 21: el total (121) cuadra.
    fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif, taxRate: "10.00" }));
    const { id: nueva } = await makeInvoice(w.client, {
      filename: "f.xml", storageKey: "k-xml", fileType: "application/xml", status: "UPLOADED",
      invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
      taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    });
    await processInvoice(nueva, w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: nueva }, include: { issues: true } });
    expect(inv.status).toBe("NEEDS_ATTENTION");
    expect(inv.issues.map((i) => [i.type, i.description])).toEqual([[
      "MATH_MISMATCH",
      "El desglose por tipo no cuadra. Línea 1: la cuota de IVA es 21,00 € y la base × 10 % da 10,00 €.",
    ]]);
  });

  it("es un aviso: se puede validar igual", async () => {
    const r = await validate(await form({
      vatLines: JSON.stringify([
        { taxBase: "100", vatRate: "21", vatAmount: "20" },
        { taxBase: "200", vatRate: "10", vatAmount: "21" },
      ]),
      totalAmount: "341",
    }));
    expect(r.error).toBeNull();
    expect((await row()).status).toBe("VALIDATED");
  });
});

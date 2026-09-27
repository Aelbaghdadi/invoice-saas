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
import { classifyInvoice } from "@/app/dashboard/worker/clasificar/actions";

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

  it("% de recargo sin cuota: { error } y no se guarda una cuota que el gestor no ha visto", async () => {
    const r = await save({
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21", equivalenceSurchargeRate: "5.2", equivalenceSurchargeAmount: "" }]),
      totalAmount: "121",
    });
    expect(r.error).toBe("La línea 1 de IVA está incompleta: tiene % de recargo de equivalencia pero falta su cuota.");
    const lines = (await row()).vatLines;
    expect(lines.map((l) => l.equivalenceSurchargeAmount)).toEqual([null]);
  });

  it.each([
    ["una base con 3 decimales", { vatLines: JSON.stringify([{ taxBase: "1.005", vatRate: "21", vatAmount: "0.21" }]), totalAmount: "1.21" },
      "La línea 1 de IVA tiene más de 2 decimales en la base. Redondéalo a céntimos."],
    ["un total con 3 decimales", { totalAmount: "121.005" }, "El total tiene más de 2 decimales. Redondéalo a céntimos."],
    ["un total «1e400»", { totalAmount: "1e400" }, "El total no es un número."],
    ["un total que no cabe en la BD", { totalAmount: "10000000000" }, "El total es demasiado grande."],
    ["un % de retención con 3 decimales",
      { retentionType: "PROFESSIONAL", retentionBase: "100", retentionRate: "15.555", retentionAmount: "15.56", totalAmount: "105.44" },
      "El % de retención tiene más de 2 decimales. Usa como máximo 2 decimales."],
  ])("%s: { error } en el límite y la factura no cambia", async (_caso, extra, mensaje) => {
    const antes = await row();
    expect((await validate(await form(extra))).error).toBe(mensaje);
    expect(await row()).toEqual(antes);
  });

  it("una línea con números sin comillas se guarda, no se descarta", async () => {
    const r = await save({ vatLines: JSON.stringify([{ taxBase: 100, vatRate: 21, vatAmount: 21 }, { taxBase: 50, vatRate: 10, vatAmount: 5 }]), totalAmount: "176" });
    expect(r.error).toBeNull();
    expect((await row()).vatLines).toHaveLength(2);
  });

  it("un recargo que no es un número: { error }, no se descarta sin avisar", async () => {
    const r = await save({
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21", equivalenceSurchargeRate: "5.2", equivalenceSurchargeAmount: "cinco" }]),
      totalAmount: "126.2",
    });
    expect(r.error).toBe("La línea 1 de IVA tiene un valor que no es un número en la cuota de recargo.");
  });

  it("cuota de recargo sin %: { error } (A3 recibiría 0 %)", async () => {
    const r = await save({
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21", equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "5.2" }]),
      totalAmount: "126.2",
    });
    expect(r.error).toBe("La línea 1 de IVA está incompleta: tiene cuota de recargo de equivalencia pero falta su %.");
    expect((await row()).vatLines.map((l) => l.equivalenceSurchargeAmount)).toEqual([null]);
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
      "Falta el NIF del proveedor. Si es un ticket o una factura simplificada, pide a un administrador que configure la cuenta genérica del cliente."],
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

  it.each(["VALIDATED", "EXPORTED"] as const)("guardar sin validar una %s tampoco se salta las reglas", async (status) => {
    await prisma.invoice.update({ where: { id }, data: { status } });
    const antes = await row();
    expect((await save({ totalAmount: "" })).error).toBe("Falta el total de la factura.");
    expect((await save({ totalAmount: "130" })).error).toMatch(/^El importe no cuadra/);
    expect(await row()).toEqual(antes);
  });

  it("una genérica antigua de 7 dígitos sigue valiendo con el campo completado a 8", async () => {
    await prisma.client.update({ where: { id: w.client.id }, data: { simplifiedSupplierAccount: "4009999", simplifiedExpenseAccount: "6290000" } });
    const r = await validate(await form({ issuerCif: "", issuerName: "", supplierAccount: "40099990", expenseAccount: "62900000" }));
    expect(r.error).toBeNull();
    expect((await row()).status).toBe("VALIDATED");
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

  describe("intracomunitarias: NIF-IVA obligatorio (decidido en el PR #7)", () => {
    const intracom = { operationType: "INTRACOM_SERVICIOS", vatLines: JSON.stringify([{ taxBase: "100", vatRate: "0", vatAmount: "0" }]), totalAmount: "100" };

    it.each([
      ["sin NIF", "", "Falta el NIF-IVA del proveedor: en una operación intracomunitaria hace falta para el modelo 349 y para A3."],
      ["con NIF sin prefijo", "515160873",
        "El NIF del proveedor no lleva el prefijo del país: en una operación intracomunitaria hace falta el NIF-IVA (p. ej. PT515160873)."],
    ])("%s: no se valida", async (_caso, issuerCif, mensaje) => {
      expect((await validate(await form({ ...intracom, issuerCif }))).error).toBe(mensaje);
      expect((await row()).status).toBe("PENDING_REVIEW");
    });

    it("con el NIF-IVA sí, y el país se guarda aparte", async () => {
      expect((await validate(await form({ ...intracom, issuerCif: "PT515160873" }))).error).toBeNull();
      const after = await row();
      expect(after.status).toBe("VALIDATED");
      expect([after.issuerCountry, after.issuerCif]).toEqual(["PT", "515160873"]);
    });
  });

  it("una venta nacional sin NIF del destinatario se valida (aviso, no bloqueo)", async () => {
    await prisma.invoice.update({ where: { id }, data: { type: "SALE" } });
    const r = await validate(await form({ type: "SALE", receiverCif: "", receiverName: "Consumidor final", supplierAccount: "43000001", expenseAccount: "70000001" }));
    expect(r.error).toBeNull();
    const after = await row();
    expect(after.status).toBe("VALIDATED");
    expect(after.receiverCif).toBeNull();
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
    expect(inv.issues.map((i) => [i.type, i.field, i.description])).toEqual([[
      "MATH_MISMATCH", "vatLines",
      "El desglose por tipo no cuadra. Línea 1: la cuota de IVA es 21,00 € y la base × 10 % da 10,00 €.",
    ]]);
  });

  it("un céntimo de descuadre en el OCR: «Requiere atención» con «Diferencia: 0,01 €»", async () => {
    fakeS3().put("k-cent", facturaeXml({ buyerCif: w.client.cif, total: "121.01" }));
    const { id: cent } = await makeInvoice(w.client, {
      filename: "cent.xml", storageKey: "k-cent", fileType: "application/xml", status: "UPLOADED",
      invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
      taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    });
    await processInvoice(cent, w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: cent }, include: { issues: true } });
    expect(inv.status).toBe("NEEDS_ATTENTION");
    expect(inv.issues.map((i) => i.description)).toEqual([
      "El total (121,01 €) no coincide con Base + IVA (121,00 €). Diferencia: 0,01 €.",
    ]);
  });

  it("importes con 3 decimales: el cuadre se mira con lo que se guarda (a céntimos)", async () => {
    // Sin redondear, 10,004 + 2,104 = 12,108 ≈ 12,11 y cuadraba; guardado a
    // céntimos es 10,00 + 2,10 = 12,10, que no cuadra con 12,11.
    fakeS3().put("k-3dec", facturaeXml({ buyerCif: w.client.cif, base: "10.004", taxAmount: "2.104", total: "12.11" }));
    const { id: dec } = await makeInvoice(w.client, {
      filename: "3dec.xml", storageKey: "k-3dec", fileType: "application/xml", status: "UPLOADED",
      invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
      taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    });
    await processInvoice(dec, w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: dec }, include: { issues: true, vatLines: true } });
    expect([Number(inv.vatLines[0].taxBase), Number(inv.vatLines[0].vatAmount), Number(inv.totalAmount)]).toEqual([10, 2.1, 12.11]);
    expect(inv.isValid).toBe(false);
    expect(inv.status).toBe("NEEDS_ATTENTION");
    expect(inv.issues.map((i) => i.description)).toContain("El total (12,11 €) no coincide con Base + IVA (12,10 €). Diferencia: 0,01 €.");
  });

  it("con el tipo aprendido del tercero: una inversión del sujeto pasivo con cuota 0 no es un desglose descuadrado", async () => {
    // El prefijo del NIF (B...) dice INTERIOR; lo aprendido, INVERSION_SP.
    await prisma.accountEntry.create({
      data: { clientId: w.client.id, nif: "B12345674", name: "Proveedor SL", defaultOperationType: "INVERSION_SP" },
    });
    fakeS3().put("k-isp", facturaeXml({ buyerCif: w.client.cif, taxRate: "21.00", taxAmount: "0.00", total: "100.00" }));
    const { id: isp } = await makeInvoice(w.client, {
      filename: "isp.xml", storageKey: "k-isp", fileType: "application/xml", status: "UPLOADED",
      invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
      taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    });
    await processInvoice(isp, w.worker.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: isp }, include: { issues: true } });
    expect(inv.operationType).toBe("INVERSION_SP");
    expect(inv.issues).toEqual([]);
    expect(inv.status).toBe("PENDING_REVIEW");
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

describe("moneda extranjera sin convertir (F-025)", () => {
  beforeEach(async () => {
    await prisma.invoice.update({ where: { id }, data: { currency: "USD" } });
  });

  it("no se valida", async () => {
    const r = await validate(await form({}));
    expect(r.error).toBe("Los importes están en USD: A3 solo admite euros. Conviértelos a euros y pulsa «Ya están en euros» antes de validar.");
    expect((await row()).status).toBe("PENDING_REVIEW");
  });

  it("con «Ya están en euros» sí, y queda en EUR", async () => {
    const r = await validate(await form({ currency: "EUR" }));
    expect(r.error).toBeNull();
    const after = await row();
    expect(after.status).toBe("VALIDATED");
    expect(after.currency).toBe("EUR");
  });
});

describe("«Por clasificar»: al clasificar se miran también el cuadre y el desglose", () => {
  async function routed(lines: [number, number, number][], total: number) {
    const inv = await makeInvoice(w.client, {
      status: "PENDING_ROUTING", routingCandidateIds: [w.client.id], totalAmount: total,
      taxBase: lines.reduce((s, l) => s + l[0], 0), vatAmount: lines.reduce((s, l) => s + l[2], 0),
    });
    for (const [i, [taxBase, vatRate, vatAmount]] of lines.entries()) {
      await prisma.invoiceVatLine.create({ data: { invoiceId: inv.id, position: i, taxBase, vatRate, vatAmount } });
    }
    return inv.id;
  }
  const issuesOf = async (invoiceId: string) =>
    (await prisma.invoiceIssue.findMany({ where: { invoiceId } })).map((i) => [i.type, i.description]);

  it("un céntimo de descuadre: «Requiere atención» con su incidencia", async () => {
    const inv = await routed([[100, 21, 21]], 121.01);
    expect(await classifyInvoice(inv, w.client.id)).toEqual({ ok: true });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("NEEDS_ATTENTION");
    expect(await issuesOf(inv)).toEqual([[
      "MATH_MISMATCH", "El total (121,01 €) no coincide con Base + IVA (121,00 €). Diferencia: 0,01 €.",
    ]]);
  });

  it("cuotas cruzadas con el total cuadrado: también", async () => {
    const inv = await routed([[100, 21, 20], [200, 10, 21]], 341);
    await classifyInvoice(inv, w.client.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("NEEDS_ATTENTION");
    expect((await issuesOf(inv)).map(([, d]) => d)).toEqual([expect.stringMatching(/^El desglose por tipo no cuadra\. Línea 1/)]);
  });

  it("con el tipo aprendido en el cliente elegido: una ISP con cuota 0 no es desglose descuadrado", async () => {
    await prisma.accountEntry.create({
      data: { clientId: w.client.id, nif: "B12345674", name: "Proveedor SL", defaultOperationType: "INVERSION_SP" },
    });
    const inv = await routed([[100, 21, 0]], 100);
    await classifyInvoice(inv, w.client.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv } });
    expect(after.operationType).toBe("INVERSION_SP");
    expect(after.status).toBe("PENDING_REVIEW");
    expect(await issuesOf(inv)).toEqual([]);
  });

  it("cuadrada: a revisión normal y sin incidencias", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    await classifyInvoice(inv, w.client.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_REVIEW");
    expect(await issuesOf(inv)).toEqual([]);
  });
});

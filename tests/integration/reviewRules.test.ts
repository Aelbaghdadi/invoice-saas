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
import { stubOcr } from "./helpers/ocr";
import { parseTaxId } from "@/lib/validators";
import { accountEntryKey } from "@/lib/supplierMatching";
import { processInvoice } from "@/lib/processInvoice";
import { detectIssues } from "@/lib/issueDetector";
import type { ExtractedInvoice } from "@/lib/ocr";
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

  it("guardar una VALIDATED tampoco se salta las demás comprobaciones de validar", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED" } });
    const antes = await row();
    // Emisor igual al cliente (ERR-VALIDATE-001).
    expect((await save({ issuerCif: w.client.cif })).error).toMatchObject({ code: "ERR-VALIDATE-001" });
    // Intracomunitaria de venta sin marcar bienes o servicios.
    await prisma.invoice.update({ where: { id }, data: { type: "SALE" } });
    const venta = { type: "SALE", receiverCif: "PT515160873", receiverName: "Cliente PT", operationType: "INTRACOM",
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "0", vatAmount: "0" }]), totalAmount: "100", intracomGoodsType: "" };
    expect((await save(venta)).error).toBe("Marca si la entrega intracomunitaria es de bienes o de servicios antes de validar.");
    expect((await row()).receiverCif).toBe(antes.receiverCif);
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

  it("una venta con las cuentas genéricas de proveedor (400/629) no se valida", async () => {
    await prisma.invoice.update({ where: { id }, data: { type: "SALE" } });
    const r = await validate(await form({ type: "SALE", receiverCif: "", supplierAccount: "40099999", expenseAccount: "62900000" }));
    expect(r.error).toBe("La cuenta 40099999 es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).");
    expect((await row()).status).toBe("PENDING_REVIEW");
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
      status: "PENDING_ROUTING", routingCandidateIds: [w.client.id], totalAmount: total, isValid: false,
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

  it("intracomunitaria con IVA declarado: el mismo aviso que en el OCR", async () => {
    await prisma.accountEntry.create({
      data: { clientId: w.client.id, nif: "B12345674", name: "Proveedor SL", defaultOperationType: "INTRACOM" },
    });
    const inv = await routed([[100, 21, 21]], 121);
    await classifyInvoice(inv, w.client.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv } });
    expect(after.operationType).toBe("INTRACOM");
    expect(after.status).toBe("NEEDS_ATTENTION");
    expect(await issuesOf(inv)).toEqual([[
      "MANUAL", "Operación intracomunitaria con IVA declarado (21%): las intracomunitarias suelen ir con IVA 0%. Revisa el desglose antes de exportar.",
    ]]);
  });

  it("servicios de la UE según la IA: el buzón lo guarda y al clasificar sale con el código de servicios", async () => {
    // Sin el CIF del cliente en la factura: queda «Por clasificar». El NIF
    // portugués viene sin prefijo, así que en el buzón es INTERIOR; el
    // cliente real ya lo tiene aprendido como intracomunitario. Lo que dijo
    // la IA tiene que llegar a la clasificación.
    const real = await prisma.client.create({
      data: { name: "Cliente Real SL", cif: "B87654321", email: "real@pruebas.es", advisoryFirmId: w.firm.id },
    });
    await prisma.workerClientAssignment.create({ data: { workerId: w.worker.id, clientId: real.id } });
    const nif = parseTaxId("515160873");
    await prisma.accountEntry.create({
      data: {
        clientId: real.id, nif: accountEntryKey(nif.clean, "Serviços Lda", nif.countryCode),
        name: "Serviços Lda", defaultOperationType: "INTRACOM",
      },
    });
    stubOcr(async () => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Serviços Lda", issuerCif: "515160873", receiverName: null, receiverCif: null,
        invoiceNumber: "PT-1", invoiceDate: "2026-09-10", taxBase: 100, vatRate: 0, vatAmount: 0,
        irpfRate: null, irpfAmount: null, totalAmount: 100, currency: "EUR", supplyType: "SERVICIOS",
        vatLines: [{ taxBase: 100, vatRate: 0, vatAmount: 0 }], confidence: null,
      } as ExtractedInvoice,
    }));
    fakeS3().put("k-ue", "%PDF-1.4");
    const { id: ue } = await makeInvoice(w.client, {
      filename: "ue.pdf", storageKey: "k-ue", fileType: "application/pdf", status: "UPLOADED",
      routingCandidateIds: [w.client.id, real.id], invoiceNumber: null, issuerCif: null, totalAmount: null,
    });
    await processInvoice(ue, w.worker.id);
    const routed = await prisma.invoice.findUniqueOrThrow({ where: { id: ue } });
    expect([routed.status, routed.operationType]).toEqual(["PENDING_ROUTING", "INTERIOR"]);
    expect([routed.intracomGoodsType, routed.intracomGoodsSource]).toEqual(["SERVICIOS", "IA"]);

    expect(await classifyInvoice(ue, real.id)).toEqual({ ok: true });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: ue } });
    expect([after.operationType, after.intracomGoodsType]).toEqual(["INTRACOM_SERVICIOS", "SERVICIOS"]);
  });

  it("cliente en recargo: se propone el recargo desde el total, como en el OCR", async () => {
    await prisma.client.update({ where: { id: w.client.id }, data: { equivalenceSurchargeCustomer: true } });
    const inv = await routed([[100, 21, 21]], 126.2);
    await classifyInvoice(inv, w.client.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv }, include: { vatLines: true } });
    expect(after.status).toBe("PENDING_REVIEW");
    expect(after.isValid).toBe(true);
    expect(await issuesOf(inv)).toEqual([]);
    expect(after.vatLines.map((l) => [Number(l.equivalenceSurchargeRate), Number(l.equivalenceSurchargeAmount)])).toEqual([[5.2, 5.2]]);
  });

  it("dos clasificaciones a la vez: solo una escribe incidencias, historial y auditoría", async () => {
    const inv = await routed([[100, 21, 21]], 121.01);
    const results = await Promise.all([classifyInvoice(inv, w.client.id), classifyInvoice(inv, w.client.id)]);
    expect(results.filter((r) => r?.ok)).toHaveLength(1);
    expect(results.filter((r) => r?.error)).toEqual([{ error: "La factura no está pendiente de clasificar" }]);
    expect(await issuesOf(inv)).toHaveLength(1);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: inv } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { invoiceId: inv, field: "status" } })).toBe(1);
  });

  it("cuadrada: a revisión normal y sin incidencias", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    await classifyInvoice(inv, w.client.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_REVIEW");
    expect(await issuesOf(inv)).toEqual([]);
  });
});

describe("duplicados en ventas (estrategia B): se compara el destinatario", () => {
  // detectIssues directo: el parser Facturae no lee la fecha de la fixture
  // (IssueDate va en InvoiceIssueData y lo busca en InvoiceHeader), y la
  // estrategia B necesita fecha.
  async function saleDuplicates(buyerCif: string) {
    const venta = await makeInvoice(w.client, { type: "SALE", issuerCif: w.client.cif, receiverCif: buyerCif, invoiceNumber: "V-2" });
    const extraction = {
      issuerCif: w.client.cif, receiverCif: buyerCif, invoiceNumber: "V-2", invoiceDate: "2026-09-10",
      taxBase: 100, vatAmount: 21, totalAmount: 121, irpfAmount: null, vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
      confidence: null,
    } as unknown as ExtractedInvoice;
    const issues = await detectIssues(venta.id, extraction, venta, "INTERIOR", { persist: false });
    return issues.filter((i) => i.type === "POSSIBLE_DUPLICATE").map((i) => i.description);
  }
  const existing = (receiverCif: string) => makeInvoice(w.client, {
    type: "SALE", issuerCif: w.client.cif, invoiceNumber: "V-1", invoiceDate: new Date("2026-09-10"), totalAmount: 121, receiverCif,
  });

  it("misma fecha e importe a otro cliente: no es un posible duplicado", async () => {
    await existing("B87654321");
    expect(await saleDuplicates("A58818501")).toEqual([]);
  });

  it("mismo destinatario, fecha e importe: sí", async () => {
    await existing("A58818501");
    expect(await saleDuplicates("A58818501")).toEqual([expect.stringContaining("mismo destinatario (A58818501)")]);
  });
});

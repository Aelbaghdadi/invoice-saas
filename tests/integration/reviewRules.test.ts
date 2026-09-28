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
import { NEGATIVE_AMOUNTS_HINT } from "@/lib/rectificative";
import { parseTaxId } from "@/lib/validators";
import { accountEntryKey } from "@/lib/supplierMatching";
import { processInvoice } from "@/lib/processInvoice";
import { detectIssues } from "@/lib/issueDetector";
import type { ExtractedInvoice } from "@/lib/ocr";
import { classifyInvoice } from "@/app/dashboard/worker/clasificar/actions";
import { NextRequest } from "next/server";
import { POST as exportDownload } from "@/app/api/export/route";

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
    // Facturae con 200 al 10 % y cuota 42: el total (242) cuadra. Otro total
    // que la factura del beforeEach: con la fecha leida seria un duplicado.
    fakeS3().put("k-xml", facturaeXml({ buyerCif: w.client.cif, base: "200.00", taxRate: "10.00", taxAmount: "42.00", total: "242.00" }));
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
      "El desglose por tipo no cuadra. Línea 1: la cuota de IVA es 42,00 € y la base × 10 % da 20,00 €.",
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

  // Un fallo real de la BD: un trigger que lanza al insertar en la tabla.
  async function failingInserts<T>(table: string, run: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fallo de prueba'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION test_fail()`);
    try {
      return await run();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER test_fail ON "${table}"`);
    }
  }

  it("si falla la transacción: { error } y la factura sigue por clasificar", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    const r = await failingInserts("InvoiceStatusHistory", () => classifyInvoice(inv, w.client.id));
    expect(r).toEqual({ error: "No se pudo clasificar la factura. Inténtalo de nuevo." });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_ROUTING");
  });

  it("si falla una lectura previa a la transacción: { error }, no lanza", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    // Un fallo real: la tabla de la ficha del tercero no está (se restaura).
    await prisma.$executeRawUnsafe(`ALTER TABLE "AccountEntry" RENAME TO "AccountEntry_fuera"`);
    let r;
    try {
      r = await classifyInvoice(inv, w.client.id);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "AccountEntry_fuera" RENAME TO "AccountEntry"`);
    }
    expect(r).toEqual({ error: "No se pudo clasificar la factura. Inténtalo de nuevo." });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_ROUTING");
  });

  it("si falla aprender el proveedor: la clasificación ya guardada vale", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    const r = await failingInserts("ProviderRoutingRule", () => classifyInvoice(inv, w.client.id));
    expect(r).toEqual({ ok: true });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_REVIEW");
  });

  it("con importes negativos: la incidencia del signo (F-012)", async () => {
    const inv = await routed([[-100, 21, -21]], -121);
    await classifyInvoice(inv, w.client.id);
    expect((await issuesOf(inv)).map(([, d]) => d)).toEqual([expect.stringMatching(/^La factura trae importes negativos/)]);
  });

  it("«FACTURA RECTIFICATIVA» leída en el buzón: la incidencia sale al clasificar (F-012)", async () => {
    stubOcr(async () => ({
      rawJson: JSON.stringify({ source: "gemini_text" }),
      rawText: "FACTURA RECTIFICATIVA Nº R-7 · Rectifica a la F-3",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: null, receiverCif: null,
        invoiceNumber: "R-7", invoiceDate: "2026-09-12", taxBase: 300, vatRate: 21, vatAmount: 63,
        irpfRate: null, irpfAmount: null, totalAmount: 363, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 300, vatRate: 21, vatAmount: 63 }], confidence: null,
      } as ExtractedInvoice,
    }));
    fakeS3().put("k-rect-buzon", "%PDF-1.4");
    const { id: inv } = await makeInvoice(w.client, {
      filename: "r.pdf", storageKey: "k-rect-buzon", fileType: "application/pdf", status: "UPLOADED",
      routingCandidateIds: [w.client.id], invoiceNumber: null, issuerCif: null, totalAmount: null,
    });
    await processInvoice(inv, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_ROUTING");
    expect(await classifyInvoice(inv, w.client.id)).toEqual({ ok: true });
    expect((await issuesOf(inv)).map(([, d]) => d)).toEqual([expect.stringMatching(/^Parece rectificativa: revisa el signo/)]);
  });

  it("cuadrada: a revisión normal y sin incidencias", async () => {
    const inv = await routed([[100, 21, 21]], 121);
    await classifyInvoice(inv, w.client.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_REVIEW");
    expect(await issuesOf(inv)).toEqual([]);
  });
});

describe("duplicados en ventas (estrategia B): se compara el destinatario", () => {
  // detectIssues directo, para controlar lo que se ha leido (la estrategia B
  // necesita fecha, importe y destinatario).
  async function saleDuplicates(
    buyerCif: string | null,
    read: { issuerCif?: string | null; invoiceNumber?: string | null; receiverName?: string | null } = {},
  ) {
    const venta = await makeInvoice(w.client, { type: "SALE", issuerCif: w.client.cif, receiverCif: buyerCif, invoiceNumber: "V-2" });
    const extraction = {
      issuerCif: w.client.cif, receiverCif: buyerCif, invoiceNumber: "V-2", invoiceDate: "2026-09-10",
      taxBase: 100, vatAmount: 21, totalAmount: 121, irpfAmount: null, vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
      confidence: null, receiverName: null, ...read,
    } as unknown as ExtractedInvoice;
    const issues = await detectIssues(venta.id, extraction, venta, "INTERIOR", { persist: false });
    return issues.filter((i) => i.type === "POSSIBLE_DUPLICATE").map((i) => i.description);
  }
  const existing = (receiverCif: string | null, receiverName: string | null = null) => makeInvoice(w.client, {
    type: "SALE", issuerCif: w.client.cif, invoiceNumber: "V-1", invoiceDate: new Date("2026-09-10"), totalAmount: 121, receiverCif, receiverName,
  });

  it("misma fecha e importe a otro cliente: no es un posible duplicado", async () => {
    await existing("B87654321");
    expect(await saleDuplicates("A58818501")).toEqual([]);
  });

  it("mismo destinatario, fecha e importe: sí", async () => {
    await existing("A58818501");
    expect(await saleDuplicates("A58818501")).toEqual([expect.stringContaining("mismo destinatario (A58818501)")]);
  });

  it("sin el CIF del emisor leído: se compara el destinatario igual", async () => {
    await existing("A58818501");
    expect(await saleDuplicates("A58818501", { issuerCif: null })).toEqual([expect.stringContaining("mismo destinatario (A58818501)")]);
  });

  it("tickets distintos sin NIF, número ni nombre, del mismo importe y día: ninguno es duplicado", async () => {
    for (let i = 0; i < 5; i++) await existing(null);
    expect(await saleDuplicates(null, { invoiceNumber: null })).toEqual([]);
  });

  it("el mismo fichero subido dos veces: duplicado por el hash, aunque no se lea nada", async () => {
    await makeInvoice(w.client, { type: "SALE", fileHash: "abc123", invoiceNumber: null, receiverCif: null });
    const venta = await makeInvoice(w.client, { type: "SALE", fileHash: "abc123", invoiceNumber: null, receiverCif: null });
    const issues = await detectIssues(venta.id, {
      issuerCif: null, receiverCif: null, invoiceNumber: null, invoiceDate: null, receiverName: null,
      taxBase: null, vatAmount: null, totalAmount: null, irpfAmount: null, vatLines: [], confidence: null,
    } as unknown as ExtractedInvoice, venta, "INTERIOR", { persist: false });
    expect(issues.filter((i) => i.type === "POSSIBLE_DUPLICATE").map((i) => i.description)).toEqual([
      expect.stringContaining("es el mismo fichero"),
    ]);
  });

  it("ticket sin NIF con el mismo nombre (normalizado): sí", async () => {
    await existing(null, "Juan García");
    expect(await saleDuplicates(null, { invoiceNumber: null, receiverName: "JUAN GARCIA" })).toEqual([
      expect.stringContaining("venta sin NIF al mismo destinatario (JUAN GARCIA), con el mismo total (121,00 €) y fecha"),
    ]);
  });

  it("ticket sin NIF con otro nombre: no", async () => {
    await existing(null, "Juan García");
    expect(await saleDuplicates(null, { invoiceNumber: null, receiverName: "Pedro López" })).toEqual([]);
  });

  it("venta sin NIF pero con número: no se compara por importe y fecha", async () => {
    await existing(null);
    expect(await saleDuplicates(null, { invoiceNumber: "V-2" })).toEqual([]);
  });
});

describe("OCR: los % también se redondean a 2 decimales", () => {
  it("retención al 7,005 %: se guarda 7,01 % y la cuota con ese %", async () => {
    stubOcr(async () => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Ana Pérez", issuerCif: "12345678Z", receiverName: w.client.name, receiverCif: w.client.cif,
        invoiceNumber: "AP-1", invoiceDate: "2026-09-10", taxBase: 1000, vatRate: 21.004, vatAmount: 210,
        irpfRate: 7.005, irpfAmount: 70.05, totalAmount: 1139.95, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 1000, vatRate: 21, vatAmount: 210 }], confidence: null,
      } as ExtractedInvoice,
    }));
    fakeS3().put("k-irpf", "%PDF-1.4");
    const { id: inv } = await makeInvoice(w.client, {
      filename: "irpf.pdf", storageKey: "k-irpf", fileType: "application/pdf", status: "UPLOADED",
      invoiceNumber: null, issuerCif: null, totalAmount: null, vatRate: null,
    });
    await processInvoice(inv, w.worker.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv } });
    expect([Number(after.irpfRate), Number(after.irpfAmount), Number(after.vatRate)]).toEqual([7.01, 70.1, 21]);
    // Con la cuota guardada (70,10) ya no cuadra con el total impreso: se dice,
    // en vez de quedar isValid=false sin ninguna incidencia.
    expect(after.isValid).toBe(false);
    expect(after.status).toBe("NEEDS_ATTENTION");
    const issues = await prisma.invoiceIssue.findMany({ where: { invoiceId: inv } });
    expect(issues.map((i) => i.description)).toEqual([expect.stringContaining("Diferencia: 0,05 €")]);
  });
});

describe("cuentas completadas en el servidor", () => {
  it("«4.1» y «6.22» sin salir del campo se guardan completadas", async () => {
    expect((await save({ supplierAccount: "4.1", expenseAccount: "6.22" })).error).toBeNull();
    const after = await row();
    expect([after.supplierAccount, after.expenseAccount]).toEqual(["40000001", "60000022"]);
  });

  it("una venta con «4.1» no pasa la regla del sentido", async () => {
    await prisma.invoice.update({ where: { id }, data: { type: "SALE" } });
    const r = await validate(await form({
      type: "SALE", receiverCif: "A58818501", receiverName: "Cliente SA", supplierAccount: "4.1", expenseAccount: "70000001",
    }));
    expect(r.error).toBe("La cuenta 40000001 es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).");
  });
});

describe("% fuera de 0-100: { error } y no ERR-SYS-001", () => {
  it("recargo al 1500 %", async () => {
    const r = await save({ vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21", equivalenceSurchargeRate: "1500", equivalenceSurchargeAmount: "1500" }]), totalAmount: "1621" });
    expect(r.error).toBe("La línea 1 de IVA tiene el % de recargo fuera de rango: tiene que estar entre 0 y 100.");
  });

  it("retención al 1500 %", async () => {
    const r = await save({ retentionType: "PROFESSIONAL", retentionBase: "100", retentionRate: "1500", retentionAmount: "1500", irpfAmount: "1500" });
    expect(r.error).toBe("El % de retención tiene que estar entre 0 y 100.");
  });
});

describe("cuentas sin punto: se guardan tal cual (no se rellenan por la derecha)", () => {
  const siete = { supplierAccount: "4000001", expenseAccount: "6000001" };

  it("validar con la sugerencia de la ficha sin tocarla no cambia la ficha", async () => {
    await prisma.accountEntry.create({ data: { clientId: w.client.id, nif: "B12345674", name: "Proveedor SL", ...siete } });
    expect((await validate(await form(siete))).error).toBeNull();
    const after = await row();
    expect([after.supplierAccount, after.expenseAccount]).toEqual(["4000001", "6000001"]);
    const entry = await prisma.accountEntry.findUniqueOrThrow({ where: { clientId_nif: { clientId: w.client.id, nif: "B12345674" } } });
    expect([entry.supplierAccount, entry.expenseAccount]).toEqual(["4000001", "6000001"]);
  });

  it("una exportada guardada sin cambios no vuelve a la cola", async () => {
    // Validada antes con cuentas de 7 dígitos, tal como están en la BD.
    await prisma.invoice.update({
      where: { id },
      data: {
        status: "VALIDATED", ...siete, invoiceNumber: "F-1", invoiceDate: new Date("2026-09-10"), issuerName: "Proveedor SL",
        issuerCif: "B12345674", taxBase: 100, vatRate: 21, vatAmount: 21, totalAmount: 121, accountingPeriodMonth: 9, accountingPeriodYear: 2026,
      },
    });
    signInAs(w.admin);
    const download = await exportDownload(new NextRequest("http://app.local/api/export", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
      body: JSON.stringify({ periodType: "MONTHLY", month: 9, year: 2026, type: "ALL", format: "a3excel", clientId: w.client.id }),
    }));
    expect(download.status).toBe(200);
    const exported = await row();
    expect(exported.exportBatchId).not.toBeNull();
    expect((await save(siete)).error).toBeNull();
    expect((await row()).exportBatchId).toBe(exported.exportBatchId);
  });

  it("la genérica de 7 dígitos se guarda tal cual", async () => {
    await prisma.client.update({ where: { id: w.client.id }, data: { simplifiedSupplierAccount: "4999999", simplifiedExpenseAccount: "6299999" } });
    expect((await save({ supplierAccount: "4999999", expenseAccount: "6299999" })).error).toBeNull();
    const after = await row();
    expect([after.supplierAccount, after.expenseAccount]).toEqual(["4999999", "6299999"]);
  });
});

describe("OCR: IRPF impreso en negativo", () => {
  it("«IRPF −15 %» se guarda en positivo y la factura no pasa a rectificativa", async () => {
    stubOcr(async () => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Ana Pérez", issuerCif: "12345678Z", receiverName: w.client.name, receiverCif: w.client.cif,
        invoiceNumber: "AP-2", invoiceDate: "2026-09-10", taxBase: 1000, vatRate: 21, vatAmount: 210,
        irpfRate: -15, irpfAmount: -150, totalAmount: 1060, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 1000, vatRate: 21, vatAmount: 210 }], confidence: null,
      } as ExtractedInvoice,
    }));
    fakeS3().put("k-irpf-neg", "%PDF-1.4");
    const { id: inv } = await makeInvoice(w.client, {
      filename: "irpf-neg.pdf", storageKey: "k-irpf-neg", fileType: "application/pdf", status: "UPLOADED",
      invoiceNumber: null, issuerCif: null, totalAmount: null, vatRate: null,
    });
    await processInvoice(inv, w.worker.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv } });
    expect([Number(after.irpfRate), Number(after.irpfAmount), Number(after.taxBase), Number(after.totalAmount)]).toEqual([15, 150, 1000, 1060]);
    expect(after.isValid).toBe(true);
    expect(after.status).toBe("PENDING_REVIEW");
  });
});

describe("OCR y rectificativas (F-012): no se cambian signos por el texto", () => {
  async function ocr(rawText: string, base: number, vat: number, total: number) {
    stubOcr(async () => ({
      rawJson: "{}",
      rawText,
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: w.client.name, receiverCif: w.client.cif,
        invoiceNumber: "R-1", invoiceDate: "2026-09-10", taxBase: base, vatRate: 21, vatAmount: vat,
        irpfRate: null, irpfAmount: null, totalAmount: total, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: base, vatRate: 21, vatAmount: vat }], confidence: null,
      } as ExtractedInvoice,
    }));
    fakeS3().put("k-rect", "%PDF-1.4");
    const { id: inv } = await makeInvoice(w.client, {
      filename: "rect.pdf", storageKey: "k-rect", fileType: "application/pdf", status: "UPLOADED",
      invoiceNumber: null, issuerCif: null, totalAmount: null, vatRate: null,
    });
    await processInvoice(inv, w.worker.id);
    return prisma.invoice.findUniqueOrThrow({ where: { id: inv }, include: { issues: true, vatLines: true } });
  }

  it("«FACTURA RECTIFICATIVA» en el texto: los importes quedan en positivo y sale la incidencia", async () => {
    const after = await ocr("FACTURA RECTIFICATIVA Nº R-1. Rectifica a la factura F-1.", 200, 42, 242);
    expect([Number(after.taxBase), Number(after.vatAmount), Number(after.totalAmount)]).toEqual([200, 42, 242]);
    expect(after.vatLines.map((l) => Number(l.taxBase))).toEqual([200]);
    expect(after.isRectificative).toBe(false);
    expect(after.status).toBe("NEEDS_ATTENTION");
    expect(after.issues.map((i) => i.description)).toEqual([expect.stringMatching(/^Parece rectificativa: revisa el signo\./)]);
  });

  it("importes negativos: se respetan y sale la incidencia de marcar la casilla", async () => {
    const after = await ocr("ABONO", -200, -42, -242);
    expect([Number(after.taxBase), Number(after.totalAmount)]).toEqual([-200, -242]);
    expect(after.issues.map((i) => i.description)).toEqual([expect.stringMatching(/^La factura trae importes negativos/)]);
  });

  it("«no es rectificativa» en el texto: sin incidencias", async () => {
    const after = await ocr("FACTURA Nº R-1. Esta factura no es rectificativa.", 200, 42, 242);
    expect(after.issues.map((i) => i.description)).toEqual([]);
  });

  it("una factura normal: sin incidencias", async () => {
    const after = await ocr("FACTURA Nº R-1. Forma de pago: abono en cuenta.", 200, 42, 242);
    expect(after.issues.map((i) => i.description)).toEqual([]);
    expect(after.status).toBe("PENDING_REVIEW");
  });
});

describe("rectificativa en la revisión: la inversión del signo se audita (F-012)", () => {
  const signAudit = () => prisma.auditLog.findMany({ where: { invoiceId: id, field: "rectificativeSign" } });

  it("marcada con todo en positivo: se guarda en negativo y queda en la auditoría", async () => {
    expect((await save({ isRectificative: "1", rectificativeType: "BY_DIFFERENCE" })).error).toBeNull();
    expect(Number((await row()).totalAmount)).toBe(-121);
    expect((await signAudit()).map((a) => a.newValue)).toEqual(["importes en negativo (marcada como rectificativa)"]);
  });

  it("marcada y ya en negativo, o sin marcar: no hay inversión", async () => {
    const negativos = { vatLines: JSON.stringify([{ taxBase: "-100", vatRate: "21", vatAmount: "-21" }]), totalAmount: "-121" };
    expect((await save({ ...negativos, isRectificative: "1", rectificativeType: "BY_DIFFERENCE" })).error).toBeNull();
    expect((await save({})).error).toBeNull();
    expect(await signAudit()).toEqual([]);
  });
});

describe("Facturae: un lote con varias facturas (revisión 1 del PR #9, punto 12)", () => {
  it("queda en Error OCR con el motivo, sin quedarse con la primera", async () => {
    const xml = facturaeXml({ buyerCif: w.client.cif });
    const invoice = xml.slice(xml.indexOf("<Invoice>"), xml.indexOf("</Invoice>") + "</Invoice>".length);
    fakeS3().put("k-lote", xml.replace(invoice, invoice + invoice));
    const { id: lote } = await makeInvoice(w.client, {
      filename: "lote.xml", storageKey: "k-lote", fileType: "application/xml", status: "UPLOADED",
      invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
      taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    });
    await processInvoice(lote, w.worker.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: lote } });
    expect(after.status).toBe("OCR_ERROR");
    expect(after.lastOcrError).toBe("[ERR-OCR-002] El XML trae 2 facturas (lote): súbelas por separado.");
  });
});

describe("Facturae rectificativa: la incidencia del signo (revisión 1 del PR #9, punto 15)", () => {
  const rectXml = () => facturaeXml({ buyerCif: w.client.cif, base: "300.00", taxAmount: "63.00", total: "363.00", number: "R-9" })
    .replace("<InvoiceNumber>R-9</InvoiceNumber>", "<InvoiceNumber>R-9</InvoiceNumber><InvoiceClass>OR</InvoiceClass>");
  const xmlInvoice = (key: string, extra = {}) => makeInvoice(w.client, {
    filename: "r.xml", storageKey: key, fileType: "application/xml", status: "UPLOADED",
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null, ...extra,
  });
  const issuesOf = async (invoiceId: string) => (await prisma.invoiceIssue.findMany({ where: { invoiceId } })).map((i) => i.description);

  it("al procesarla", async () => {
    fakeS3().put("k-rect-xml", rectXml());
    const { id: inv } = await xmlInvoice("k-rect-xml");
    await processInvoice(inv, w.worker.id);
    expect(await issuesOf(inv)).toEqual([expect.stringMatching(/^Parece rectificativa: revisa el signo/)]);
  });

  it("y si queda en el buzón, al clasificarla", async () => {
    fakeS3().put("k-rect-xml-buzon", rectXml().replace(`<TaxIdentificationNumber>${w.client.cif}</TaxIdentificationNumber>`, "<TaxIdentificationNumber>B99999999</TaxIdentificationNumber>"));
    const { id: inv } = await xmlInvoice("k-rect-xml-buzon", { routingCandidateIds: [w.client.id] });
    await processInvoice(inv, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status).toBe("PENDING_ROUTING");
    expect(await classifyInvoice(inv, w.client.id)).toEqual({ ok: true });
    expect(await issuesOf(inv)).toEqual([expect.stringMatching(/^Parece rectificativa: revisa el signo/)]);
  });
});

describe("incidencias del signo al guardar (revisión 2 del PR #9, punto 9)", () => {
  const issue = (description: string) => prisma.invoiceIssue.create({
    data: { invoiceId: id, type: "MANUAL", field: "isRectificative", description },
  });
  const statusOf = async (issueId: string) => (await prisma.invoiceIssue.findUniqueOrThrow({ where: { id: issueId } })).status;

  it("con la casilla marcada se cierran las dos", async () => {
    const mention = await issue("Parece rectificativa: revisa el signo.");
    const negative = await issue(NEGATIVE_AMOUNTS_HINT);
    expect((await save({ isRectificative: "1", rectificativeType: "BY_DIFFERENCE" })).error).toBeNull();
    expect([await statusOf(mention.id), await statusOf(negative.id)]).toEqual(["RESOLVED", "RESOLVED"]);
  });

  it("sin marcar: la de negativos se cierra si ya no quedan; la de la mención sigue", async () => {
    const mention = await issue("Parece rectificativa: revisa el signo.");
    const negative = await issue(NEGATIVE_AMOUNTS_HINT);
    expect((await save({})).error).toBeNull();
    expect([await statusOf(mention.id), await statusOf(negative.id)]).toEqual(["OPEN", "RESOLVED"]);
  });

  it("sin marcar y con negativos: sigue abierta", async () => {
    const negative = await issue(NEGATIVE_AMOUNTS_HINT);
    const negativos = { vatLines: JSON.stringify([{ taxBase: "-100", vatRate: "21", vatAmount: "-21" }]), totalAmount: "-121" };
    expect((await save(negativos)).error).toBeNull();
    expect(await statusOf(negative.id)).toBe("OPEN");
  });
});

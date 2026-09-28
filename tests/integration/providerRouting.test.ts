// Ruteo por proveedor (F-021): la regla aprendida y el texto solo deciden
// cuando no hay un CIF legible del lado del cliente; con uno valido que no
// casa, la factura va a «Por clasificar» (probablemente es de otro, F-019).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { fakeS3 } from "./helpers/fakeS3";
import { stubOcr } from "./helpers/ocr";
import { processInvoice } from "@/lib/processInvoice";
import { learnProviderRule } from "@/lib/providerRouting";
import { isValidNIF } from "@/lib/validators";
import type { ExtractedInvoice } from "@/lib/ocr";

/** Un CIF con el digito de control bueno. */
function validCif(letter: string, digits: string): string {
  for (const control of "0123456789ABCDEFGHIJ") {
    if (isValidNIF(`${letter}${digits}${control}`)) return `${letter}${digits}${control}`;
  }
  throw new Error("sin digito de control");
}

const PROVIDER = "B12345674";
let w: FirmWorld;
let a: { id: string; name: string; cif: string };
let b: { id: string; name: string; cif: string };

beforeEach(async () => {
  w = await makeFirm("A");
  a = await prisma.client.update({ where: { id: w.client.id }, data: { cif: validCif("B", "1111111") }, select: { id: true, name: true, cif: true } });
  b = await prisma.client.create({
    data: { name: "Empresa B SL", cif: validCif("B", "2222222"), email: "b@pruebas.es", advisoryFirmId: w.firm.id },
    select: { id: true, name: true, cif: true },
  });
  signInAs(w.worker);
});

/** Sube al buzon una compra del proveedor con lo que lea el OCR y la procesa.
 *  (Otro total que las facturas de makeFirm: si no, seria un posible duplicado.) */
async function upload(read: { receiverCif: string | null; issuerCif?: string; rawText?: string; typeUnconfirmed?: boolean }) {
  stubOcr(async () => ({
    rawJson: "{}",
    rawText: read.rawText,
    extracted: {
      issuerName: "Proveedor SL", issuerCif: read.issuerCif ?? PROVIDER, receiverName: null, receiverCif: read.receiverCif,
      invoiceNumber: `F-${Math.random()}`, invoiceDate: "2026-09-10", taxBase: 200, vatRate: 21, vatAmount: 42,
      irpfRate: null, irpfAmount: null, totalAmount: 242, currency: "EUR",
      vatLines: [{ taxBase: 200, vatRate: 21, vatAmount: 42 }], confidence: null,
    } as ExtractedInvoice,
  }));
  const key = `k-${Math.random()}`;
  fakeS3().put(key, "%PDF-1.4");
  const { id } = await makeInvoice(w.client, {
    filename: "f.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED",
    routingCandidateIds: [a.id, b.id], invoiceNumber: null, issuerCif: null, totalAmount: null,
    typeUnconfirmed: read.typeUnconfirmed ?? false,
  });
  await processInvoice(id, w.worker.id);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
  const audit = await prisma.auditLog.findMany({ where: { invoiceId: id, field: "auto:ruteo" } });
  const issues = await prisma.invoiceIssue.findMany({ where: { invoiceId: id } });
  return { status: inv.status, clientId: inv.clientId, type: inv.type, audit: audit.map((e) => [e.oldValue, e.newValue, e.userId]), issues: issues.map((i) => i.description) };
}

describe("regla del proveedor al subir al buzón (F-021)", () => {
  beforeEach(async () => {
    await learnProviderRule(w.firm.id, PROVIDER, b.id);
  });

  it("sin CIF del receptor: la regla enruta y queda auto:ruteo", async () => {
    const r = await upload({ receiverCif: null });
    expect([r.status, r.clientId]).toEqual(["PENDING_REVIEW", b.id]);
    expect(r.audit).toEqual([[null, `Empresa B SL (${b.cif}) · proveedor ${PROVIDER}`, w.worker.id]]);
  });

  it("un proveedor extranjero conserva el país en auto:ruteo", async () => {
    await learnProviderRule(w.firm.id, "PT515160873", b.id);
    const r = await upload({ receiverCif: null, issuerCif: "PT515160873" });
    expect(r.clientId).toBe(b.id);
    expect(r.audit).toEqual([[null, `Empresa B SL (${b.cif}) · proveedor PT515160873`, w.worker.id]]);
  });

  it("con un CIF de receptor válido que no casa: la regla no se aplica", async () => {
    const r = await upload({ receiverCif: validCif("B", "3333333") });
    expect([r.status, r.clientId]).toEqual(["PENDING_ROUTING", w.client.id]);
    expect(r.audit).toEqual([]);
  });

  it("con varias empresas del grupo en el texto: al buzón, sin consultar la regla", async () => {
    const r = await upload({ receiverCif: null, rawText: `Pedido conjunto ${a.cif} y ${b.cif}\\nTotal 242` });
    expect([r.status, r.clientId]).toEqual(["PENDING_ROUTING", w.client.id]);
    expect(r.audit).toEqual([]);
  });

  it("primero el texto: el CIF de A en el PDF gana a la regla que dice B", async () => {
    const r = await upload({ receiverCif: null, rawText: `Factura\\nCliente: ${a.cif}\\nTotal 242` });
    expect([r.status, r.clientId]).toEqual(["PENDING_REVIEW", a.id]);
    expect(r.audit).toEqual([]);
  });
});

describe("factura entre empresas del grupo", () => {
  it("regla A → B y factura de A sin el CIF del receptor: el texto no la manda a A", async () => {
    await learnProviderRule(w.firm.id, a.cif, b.id);
    const r = await upload({ issuerCif: a.cif, receiverCif: null, rawText: `Empresa A\\nCIF ${a.cif}\\nTotal 242` });
    expect([r.status, r.clientId]).toEqual(["PENDING_REVIEW", b.id]);
    expect(r.audit).toHaveLength(1);
  });
});

describe("«Detectar automáticamente» (tipo sin confirmar)", () => {
  it("una venta de A a un cliente con CIF válido: se enruta a A como venta", async () => {
    const r = await upload({ issuerCif: a.cif, receiverCif: validCif("B", "3333333"), typeUnconfirmed: true });
    expect([r.status, r.clientId, r.type]).toEqual(["PENDING_REVIEW", a.id, "SALE"]);
  });

  it("con el tipo confirmado, un receptor que no casa sigue yendo al buzón", async () => {
    const r = await upload({ issuerCif: a.cif, receiverCif: validCif("B", "3333333") });
    expect([r.status, r.clientId]).toEqual(["PENDING_ROUTING", w.client.id]);
  });
});

describe("learnProviderRule", () => {
  const rule = () => prisma.providerRoutingRule.findUniqueOrThrow({
    where: { advisoryFirmId_providerNif: { advisoryFirmId: w.firm.id, providerNif: PROVIDER } },
  });

  it("una regla ambigua sigue ambigua aunque se vuelva a confirmar", async () => {
    await learnProviderRule(w.firm.id, PROVIDER, a.id);
    await learnProviderRule(w.firm.id, PROVIDER, b.id);
    expect((await rule()).ambiguous).toBe(true);
    await learnProviderRule(w.firm.id, PROVIDER, b.id);
    expect((await rule()).ambiguous).toBe(true);
  });

  it("dos gestores a la vez con un proveedor nuevo: no falla y queda una regla", async () => {
    await Promise.all([learnProviderRule(w.firm.id, PROVIDER, a.id), learnProviderRule(w.firm.id, PROVIDER, a.id)]);
    const r = await rule();
    expect([r.clientId, r.hitCount, r.ambiguous]).toEqual([a.id, 2, false]);
  });
});

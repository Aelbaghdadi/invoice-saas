// Factura a nombre de otro (F-019): en el lado del cliente el OCR lee un CIF
// valido que no es el suyo. Los datos se sustituyen igual, pero queda una
// incidencia: una factura a nombre del DNI del socio se exportaba con IVA
// deducible.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { fakeS3 } from "./helpers/fakeS3";
import { stubOcr } from "./helpers/ocr";
import { processInvoice } from "@/lib/processInvoice";
import { classifyInvoice } from "@/app/dashboard/worker/clasificar/actions";
import { saveInvoiceFields } from "@/app/dashboard/worker/review/[id]/actions";
import { reviewForm, settleAction } from "./helpers/reviewForm";
import type { ExtractedInvoice } from "@/lib/ocr";

const CLIENT_CIF = "B87654321";
let w: FirmWorld;

beforeEach(async () => {
  w = await makeFirm("A");
  await prisma.client.update({ where: { id: w.client.id }, data: { cif: CLIENT_CIF, name: "Cliente A SL" } });
  signInAs(w.worker);
});

/** Procesa una factura con lo que lea el OCR; devuelve estado e incidencias. */
async function read(type: "PURCHASE" | "SALE", extracted: Partial<ExtractedInvoice>, routing = false, typeUnconfirmed = false) {
  stubOcr(async () => ({
    rawJson: "{}",
    extracted: {
      issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: "Cliente A SL", receiverCif: CLIENT_CIF,
      invoiceNumber: "X-1", invoiceDate: "2026-09-10", taxBase: 300, vatRate: 21, vatAmount: 63,
      irpfRate: null, irpfAmount: null, totalAmount: 363, currency: "EUR",
      vatLines: [{ taxBase: 300, vatRate: 21, vatAmount: 63 }], confidence: null,
      ...extracted,
    } as ExtractedInvoice,
  }));
  const key = `k-${Math.random()}`;
  fakeS3().put(key, "%PDF-1.4");
  const { id } = await makeInvoice(w.client, {
    filename: "f.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED", type,
    invoiceNumber: null, issuerCif: null, totalAmount: null,
    typeUnconfirmed,
    ...(routing ? { routingCandidateIds: [w.client.id] } : {}),
  });
  await processInvoice(id, w.worker.id);
  return id;
}
const state = async (id: string) => {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
  const issues = await prisma.invoiceIssue.findMany({ where: { invoiceId: id } });
  return { status: inv.status, receiverCif: inv.receiverCif, issuerCif: inv.issuerCif, issues: issues.map((i) => [i.type, i.field, i.description]) };
};

describe("al analizar (F-019)", () => {
  it("compra con el receptor de otro CIF: incidencia, y el receptor sigue siendo el cliente", async () => {
    const s = await state(await read("PURCHASE", { receiverName: "Ana Pérez", receiverCif: "12345678Z" }));
    expect(s.status).toBe("NEEDS_ATTENTION");
    expect(s.receiverCif).toBe(CLIENT_CIF);
    expect(s.issues).toEqual([["MANUAL", "clientParty", "Factura a nombre de Ana Pérez (12345678Z), no del cliente."]]);
  });

  it("mismo CIF con el nombre escrito distinto: nada", async () => {
    const s = await state(await read("PURCHASE", { receiverName: "CLIENTE A, S.L.", receiverCif: `ES-${CLIENT_CIF}` }));
    expect([s.status, s.issues]).toEqual(["PENDING_REVIEW", []]);
  });

  it("compra con emisor y receptor cambiados: se avisa de eso, no de que sea de otro", async () => {
    const s = await state(await read("PURCHASE", {
      issuerName: "Cliente A SL", issuerCif: CLIENT_CIF, receiverName: "Proveedor SL", receiverCif: "B12345674",
    }));
    expect(s.issues).toEqual([["MANUAL", "clientParty",
      "El cliente aparece como emisor en la factura: revisa si emisor y receptor están cambiados o si el tipo es correcto."]]);
  });

  it("con el tipo sin confirmar: sin incidencia (el lado del cliente es una suposición)", async () => {
    const s = await state(await read("PURCHASE", { receiverName: "Ana Pérez", receiverCif: "12345678Z" }, false, true));
    expect(s.issues).toEqual([]);
  });

  it("un VAT extranjero en el receptor también, con su país", async () => {
    const s = await state(await read("PURCHASE", { receiverName: "Muster GmbH", receiverCif: "DE123456789" }));
    expect(s.issues).toEqual([["MANUAL", "clientParty", "Factura a nombre de Muster GmbH (DE123456789), no del cliente."]]);
  });

  it("venta con el emisor de otro CIF: también", async () => {
    const s = await state(await read("SALE", {
      issuerName: "Socio SL", issuerCif: "B12345674", receiverName: "Comprador SA", receiverCif: "A58818501",
    }));
    expect(s.issues).toEqual([["MANUAL", "clientParty", "Factura a nombre de Socio SL (B12345674), no del cliente."]]);
  });
});

describe("al clasificar desde «Por clasificar» (F-019)", () => {
  it("un VAT extranjero leído en el receptor: incidencia con su país", async () => {
    const id = await read("PURCHASE", { receiverName: "Muster GmbH", receiverCif: "DE123456789" }, true);
    expect(await classifyInvoice(id, w.client.id)).toEqual({ ok: true });
    expect((await state(id)).issues).toEqual([["MANUAL", "clientParty", "Factura a nombre de Muster GmbH (DE123456789), no del cliente."]]);
  });

  it("con el tipo sin confirmar: sin incidencia", async () => {
    const id = await read("PURCHASE", { receiverName: "Ana Pérez", receiverCif: "12345678Z" }, true, true);
    expect(await classifyInvoice(id, w.client.id)).toEqual({ ok: true });
    expect((await state(id)).issues).toEqual([]);
  });

  it("el receptor leído era de otro: incidencia al elegir el cliente", async () => {
    const id = await read("PURCHASE", { receiverName: "Ana Pérez", receiverCif: "12345678Z" }, true);
    expect((await state(id)).status).toBe("PENDING_ROUTING");
    expect(await classifyInvoice(id, w.client.id)).toEqual({ ok: true });
    const s = await state(id);
    expect(s.status).toBe("NEEDS_ATTENTION");
    expect(s.issues).toEqual([["MANUAL", "clientParty", "Factura a nombre de Ana Pérez (12345678Z), no del cliente."]]);
  });
});

describe("al corregir el tipo y guardar (F-019)", () => {
  // Una venta del cliente subida como compra: el cliente sale de emisor.
  const upload = () => read("PURCHASE", {
    issuerName: "Cliente A SL", issuerCif: CLIENT_CIF, receiverName: "Comprador SA", receiverCif: "A58818501",
  });
  const save = async (id: string, type: "PURCHASE" | "SALE") => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    return settleAction(saveInvoiceFields(null, reviewForm(id, inv.updatedAt, { name: "Cliente A SL", cif: CLIENT_CIF }, {
      type, issuerName: "Cliente A SL", issuerCif: CLIENT_CIF, receiverName: "Comprador SA", receiverCif: "A58818501",
      invoiceNumber: "X-1", totalAmount: "363", vatLines: JSON.stringify([{ taxBase: "300", vatRate: "21", vatAmount: "63" }]),
    })));
  };
  const open = async (id: string) => prisma.invoiceIssue.count({ where: { invoiceId: id, field: "clientParty", status: "OPEN" } });

  it("guardada como venta: la incidencia se cierra", async () => {
    const id = await upload();
    expect(await open(id)).toBe(1);
    expect(await save(id, "SALE")).toEqual({ error: null });
    expect(await open(id)).toBe(0);
  });

  it("guardada otra vez como compra: sigue abierta", async () => {
    const id = await upload();
    expect(await save(id, "PURCHASE")).toEqual({ error: null });
    expect(await open(id)).toBe(1);
  });
});

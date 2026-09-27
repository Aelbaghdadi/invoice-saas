import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  a3ExclusionBox,
  a3ExclusionReason,
  generateA3Excel,
  partitionA3Exportable,
  validateForA3Export,
  type InvoiceWithClient,
} from "@/lib/exportFormats";

function mkInvoice(id: string, totalAmount: number | null, splitInvoices?: number): InvoiceWithClient {
  return {
    id,
    type: "PURCHASE",
    invoiceDate: new Date("2026-04-15"),
    invoiceNumber: `F-${id}`,
    issuerName: "Suministros S.L.",
    issuerCif: "B12345674",
    receiverName: "Cliente",
    receiverCif: "B87654321",
    taxBase: totalAmount ? 100 : 0,
    vatRate: 21,
    vatAmount: totalAmount ? 21 : 0,
    irpfRate: 0,
    irpfAmount: 0,
    totalAmount,
    supplierAccount: "4000001",
    expenseAccount: "6000001",
    client: { id: "c1", name: "ACME SL" },
    ...(splitInvoices !== undefined ? { _count: { splitInvoices } } : {}),
  } as unknown as InvoiceWithClient;
}

describe("a3ExclusionReason", () => {
  it.each([0, 0.004, -0.004])("excluye total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBe("total_cero");
  });

  it("un total vacío no es total 0: es bloqueante (sin_total), con un solo texto", () => {
    expect(a3ExclusionReason(mkInvoice("x", null))).toBe("bloqueante");
    const [warning] = validateForA3Export([mkInvoice("x", null)]);
    expect(warning.blockers).toContain("Total vacío");
    expect(warning.blockers.filter((b) => b.startsWith("Total = 0"))).toEqual([]);
  });

  it.each([0.01, -121, 121])("deja pasar total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBeNull();
    expect(a3ExclusionReason(mkInvoice("x", total, 0))).toBeNull();
  });

  it("excluye la original de una división aunque esté VALIDATED y con importe (van sus hijas)", () => {
    expect(a3ExclusionReason(mkInvoice("x", 121, 2))).toBe("dividida");
    // Dividida y con total 0: cuenta como dividida, que es lo que hay que arreglar.
    expect(a3ExclusionReason(mkInvoice("x", 0, 1))).toBe("dividida");
  });
});

describe("partitionA3Exportable", () => {
  it("separa las que van al Excel de las que no, sin perder el orden", () => {
    const { exportable, excluded } = partitionA3Exportable([
      mkInvoice("a", 121),
      mkInvoice("b", 0),
      mkInvoice("c", -60.5),
    ]);
    expect(exportable.map((i) => i.id)).toEqual(["a", "c"]);
    expect(excluded).toEqual([{ invoice: expect.objectContaining({ id: "b" }), reason: "total_cero" }]);
  });

  it("el Excel lleva exactamente las exportables", () => {
    const invoices = [mkInvoice("a", 121), mkInvoice("b", 0), mkInvoice("c", 242), mkInvoice("d", 500, 2)];
    const wb = XLSX.read(generateA3Excel(invoices), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Facturas recibidas"], { header: 1 });
    const numbers = rows.slice(1).map((r) => r[3]);
    expect(numbers).toEqual(partitionA3Exportable(invoices).exportable.map((i) => i.invoiceNumber));
  });
});

describe("aviso de factura excluida", () => {
  it("dice que no entra en el Excel ni se marca como exportada", () => {
    const [warning] = validateForA3Export([mkInvoice("b", 0)]);
    expect(warning.severity).toBe("bloqueante");
    expect(warning.blockers.join(" ")).toContain("no entra en el Excel ni se marca como exportada");
  });

  it("la original dividida va aparte, con un texto neutro y sin revisar sus datos", () => {
    const sinCuentas = { ...mkInvoice("d", 121, 2), supplierAccount: null, issuerCif: null } as InvoiceWithClient;
    const [warning] = validateForA3Export([sinCuentas]);
    expect(warning).toEqual({
      invoiceId: "d", invoiceNumber: "F-d", severity: "fuera", blockers: [],
      warnings: ["Es la original de una división: van al Excel las facturas que salieron de ella, no esta"],
    });
  });

  it("una rectificativa a cero va aparte; una factura normal a cero sigue siendo bloqueante", () => {
    const rect = { ...mkInvoice("r", 0), isRectificative: true } as InvoiceWithClient;
    expect(validateForA3Export([rect])[0]).toMatchObject({
      severity: "fuera", blockers: [], warnings: ["Rectificativa con total 0: no va al Excel (A3 no acepta importes cero)"],
    });
    expect(validateForA3Export([mkInvoice("n", 0)])[0].severity).toBe("bloqueante");
  });

  it("una rectificativa a cero CON importes en las líneas es bloqueante: A3 no recibiría esos importes", () => {
    const conImportes = {
      ...mkInvoice("ri", 0), isRectificative: true,
      vatLines: [
        { taxBase: -100, vatRate: 21, vatAmount: -21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
        { taxBase: 110, vatRate: 10, vatAmount: 11, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
      ],
    } as unknown as InvoiceWithClient;
    const [res] = validateForA3Export([conImportes]);
    expect(res.severity).toBe("bloqueante");
    expect(res.blockers[0]).toBe(
      "Rectificativa con total 0 pero con importes en las líneas: A3 no admite total 0; regístrala a mano en A3. "
      + "Si ya la has registrado, no la registres otra vez: seguirá saliendo aquí",
    );
    expect(a3ExclusionBox(conImportes)).toBe("a_mano");
    // Con retención distinta de 0 tampoco es «nada que corregir», y el texto
    // no habla de las líneas.
    const conRetencion = { ...mkInvoice("rr", 0), isRectificative: true, irpfAmount: 15 } as unknown as InvoiceWithClient;
    const [ret] = validateForA3Export([conRetencion]);
    expect(ret.severity).toBe("bloqueante");
    // Con las líneas a 0 y retención no cuadra (0 − 15 ≠ 0): hay que corregirla.
    expect(ret.blockers[0]).toBe("Rectificativa con total 0 pero con retención de 15,00 €: no cuadra; corrígela en la revisión");
    expect(a3ExclusionBox(conRetencion)).toBe("corregir");
  });

  it("orden: bloqueantes, avisos y las que no van al Excel", () => {
    const res = validateForA3Export([
      mkInvoice("d", 121, 2),
      { ...mkInvoice("a", 121), totalAmount: 130 } as unknown as InvoiceWithClient,
      mkInvoice("b", 0),
    ]);
    expect(res.map((r) => [r.invoiceId, r.severity])).toEqual([["b", "bloqueante"], ["a", "aviso"], ["d", "fuera"]]);
  });
});

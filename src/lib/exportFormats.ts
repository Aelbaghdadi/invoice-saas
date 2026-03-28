import type { Invoice, Client } from "@prisma/client";

export type ExportFormat = "sage50" | "contasol" | "a3con";
export type ExportInvoiceType = "ALL" | "PURCHASE" | "SALE";

export type InvoiceWithClient = Invoice & { client: Client };

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  return [
    String(dt.getDate()).padStart(2, "0"),
    String(dt.getMonth() + 1).padStart(2, "0"),
    dt.getFullYear(),
  ].join("/");
}

/** Convert Prisma Decimal / number / null → "1.234,56" (Spanish format) */
function fmtAmt(v: unknown): string {
  if (v === null || v === undefined) return "0,00";
  return Number(v).toFixed(2).replace(".", ",");
}

function fmtPct(v: unknown): string {
  if (v === null || v === undefined) return "0,00";
  return Number(v).toFixed(2).replace(".", ",");
}

// ─── type codes ─────────────────────────────────────────────────────────────

function typeCode(type: string, format: ExportFormat): string {
  if (format === "a3con")    return type === "PURCHASE" ? "1" : "2";
  if (format === "contasol") return type === "PURCHASE" ? "C" : "V";
  return type === "PURCHASE" ? "R" : "E"; // sage50: R = recibida, E = emitida
}

// ─── headers ────────────────────────────────────────────────────────────────

const HEADERS: Record<ExportFormat, string[]> = {
  sage50: [
    "Tipo", "Fecha", "Nº Factura", "Nombre / Razón social", "NIF/CIF",
    "Base Imponible", "% IVA", "Cuota IVA", "% IRPF", "Cuota IRPF", "Total Factura",
  ],
  contasol: [
    "Tipo", "Fecha", "Número", "Proveedor / Cliente", "CIF",
    "Base1", "%IVA1", "CuotaIVA1", "%IRPF", "CuotaIRPF", "Total",
  ],
  a3con: [
    "Tipo", "Fecha", "Numero Factura", "CIF", "Razon Social",
    "Base Imponible", "Tipo IVA", "Cuota IVA", "Tipo IRPF", "Cuota IRPF", "Importe Total",
  ],
};

// ─── row builder ─────────────────────────────────────────────────────────────

function buildRow(inv: InvoiceWithClient, format: ExportFormat): string[] {
  const tipo      = typeCode(inv.type, format);
  const fecha     = fmtDate(inv.invoiceDate);
  const numero    = inv.invoiceNumber ?? "";
  const nombre    = inv.issuerName ?? "";
  const cif       = inv.issuerCif ?? "";
  const base      = fmtAmt(inv.taxBase);
  const pctIva    = fmtPct(inv.vatRate);
  const cuotaIva  = fmtAmt(inv.vatAmount);
  const pctIrpf   = fmtPct(inv.irpfRate);
  const cuotaIrpf = fmtAmt(inv.irpfAmount);
  const total     = fmtAmt(inv.totalAmount);

  switch (format) {
    case "sage50":
      return [tipo, fecha, numero, nombre, cif, base, pctIva, cuotaIva, pctIrpf, cuotaIrpf, total];
    case "contasol":
      return [tipo, fecha, numero, nombre, cif, base, pctIva, cuotaIva, pctIrpf, cuotaIrpf, total];
    case "a3con":
      // a3con swaps nombre ↔ cif order
      return [tipo, fecha, numero, cif, nombre, base, pctIva, cuotaIva, pctIrpf, cuotaIrpf, total];
  }
}

// ─── main export ─────────────────────────────────────────────────────────────

export function generateCsv(
  invoices: InvoiceWithClient[],
  format: ExportFormat,
): string {
  const SEP = ";";
  const header = HEADERS[format].join(SEP);
  const rows   = invoices.map((inv) => buildRow(inv, format).join(SEP));
  // BOM so Excel opens with correct encoding
  return "\uFEFF" + [header, ...rows].join("\r\n");
}

export function suggestFilename(
  invoices: InvoiceWithClient[],
  format: ExportFormat,
  month: number,
  year: number,
): string {
  const clientName = invoices[0]?.client.name.replace(/\s+/g, "_") ?? "cliente";
  const mm = String(month).padStart(2, "0");
  return `facturas_${clientName}_${year}-${mm}_${format}.csv`;
}

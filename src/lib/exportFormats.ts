import type { Invoice, Client } from "@prisma/client";
import * as XLSX from "xlsx";

export type ExportFormat = "sage50" | "contasol" | "a3con" | "a3excel";
export type ExportInvoiceType = "ALL" | "PURCHASE" | "SALE";

export type ExportConfig = {
  encoding?: string;    // "utf-8" | "windows-1252"
  delimiter?: string;   // ";" | "," | "\t"
  dateFormat?: string;  // "DD/MM/YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY"
};

export type InvoiceWithClient = Invoice & { client: Client };

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null | undefined, dateFormat?: string): string {
  if (!d) return "";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();

  switch (dateFormat) {
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    case "MM/DD/YYYY": return `${mm}/${dd}/${yyyy}`;
    default:           return `${dd}/${mm}/${yyyy}`;
  }
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
    "Base Imponible", "Tipo IVA", "Cuota IVA", "Importe Total",
  ],
  a3excel: [], // A3 Excel uses its own headers in generateA3Excel()
};

// ─── row builder ─────────────────────────────────────────────────────────────

function buildRow(inv: InvoiceWithClient, format: ExportFormat, config?: ExportConfig): string[] {
  const tipo      = typeCode(inv.type, format);
  const fecha     = fmtDate(inv.invoiceDate, config?.dateFormat);
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
      // a3con: aligned with A3 template (no IRPF)
      return [tipo, fecha, numero, cif, nombre, base, pctIva, cuotaIva, total];
    case "a3excel":
      // a3excel uses generateA3Excel(), not CSV row builder
      return [tipo, fecha, numero, cif, nombre, base, pctIva, cuotaIva, total];
  }
}

// ─── main export ─────────────────────────────────────────────────────────────

export function generateCsv(
  invoices: InvoiceWithClient[],
  format: ExportFormat,
  config?: ExportConfig,
): string {
  const SEP = config?.delimiter ?? ";";
  const header = HEADERS[format].join(SEP);
  const rows   = invoices.map((inv) => buildRow(inv, format, config).join(SEP));
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
  const ext = format === "a3excel" ? "xlsx" : "csv";
  return `facturas_${clientName}_${year}-${mm}_${format}.${ext}`;
}

// ─── A3 Excel export (.xlsx) ────────────────────────────────────────────────

const A3_HEADERS = [
  "Fecha de Expedición",
  "Fecha de Contabilización",
  "Concepto",
  "Numero Factura",
  "NIF",
  "Nombre",
  "Tipo de Operación",
  "Cuenta Cliente/Proveedor",
  "Cuenta de Compras/Ventas",
  "Base",
  "% IVA",
  "Cuota IVA",
  "Enlace de la Factura",
];

function buildA3Row(inv: InvoiceWithClient, config?: ExportConfig): (string | number | null)[] {
  const isPurchase = inv.type === "PURCHASE";
  return [
    fmtDate(inv.invoiceDate, config?.dateFormat),             // A: Fecha expedición
    "",                                                        // B: Fecha contabilización (blank)
    inv.invoiceNumber ?? "",                                   // C: Concepto
    inv.invoiceNumber ?? "",                                   // D: Numero factura
    (isPurchase ? inv.issuerCif : inv.receiverCif) ?? "",     // E: NIF
    (isPurchase ? inv.issuerName : inv.receiverName) ?? "",   // F: Nombre
    "",                                                        // G: Tipo operación (blank)
    inv.supplierAccount ?? "",                        // H: Cuenta proveedor
    inv.expenseAccount ?? "",                         // I: Cuenta gasto
    inv.taxBase ? Number(inv.taxBase) : 0,                    // J: Base
    inv.vatRate ? Number(inv.vatRate) : 0,                    // K: % IVA
    inv.vatAmount ? Number(inv.vatAmount) : 0,                // L: Cuota IVA
    "",                                                        // M: Enlace factura
  ];
}

export type A3ValidationWarning = {
  invoiceId: string;
  invoiceNumber: string | null;
  warnings: string[];
};

/** Validate invoices before A3 export, returns warnings (non-blocking) */
export function validateForA3Export(invoices: InvoiceWithClient[]): A3ValidationWarning[] {
  const results: A3ValidationWarning[] = [];

  for (const inv of invoices) {
    const warnings: string[] = [];
    const isPurchase = inv.type === "PURCHASE";
    const nif = isPurchase ? inv.issuerCif : inv.receiverCif;

    if (!nif) warnings.push("NIF vacío");
    if (!inv.invoiceDate) warnings.push("Fecha vacía");
    if (!inv.supplierAccount) warnings.push("Sin cuenta proveedor");
    if (!inv.expenseAccount) warnings.push("Sin cuenta gasto");

    // Base + IVA = Total check
    if (inv.taxBase && inv.vatAmount && inv.totalAmount) {
      const base = Number(inv.taxBase);
      const vatAmt = Number(inv.vatAmount);
      const total = Number(inv.totalAmount);
      const diff = Math.abs(Math.round((base + vatAmt) * 100) - Math.round(total * 100));
      if (diff > 1) warnings.push(`Descuadre Base+IVA vs Total: ${(diff / 100).toFixed(2)}`);
    }

    if (warnings.length > 0) {
      results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, warnings });
    }
  }

  return results;
}

/** Generate A3 Excel workbook as Buffer */
export function generateA3Excel(
  invoices: InvoiceWithClient[],
  config?: ExportConfig,
): Buffer {
  const wb = XLSX.utils.book_new();

  const purchases = invoices.filter((i) => i.type === "PURCHASE");
  const sales = invoices.filter((i) => i.type === "SALE");

  const makeSheet = (items: InvoiceWithClient[]) => {
    const rows = items.map((inv) => buildA3Row(inv, config));
    const ws = XLSX.utils.aoa_to_sheet([A3_HEADERS, ...rows]);

    // Set column widths
    ws["!cols"] = [
      { wch: 16 }, // A: Fecha
      { wch: 16 }, // B: Fecha contab.
      { wch: 20 }, // C: Concepto
      { wch: 16 }, // D: Nº Factura
      { wch: 12 }, // E: NIF
      { wch: 30 }, // F: Nombre
      { wch: 12 }, // G: Tipo op.
      { wch: 16 }, // H: Cuenta prov.
      { wch: 16 }, // I: Cuenta gasto
      { wch: 12 }, // J: Base
      { wch: 8 },  // K: % IVA
      { wch: 12 }, // L: Cuota IVA
      { wch: 30 }, // M: Enlace
    ];

    return ws;
  };

  if (purchases.length > 0) {
    XLSX.utils.book_append_sheet(wb, makeSheet(purchases), "Facturas recibidas");
  }
  if (sales.length > 0) {
    XLSX.utils.book_append_sheet(wb, makeSheet(sales), "Facturas expedidas");
  }

  // If no invoices of either type, create an empty sheet
  if (purchases.length === 0 && sales.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([A3_HEADERS]), "Facturas");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

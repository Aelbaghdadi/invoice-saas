import type { Invoice, Client, InvoiceVatLine } from "@prisma/client";
import * as XLSX from "xlsx";
import {
  OPERATION_TYPE_CODE,
  type OperationTypeName,
} from "@/lib/validators";

export type ExportFormat = "sage50" | "contasol" | "a3con" | "a3excel";
export type ExportInvoiceType = "ALL" | "PURCHASE" | "SALE";

export type ExportConfig = {
  encoding?: string;    // "utf-8" | "windows-1252"
  delimiter?: string;   // ";" | "," | "\t"
  dateFormat?: string;  // "DD/MM/YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY"
};

export type InvoiceWithClient = Invoice & {
  client: Client;
  /** Desglose por tipo de IVA. Cuando esta presente y tiene >0 elementos,
   *  los exportadores emiten una fila por linea (a3 asesor "repetir fila
   *  cambiando %IVA y cuota"). Cuando esta vacio se cae a los campos
   *  planos de Invoice como linea unica. */
  vatLines?: InvoiceVatLine[];
};

/** Devuelve las lineas a exportar para una factura. Si la factura ya tiene
 *  desglose lo usa; si no, sintetiza una linea unica con los campos planos
 *  (compatibilidad con datos legacy y con los tests). */
type ExportVatLine = { taxBase: number; vatRate: number; vatAmount: number };

function getExportLines(inv: InvoiceWithClient): ExportVatLine[] {
  if (inv.vatLines && inv.vatLines.length > 0) {
    return inv.vatLines.map((l) => ({
      taxBase:   Number(l.taxBase),
      vatRate:   Number(l.vatRate),
      vatAmount: Number(l.vatAmount),
    }));
  }
  return [{
    taxBase:   inv.taxBase   ? Number(inv.taxBase)   : 0,
    vatRate:   inv.vatRate   ? Number(inv.vatRate)   : 0,
    vatAmount: inv.vatAmount ? Number(inv.vatAmount) : 0,
  }];
}

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

/** Construye una fila CSV para una linea de IVA concreta. Multi-IVA:
 *  llamamos varias veces con la misma factura cambiando solo la linea. */
function buildRow(
  inv: InvoiceWithClient,
  line: ExportVatLine,
  isFirstLine: boolean,
  format: ExportFormat,
  config?: ExportConfig,
): string[] {
  const tipo      = typeCode(inv.type, format);
  const fecha     = fmtDate(inv.invoiceDate, config?.dateFormat);
  const numero    = inv.invoiceNumber ?? "";
  const nombre    = inv.issuerName ?? "";
  const cif       = inv.issuerCif ?? "";
  const base      = fmtAmt(line.taxBase);
  const pctIva    = fmtPct(line.vatRate);
  const cuotaIva  = fmtAmt(line.vatAmount);
  // IRPF y total solo en la primera linea para que la suma cuadre
  // (a3 asesor importa el total una sola vez).
  const pctIrpf   = isFirstLine ? fmtPct(inv.irpfRate)    : "0,00";
  const cuotaIrpf = isFirstLine ? fmtAmt(inv.irpfAmount)  : "0,00";
  const total     = isFirstLine ? fmtAmt(inv.totalAmount) : "0,00";

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
  const rows: string[] = [];
  for (const inv of invoices) {
    const lines = getExportLines(inv);
    lines.forEach((line, i) => {
      rows.push(buildRow(inv, line, i === 0, format, config).join(SEP));
    });
  }
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

// Cabeceras EXACTAS de la plantilla oficial A3 (Libro_de_Facturas_*).
// Mantenemos los typos del original ("Cutoa") para que el mapeo en el
// wizard A3 sea por nombre y no tengamos que cambiarlo. 16 columnas
// totales — la columna B "Fecha de Contabilizacion" es la obligatoria
// según el cliente, A "Fecha de Expedición" puede ir en blanco.
const A3_HEADERS = [
  "Fecha de Expedición",         // A — opcional, se puede dejar en blanco
  "Fecha de Contabilizacion",    // B — OBLIGATORIA, sin tilde en plantilla
  "Concepto",                    // C
  "Numero Factura",              // D
  "Nif",                         // E — plantilla usa "Nif" con minúsculas
  "Nombre",                      // F
  "Tipo de Operación",           // G
  "Cuenta Cliente/Proveedor",    // H
  "Cuenta de Compras/Ventas",    // I
  "Base",                        // J
  "% IVA",                       // K
  "Cuota IVA",                   // L
  "% Rec. Equiv.",               // M
  "Cutoa Rec. Equiv.",           // N — sic, "Cutoa" con typo igual que plantilla
  "% Retención IRPF",            // O
  "Cuota Retención IRPF",        // P
];

function buildA3Row(
  inv: InvoiceWithClient,
  line: ExportVatLine,
  isFirstLine: boolean,
  config?: ExportConfig,
): (string | number | null)[] {
  const isPurchase = inv.type === "PURCHASE";
  // Codigo numerico de tipo de operacion para A3. Si por algun motivo
  // viene null/desconocido, caemos a 1 (Interior) que es el caso comun.
  const opTypeCode = inv.operationType
    ? OPERATION_TYPE_CODE[inv.operationType as OperationTypeName] ?? 1
    : 1;
  // Retencion IRPF: solo se emite en la PRIMERA fila del multi-IVA para
  // que A3 no sume varias veces. En las filas siguientes va a 0.
  // Para rectificativas, la retencion respeta el signo de la base.
  const retentionRate   = isFirstLine && inv.irpfRate   ? Number(inv.irpfRate)   : 0;
  const retentionAmount = isFirstLine && inv.irpfAmount ? Number(inv.irpfAmount) : 0;
  // Fecha de Contabilizacion (col B): obligatoria segun plantilla A3.
  // Por defecto = fecha de la factura. El gestor puede sobreescribirla
  // en el Excel exportado si quiere registrar el asiento en otro mes.
  const fechaFactura = fmtDate(inv.invoiceDate, config?.dateFormat);
  // Sufijo _R en facturas rectificativas: A3 no permite importar dos
  // facturas con mismo NIF + numero, asi que la rectificativa lleva
  // siempre _R para diferenciarla de la original sin colisionar.
  const baseNumber = inv.invoiceNumber ?? "";
  const exportNumber = inv.isRectificative && baseNumber
    ? `${baseNumber}_R`
    : baseNumber;
  return [
    fechaFactura,                                              // A: Fecha expedición (opcional)
    fechaFactura,                                              // B: Fecha contabilización (OBLIGATORIA)
    exportNumber,                                              // C: Concepto
    exportNumber,                                              // D: Numero factura (con _R si rectificativa)
    (isPurchase ? inv.issuerCif : inv.receiverCif) ?? "",     // E: NIF
    (isPurchase ? inv.issuerName : inv.receiverName) ?? "",   // F: Nombre
    opTypeCode,                                                // G: Tipo operación (1/2/3/4/6/7)
    inv.supplierAccount ?? "",                                 // H: Cuenta proveedor/cliente
    inv.expenseAccount ?? "",                                  // I: Cuenta compras/ventas
    line.taxBase,                                              // J: Base (signo respetado en rectificativa)
    line.vatRate,                                              // K: % IVA
    line.vatAmount,                                            // L: Cuota IVA (signo respetado)
    0,                                                         // M: % Rec. Equiv.
    0,                                                         // N: Cutoa Rec. Equiv.
    retentionRate,                                             // O: % Retención IRPF
    retentionAmount,                                           // P: Cuota Retención IRPF
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

    // Total = 0: A3 rechaza asientos de valor cero. Lo marcamos como
    // warning serio para que el gestor o lo corrija o lo excluya del
    // export. En `generateA3Excel` se filtra fuera automáticamente.
    const totalNum = Number(inv.totalAmount ?? 0);
    if (Math.abs(totalNum) < 0.005) {
      warnings.push("Total = 0 (excluida del export — A3 no acepta importes cero)");
    }

    // Base + IVA - IRPF = Total. Suma sobre las lineas si las hay.
    if (inv.totalAmount && Math.abs(totalNum) >= 0.005) {
      const lines = getExportLines(inv);
      const sumBase = lines.reduce((s, l) => s + l.taxBase, 0);
      const sumAmt  = lines.reduce((s, l) => s + l.vatAmount, 0);
      const irpf    = inv.irpfAmount ? Number(inv.irpfAmount) : 0;
      const expected = sumBase + sumAmt - irpf;
      if (Math.abs(sumBase) > 0 || Math.abs(sumAmt) > 0) {
        const diff = Math.abs(Math.round(expected * 100) - Math.round(totalNum * 100));
        if (diff > 1) warnings.push(`Descuadre Base+IVA vs Total: ${(diff / 100).toFixed(2)}`);
      }
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

  // Filtrar facturas con total = 0: A3 rechaza asientos de importe cero
  // (puede pasar cuando una rectificativa anula exactamente a la original
  // y se intentan exportar juntas). El gestor recibe el warning previo
  // en validateForA3Export para que sepa lo que ha pasado.
  const exportable = invoices.filter((i) => {
    const total = Number(i.totalAmount ?? 0);
    return Math.abs(total) >= 0.005;
  });

  const purchases = exportable.filter((i) => i.type === "PURCHASE");
  const sales = exportable.filter((i) => i.type === "SALE");

  const makeSheet = (items: InvoiceWithClient[]) => {
    // A3: una fila por linea de IVA. Para multi-IVA, todo se repite igual
    // (NIF, fecha, num factura...) excepto Base/%IVA/Cuota. La retencion
    // IRPF se emite SOLO en la primera fila para no sumar varias veces.
    const rows: (string | number | null)[][] = [];
    for (const inv of items) {
      const exportLines = getExportLines(inv);
      exportLines.forEach((line, i) => {
        rows.push(buildA3Row(inv, line, i === 0, config));
      });
    }
    const ws = XLSX.utils.aoa_to_sheet([A3_HEADERS, ...rows]);

    // Set column widths (16 cols, alineadas con plantilla A3 oficial)
    ws["!cols"] = [
      { wch: 16 }, // A: Fecha expedición
      { wch: 16 }, // B: Fecha contabilización
      { wch: 20 }, // C: Concepto
      { wch: 16 }, // D: Nº Factura
      { wch: 12 }, // E: Nif
      { wch: 30 }, // F: Nombre
      { wch: 12 }, // G: Tipo op.
      { wch: 16 }, // H: Cuenta cli/prov
      { wch: 16 }, // I: Cuenta compras/ventas
      { wch: 12 }, // J: Base
      { wch: 8 },  // K: % IVA
      { wch: 12 }, // L: Cuota IVA
      { wch: 10 }, // M: % Rec. Equiv.
      { wch: 12 }, // N: Cutoa Rec. Equiv.
      { wch: 12 }, // O: % Retención IRPF
      { wch: 14 }, // P: Cuota Retención IRPF
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

/**
 * Definicion declarativa de los datos de demo.
 *
 * Una sola fuente de verdad para:
 *  - el script CLI (scripts/seed-demo.ts)
 *  - el script de pre-build de PDFs (scripts/build-seed-pdfs.ts)
 *  - el endpoint API que reinicia la demo desde el panel admin
 *    (/api/admin/reset-demo)
 *
 * Las facturas referencian PDFs por nombre: el seed los lee de
 * scripts/seed-pdfs/ (pre-construidos y committeados al repo) cuando
 * corre desde la API; o los regenera con Python cuando corre desde CLI.
 */

export type PdfConfig = {
  emisor: { nombre: string; cif: string; direccion: string; cp_ciudad: string };
  receptor: { nombre: string; cif: string; direccion: string; cp_ciudad: string };
  numero: string;
  fecha_emision: string;
  fecha_vencimiento?: string;
  periodo?: string;
  conceptos: string[][];
  base: number;
  iva_rate: number;
  iva: number;
  total: number;
  forma_pago?: string;
  color_primary?: string;
  color_accent?: string;
  logo_texto?: string;
  titulo_cabecera?: string;
  subtitulo_izq?: string;
  subtitulo_der?: string;
  datos_extra_titulo?: string;
  datos_extra?: Record<string, string>;
};

export type SeedClientKey = "panaderia" | "taller";
export type SeedStatus = "VALIDATED" | "PENDING_REVIEW" | "NEEDS_ATTENTION";
export type SeedIssueType =
  | "OCR_FAILED"
  | "LOW_CONFIDENCE"
  | "POSSIBLE_DUPLICATE"
  | "MATH_MISMATCH"
  | "MANUAL";

export type SeedInvoiceDef = {
  /** Cliente al que pertenece (resuelto en runtime al Client.id real). */
  client: SeedClientKey;
  type: "PURCHASE" | "SALE";
  status: SeedStatus;
  month: number;
  year: number;
  filename: string;
  /** Config del PDF (input del generador Python). */
  pdf: PdfConfig;
  issues?: { type: SeedIssueType; description: string; field?: string }[];
};

const panaderiaAddr = { direccion: "Calle Mayor 42", cp_ciudad: "28013 Madrid" };
const tallerAddr = { direccion: "Polígono Industrial Sur, Nave 7", cp_ciudad: "28914 Leganés" };

export const SEED_CLIENTS = {
  panaderia: { name: "Panadería La Espiga S.L.", cif: "B12345674", email: "admin@panaderia-laespiga.es", accountingProgram: "A3 Asesor" },
  taller:    { name: "Taller Mecánico Pérez",    cif: "A58818501", email: "contacto@tallerperez.es",    accountingProgram: "A3 Asesor" },
} as const;

export const SEED_INVOICE_DEFS: SeedInvoiceDef[] = [
  // ── PANADERIA · Abril 2026 · COMPRAS ─────────────────────────
  {
    client: "panaderia", type: "PURCHASE", status: "VALIDATED", month: 4, year: 2026,
    filename: "iberdrola-abril.pdf",
    pdf: {
      emisor: { nombre: "Iberdrola Clientes S.A.U.", cif: "A95758389", direccion: "Calle Tomás Redondo, 1", cp_ciudad: "28033 Madrid" },
      receptor: { nombre: SEED_CLIENTS.panaderia.name, cif: SEED_CLIENTS.panaderia.cif, ...panaderiaAddr },
      numero: "F-2026-04412", fecha_emision: "05/04/2026", fecha_vencimiento: "20/04/2026",
      periodo: "01/03/2026 - 31/03/2026",
      conceptos: [
        ["Suministro electrico marzo 2026", "820 kWh", "0,148 EUR/kWh", "121,36 EUR"],
        ["Termino de potencia (30 dias)", "4,6 kW", "6,196 EUR/kW", "28,50 EUR"],
        ["Alquiler equipo de medida", "1 ud.", "1,14 EUR", "1,14 EUR"],
      ],
      base: 151.00, iva_rate: 21, iva: 31.71, total: 182.71,
      logo_texto: "IBERDROLA", titulo_cabecera: "FACTURA ELECTRICA",
      subtitulo_izq: "Energia para un futuro sostenible",
      color_primary: "#1A5F3F", color_accent: "#88C540",
      forma_pago: "Domiciliacion bancaria - IBAN ES12 **** **** **** 3456",
      datos_extra_titulo: "PUNTO DE SUMINISTRO",
      datos_extra: { "CUPS:": "ES0021000001234567AB", "Tarifa:": "2.0TD", "Direccion:": "Calle Mayor 42, 28013 Madrid" },
    },
  },
  {
    client: "panaderia", type: "PURCHASE", status: "PENDING_REVIEW", month: 4, year: 2026,
    filename: "telefonica-abril.pdf",
    pdf: {
      emisor: { nombre: "Telefónica España S.A.", cif: "A28015865", direccion: "Gran Vía 28", cp_ciudad: "28013 Madrid" },
      receptor: { nombre: SEED_CLIENTS.panaderia.name, cif: SEED_CLIENTS.panaderia.cif, ...panaderiaAddr },
      numero: "TLF-0889-2026", fecha_emision: "08/04/2026", fecha_vencimiento: "28/04/2026",
      periodo: "01/03/2026 - 31/03/2026",
      conceptos: [
        ["Fibra optica 600Mb + fijo", "1 mes", "59,90 EUR", "59,90 EUR"],
        ["Linea movil profesional", "1 mes", "25,10 EUR", "25,10 EUR"],
      ],
      base: 85.00, iva_rate: 21, iva: 17.85, total: 102.85,
      logo_texto: "TELEFONICA", titulo_cabecera: "FACTURA DE SERVICIOS",
      color_primary: "#0066A1", color_accent: "#00B8D4",
      forma_pago: "Cargo en cuenta el 28/04/2026",
    },
  },
  {
    client: "panaderia", type: "PURCHASE", status: "NEEDS_ATTENTION", month: 4, year: 2026,
    filename: "ferreteria-descuadre.pdf",
    pdf: {
      emisor: { nombre: "Ferretería Industrial López", cif: "B45678919", direccion: "Av. de Castilla 14", cp_ciudad: "28850 Torrejón de Ardoz" },
      receptor: { nombre: SEED_CLIENTS.panaderia.name, cif: SEED_CLIENTS.panaderia.cif, ...panaderiaAddr },
      numero: "FI-0043", fecha_emision: "10/04/2026",
      conceptos: [
        ["Bandejas horno acero inox 60x40", "8 ud.", "18,00 EUR", "144,00 EUR"],
        ["Guantes termicos", "4 ud.", "9,00 EUR", "36,00 EUR"],
      ],
      base: 180.00, iva_rate: 21, iva: 37.80, total: 230.00,
      logo_texto: "FERR. IND.", titulo_cabecera: "FACTURA",
      color_primary: "#7C2D12", color_accent: "#F59E0B",
      forma_pago: "Transferencia bancaria 30 dias",
    },
    issues: [
      { type: "LOW_CONFIDENCE", description: 'Campo "Nombre emisor" con baja confianza OCR (52%).', field: "issuerName" },
      { type: "MATH_MISMATCH", description: "El total (230.00) no coincide con Base + IVA (217.80). Diferencia: 12.20€." },
    ],
  },
  // ── TALLER · Abril 2026 · COMPRAS ──────────────────────────
  {
    client: "taller", type: "PURCHASE", status: "VALIDATED", month: 4, year: 2026,
    filename: "repsol-gasoil.pdf",
    pdf: {
      emisor: { nombre: "Repsol Comercializadora S.A.", cif: "A78374114", direccion: "Méndez Álvaro 44", cp_ciudad: "28045 Madrid" },
      receptor: { nombre: SEED_CLIENTS.taller.name, cif: SEED_CLIENTS.taller.cif, ...tallerAddr },
      numero: "FR-00283-26", fecha_emision: "04/04/2026", fecha_vencimiento: "04/05/2026",
      conceptos: [
        ["Gasoleo B agricola", "350 L", "1,089 EUR/L", "381,15 EUR"],
        ["Desplazamiento", "1 ud.", "18,85 EUR", "18,85 EUR"],
      ],
      base: 400.00, iva_rate: 21, iva: 84.00, total: 484.00,
      logo_texto: "REPSOL", titulo_cabecera: "FACTURA COMBUSTIBLE",
      color_primary: "#E30613", color_accent: "#FFC72C",
      forma_pago: "Giro SEPA 30 dias",
    },
  },
  {
    client: "taller", type: "PURCHASE", status: "PENDING_REVIEW", month: 4, year: 2026,
    filename: "piezas-recambios.pdf",
    pdf: {
      emisor: { nombre: "Recambios Del Sur S.L.", cif: "B91234567", direccion: "Pol. Ind. La Negrilla C/ 3", cp_ciudad: "41016 Sevilla" },
      receptor: { nombre: SEED_CLIENTS.taller.name, cif: SEED_CLIENTS.taller.cif, ...tallerAddr },
      numero: "RS-2026-1241", fecha_emision: "11/04/2026", fecha_vencimiento: "11/05/2026",
      conceptos: [
        ["Pastillas de freno delanteras (Audi A4)", "1 jgo", "68,00 EUR", "68,00 EUR"],
        ["Filtro aceite universal", "4 ud.", "6,25 EUR", "25,00 EUR"],
        ["Aceite motor 5W30 5L", "2 ud.", "38,50 EUR", "77,00 EUR"],
      ],
      base: 170.00, iva_rate: 21, iva: 35.70, total: 205.70,
      logo_texto: "RECAMBIOS", titulo_cabecera: "FACTURA",
      color_primary: "#1E3A8A", color_accent: "#60A5FA",
      forma_pago: "Pagare a 30 dias",
    },
  },
  {
    client: "taller", type: "PURCHASE", status: "NEEDS_ATTENTION", month: 4, year: 2026,
    filename: "iberdrola-taller-duplicada.pdf",
    pdf: {
      emisor: { nombre: "Iberdrola Clientes S.A.U.", cif: "A95758389", direccion: "Calle Tomás Redondo, 1", cp_ciudad: "28033 Madrid" },
      receptor: { nombre: SEED_CLIENTS.taller.name, cif: SEED_CLIENTS.taller.cif, ...tallerAddr },
      numero: "IBE-TAL-0981", fecha_emision: "07/04/2026",
      conceptos: [
        ["Suministro electrico nave industrial marzo 2026", "560 kWh", "0,148 EUR/kWh", "82,88 EUR"],
        ["Termino de potencia", "10 kW", "1,212 EUR/kW", "12,12 EUR"],
      ],
      base: 95.00, iva_rate: 21, iva: 19.95, total: 114.95,
      logo_texto: "IBERDROLA", titulo_cabecera: "FACTURA ELECTRICA",
      subtitulo_izq: "Energia para un futuro sostenible",
      color_primary: "#1A5F3F", color_accent: "#88C540",
      forma_pago: "Domiciliacion bancaria",
    },
    issues: [
      { type: "POSSIBLE_DUPLICATE", description: 'Posible duplicado: factura IBE-TAL-0981 de A95758389 ya registrada anteriormente.' },
    ],
  },
];

export const SEED_ACCOUNT_ENTRIES = {
  panaderia: [
    { nif: "A95758389", name: "Iberdrola Clientes S.A.U.", supplierAccount: "4000001", expenseAccount: "6280001", defaultVatRate: 21 },
    { nif: "A28015865", name: "Telefónica España S.A.",   supplierAccount: "4000002", expenseAccount: "6290001", defaultVatRate: 21 },
  ],
  taller: [
    { nif: "A78374114", name: "Repsol Comercializadora S.A.", supplierAccount: "4100001", expenseAccount: "6000001", defaultVatRate: 21 },
    { nif: "A95758389", name: "Iberdrola Clientes S.A.U.",    supplierAccount: "4100002", expenseAccount: "6280001", defaultVatRate: 21 },
  ],
} as const;

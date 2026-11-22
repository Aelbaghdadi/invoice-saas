/**
 * Formato del ZIP del archivo de un ejercicio (R20), sin BD ni almacenamiento:
 * dónde va cada original, las filas del índice y el LEEME. Lo que se puede
 * probar en unitarios.
 */
import type { InvoiceStatus, InvoiceType, OriginalMedium, RetentionHoldReason } from "@prisma/client";
import { fileExtension, safeZipName } from "@/lib/clientDataExportFormat";
import { RETENTION_MIN_YEARS } from "@/lib/archiveRules";
import { BRAND } from "@/lib/brand";
import { STATUS_LABELS } from "@/lib/invoiceStatuses";
import { mediumLabel, RETENTION_HOLD_LABELS } from "@/lib/originalMedium";
import { registerFileStem } from "@/lib/registerNumbers";

// ── Dónde va cada original ──────────────────────────────────────────────────

/** Carpeta de primer nivel del ZIP, y hoja del índice. */
export type ArchiveZipFolder = "recibidas" | "emitidas" | "sin-registrar" | "rechazadas";

/** Un fichero guardado: el de una factura o un Document adjunto. */
export type ArchiveStoredFile = {
  storageKey: string;
  fileType: string;
  filename: string;
  /** SHA-256 que se guardó al subirlo; null en lo muy antiguo. */
  fileHash: string | null;
  /** null: no se guardó (cuenta como una subida del máximo). */
  sizeBytes: number | null;
  createdAt: Date;
};

export type ArchiveZipInvoice = {
  invoiceId: string;
  status: InvoiceStatus;
  type: InvoiceType;
  /** Su nº de registro, o null si aún no se ha exportado a A3. */
  register: { type: InvoiceType; year: number; number: number } | null;
  /** El periodo de deducción (su primer mes): la carpeta AAAA-MM. */
  period: { year: number; month: number };
  invoiceNumber: string | null;
  thirdPartyName: string | null;
  /** Su fichero: el que lee la app. */
  own: ArchiveStoredFile;
  /** El original en otro formato (Word, Excel…): el suyo o el de su raíz. */
  otherFormat: ArchiveStoredFile | null;
  /** El documento entero, si es una parte de una división. */
  splitRoot: ArchiveStoredFile | null;
  /** La raíz de su división, si es una parte: las partes comparten ficheros. */
  splitRootId: string | null;
};

/**
 * Carpeta de una factura: las rechazadas aparte; sin nº de registro,
 * sin-registrar; con él, la de su serie (R recibidas, E emitidas), aunque
 * después se haya corregido el tipo: el nombre empieza por ese número.
 */
export function archiveZipFolder(invoice: Pick<ArchiveZipInvoice, "status" | "register">): ArchiveZipFolder {
  if (invoice.status === "REJECTED") return "rechazadas";
  if (!invoice.register) return "sin-registrar";
  return invoice.register.type === "SALE" ? "emitidas" : "recibidas";
}

/** «R-2026-0153 F-123 Proveedor SL»; sin nº de registro, «SR-{id} …». */
export function archiveZipStem(
  invoice: Pick<ArchiveZipInvoice, "invoiceId" | "register" | "invoiceNumber" | "thirdPartyName">,
): string {
  const prefix = invoice.register ? registerFileStem(invoice.register, invoice.register.number) : `SR-${invoice.invoiceId}`;
  const text = [prefix, invoice.invoiceNumber, invoice.thirdPartyName]
    .map((part) => part?.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  return safeZipName(text, 120);
}

export type ArchiveZipEntry = ArchiveStoredFile & { path: string };

/** Dónde quedó el original de una factura (y su copia en PDF si es un Word). */
export type ArchiveZipPlacement = { original: string; originalKey: string; copy: string | null };

export type ArchiveZipPlan = {
  /** Los ficheros, cada objeto una sola vez, en el orden en que van al ZIP. */
  files: ArchiveZipEntry[];
  placements: Map<string, ArchiveZipPlacement>;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Qué ficheros lleva el ZIP y con qué nombre, con las facturas ya en el orden
 * del archivo: «recibidas/2026-03/R-2026-0153 F-123 Proveedor.pdf». Un Word
 * adjunto va con su «(copia).pdf»; de una división, el documento entero una
 * sola vez («(documento entero)»), donde cae su primera parte. Cada objeto
 * del almacenamiento va una vez, y dos rutas nunca coinciden (tampoco solo en
 * mayúsculas, que en Windows serían el mismo fichero).
 */
export function planArchiveZip(invoices: readonly ArchiveZipInvoice[]): ArchiveZipPlan {
  const files: ArchiveZipEntry[] = [];
  const pathByKey = new Map<string, string>();
  const taken = new Set<string>();
  const place = (file: ArchiveStoredFile, dir: string, name: string): string => {
    const placed = pathByKey.get(file.storageKey);
    if (placed) return placed;
    const ext = fileExtension(file.fileType);
    let path = `${dir}/${name}.${ext}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${dir}/${name} (${n}).${ext}`;
    taken.add(path.toLowerCase());
    pathByKey.set(file.storageKey, path);
    files.push({ ...file, path });
    return path;
  };

  const placements = new Map<string, ArchiveZipPlacement>();
  for (const invoice of invoices) {
    const dir = `${archiveZipFolder(invoice)}/${invoice.period.year}-${pad2(invoice.period.month)}`;
    const stem = archiveZipStem(invoice);
    const whole = invoice.splitRoot ?? invoice.own;
    const name = invoice.splitRoot ? `${stem} (documento entero)` : stem;
    if (invoice.otherFormat) {
      const original = place(invoice.otherFormat, dir, name);
      const copy = place(whole, dir, invoice.splitRoot ? `${stem} (documento entero, copia)` : `${stem} (copia)`);
      placements.set(invoice.invoiceId, { original, originalKey: invoice.otherFormat.storageKey, copy });
    } else {
      placements.set(invoice.invoiceId, { original: place(whole, dir, name), originalKey: whole.storageKey, copy: null });
    }
  }
  return { files, placements };
}

/** Lo que ocupan los ficheros del ZIP; lo que no tiene tamaño guardado
 *  cuenta como `unknownBytes`. */
export function archiveZipBytes(plan: ArchiveZipPlan, unknownBytes: number): number {
  return plan.files.reduce((sum, file) => sum + (file.sizeBytes ?? unknownBytes), 0);
}

// ── Comprobación de los originales ──────────────────────────────────────────

/** Lo que se leyó de un objeto al escribir el ZIP: su huella, o por qué falta. */
export type ArchiveFileRead = { sha256: string } | { missing: string };

/** Falta; no coincide con la huella que se guardó al subirlo; o el mismo
 *  objeto es el de otra factura (dos subidas antiguas con la misma clave). */
export type ArchiveFileProblem = "missing" | "hash" | "shared";

export type ArchiveOriginalCheck = { sha256: string | null; problems: ArchiveFileProblem[] };

const invoiceLabel = (invoice: Pick<ArchiveZipInvoice, "invoiceId" | "invoiceNumber">) =>
  invoice.invoiceNumber ? `nº ${invoice.invoiceNumber}` : `código ${invoice.invoiceId}`;

/**
 * Compara lo leído de cada objeto con la huella que se guardó al subirlo,
 * factura por factura y no por fichero: dos facturas antiguas con la misma
 * clave (subidas con el mismo nombre en el mismo milisegundo, antes de
 * uploadStorageKey) comparten un objeto, que solo puede ser el de una de
 * ellas. Fuera de una misma división, eso se avisa en las dos. Devuelve lo de
 * cada factura para el índice y las líneas de ERRORES.txt, en el orden del ZIP.
 */
export function checkArchiveFiles(
  invoices: readonly ArchiveZipInvoice[],
  plan: ArchiveZipPlan,
  read: ReadonlyMap<string, ArchiveFileRead>,
): { originals: Map<string, ArchiveOriginalCheck>; errors: string[] } {
  // Quién usa cada objeto, y con qué huella guardada.
  const uses = new Map<string, { invoice: ArchiveZipInvoice; expected: string | null }[]>();
  const addUse = (file: ArchiveStoredFile, invoice: ArchiveZipInvoice) =>
    uses.set(file.storageKey, [...(uses.get(file.storageKey) ?? []), { invoice, expected: file.fileHash }]);
  const originalOf = (invoice: ArchiveZipInvoice) => invoice.otherFormat ?? invoice.splitRoot ?? invoice.own;
  for (const invoice of invoices) {
    addUse(originalOf(invoice), invoice);
    // La copia en PDF de un Word.
    if (invoice.otherFormat) addUse(invoice.splitRoot ?? invoice.own, invoice);
  }

  const shaOf = (key: string) => {
    const result = read.get(key);
    return result && "sha256" in result ? result.sha256 : null;
  };
  const mismatch = (key: string, expected: string | null) => {
    const sha256 = shaOf(key);
    return expected != null && sha256 != null && expected.toLowerCase() !== sha256;
  };
  const shared = (key: string) =>
    new Set((uses.get(key) ?? []).map(({ invoice }) => invoice.splitRootId ?? invoice.invoiceId)).size > 1;

  const errors: string[] = [];
  for (const file of plan.files) {
    const result = read.get(file.storageKey) ?? { missing: "no se ha podido leer" };
    if ("missing" in result) {
      errors.push(`${file.path}\t${result.missing}`);
      continue;
    }
    const fileUses = uses.get(file.storageKey) ?? [];
    const isShared = shared(file.storageKey);
    if (isShared) {
      const names = [...new Set(fileUses.map(({ invoice }) => invoiceLabel(invoice)))];
      errors.push(`${file.path}\tes el mismo fichero guardado de varias facturas (${names.join(", ")}): se subieron con el mismo nombre y solo se conserva uno`);
    }
    const reported = new Set<string>();
    for (const { invoice, expected } of fileUses) {
      if (!mismatch(file.storageKey, expected)) continue;
      const who = isShared ? `${invoiceLabel(invoice)}: ` : "";
      if (reported.has(who + expected)) continue;
      reported.add(who + expected);
      errors.push(`${file.path}\t${who}la huella SHA-256 no coincide con la que se guardó al subirlo (guardada ${expected}; la del fichero del ZIP es ${result.sha256})`);
    }
  }

  const originals = new Map<string, ArchiveOriginalCheck>();
  for (const invoice of invoices) {
    const original = originalOf(invoice);
    const sha256 = shaOf(original.storageKey);
    const problems: ArchiveFileProblem[] = [];
    if (sha256 == null) problems.push("missing");
    else if (mismatch(original.storageKey, original.fileHash)) problems.push("hash");
    if (shared(original.storageKey)) problems.push("shared");
    originals.set(invoice.invoiceId, { sha256, problems });
  }
  return { originals, errors };
}

// ── Índice ──────────────────────────────────────────────────────────────────

/** «Original» del índice de la especificación, renombrada como en
 *  facturas.csv (anexo C10), y detrás, dónde está el papel (B-R12). */
export const ARCHIVE_INDEX_HEADERS = [
  "Nº de registro",
  "Periodo",
  "Tipo",
  "Estado",
  "Recibida el",
  "Fecha",
  "Nº de factura",
  "Tercero",
  "NIF",
  "Base",
  "Cuota IVA",
  "Retención",
  "Total",
  "Original electrónico o en papel",
  "Ubicación del papel",
  "Formato",
  "Fichero en el ZIP",
  "SHA-256",
  "Conservar hasta",
  "Avisos",
] as const;

/** La columna de la llegada en cada hoja: una emitida no se «recibe», se
 *  sube; las hojas que mezclan las dos lo dicen así. */
const ARRIVAL_HEADERS: Record<ArchiveZipFolder, string> = {
  recibidas: "Recibida el",
  emitidas: "Subida el",
  "sin-registrar": "Recibida o subida el",
  rechazadas: "Recibida o subida el",
};

/** Las cabeceras de una hoja del índice: ARCHIVE_INDEX_HEADERS con la llegada de esa hoja. */
export function archiveIndexHeaders(folder: ArchiveZipFolder): string[] {
  return ARCHIVE_INDEX_HEADERS.map((header) => (header === "Recibida el" ? ARRIVAL_HEADERS[folder] : header));
}

/** Ancho de cada columna del índice, en caracteres. */
export const ARCHIVE_INDEX_WIDTHS = [14, 14, 9, 16, 12, 11, 18, 32, 13, 12, 11, 11, 12, 28, 40, 22, 60, 66, 16, 50];

/** Texto (siempre texto), número (importe), fecha (sin hora) o vacío. */
export type ArchiveIndexCell = string | number | Date | null;

export const ARCHIVE_INDEX_SHEETS: Record<ArchiveZipFolder, string> = {
  recibidas: "Recibidas",
  emitidas: "Emitidas",
  "sin-registrar": "Sin registrar",
  rechazadas: "Rechazadas",
};

/** Lo que lleva una fila del índice. */
export type ArchiveIndexInput = {
  folder: ArchiveZipFolder;
  registerNumber: string | null;
  periodLabel: string;
  type: InvoiceType;
  status: InvoiceStatus;
  receivedAt: Date;
  invoiceDate: Date | null;
  invoiceNumber: string | null;
  thirdPartyName: string | null;
  thirdPartyCif: string | null;
  taxBase: number | null;
  vatAmount: number | null;
  irpfAmount: number | null;
  totalAmount: number | null;
  currency: string | null;
  medium: OriginalMedium | null;
  mediumReasonLabel: string | null;
  /** Dónde está el papel: «Caja 3 · Taco 37 · Pág. 28», «Lo guarda el cliente»… (B-R12). */
  location: string;
  /** El original en el ZIP: ruta, su huella calculada al pasar y sus
   *  problemas (checkArchiveFiles). */
  original: { fileType: string; path: string } & ArchiveOriginalCheck;
  /** El tipo de la copia en PDF de un Word (la que lee la app), si la hay. */
  copyFileType: string | null;
  retainUntil: Date | null;
  retentionHoldReason: RetentionHoldReason | null;
  /** Los avisos del archivo: Registrada tarde, Parte 2 de 3… */
  warnings: string[];
  rejectionReason: string | null;
};

const FORMAT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "Imagen JPG",
  "image/png": "Imagen PNG",
  "image/webp": "Imagen WEBP",
  "image/heic": "Imagen HEIC",
  "application/xml": "XML",
  "text/xml": "XML",
  "application/msword": "Word (.doc)",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.ms-excel": "Excel (.xls)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "application/vnd.oasis.opendocument.text": "OpenDocument (.odt)",
  "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument (.ods)",
  "application/rtf": "RTF",
};

/** «PDF», «XML», «Word (.docx), con copia en PDF». */
export function archiveFormatLabel(fileType: string, copyFileType: string | null): string {
  const label = FORMAT_LABELS[fileType] ?? fileExtension(fileType).toUpperCase();
  return copyFileType ? `${label}, con copia en ${FORMAT_LABELS[copyFileType] ?? fileExtension(copyFileType).toUpperCase()}` : label;
}

const MADRID_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });

/** El día de un momento en hora de Madrid, como fecha sin hora (00:00 UTC). */
export function dayInMadrid(value: Date): Date {
  return new Date(`${MADRID_DAY.format(value)}T00:00:00Z`);
}

const PROBLEM_WARNINGS: Record<ArchiveFileProblem, string> = {
  missing: "Falta el original: ver ERRORES.txt",
  hash: "El original no coincide con el que se subió: ver ERRORES.txt",
  shared: "El fichero guardado es el mismo que el de otra factura: ver ERRORES.txt",
};

/** Una fila del índice, en el orden de ARCHIVE_INDEX_HEADERS. */
export function archiveIndexRow(row: ArchiveIndexInput): ArchiveIndexCell[] {
  const warnings = [
    ...row.warnings,
    ...(row.status === "REJECTED" ? [row.rejectionReason ? `Rechazada: ${row.rejectionReason}` : "Rechazada"] : []),
    ...(row.currency && row.currency !== "EUR" ? [`Importes en ${row.currency}`] : []),
    ...row.original.problems.map((problem) => PROBLEM_WARNINGS[problem]),
  ];
  const medium = mediumLabel(row.medium);
  return [
    row.registerNumber,
    row.periodLabel,
    row.type === "SALE" ? "Emitida" : "Recibida",
    STATUS_LABELS[row.status] ?? row.status,
    dayInMadrid(row.receivedAt),
    row.invoiceDate,
    row.invoiceNumber,
    row.thirdPartyName,
    row.thirdPartyCif,
    row.taxBase,
    row.vatAmount,
    row.irpfAmount,
    row.totalAmount,
    row.medium == null && row.mediumReasonLabel ? `${medium} (${row.mediumReasonLabel})` : medium,
    row.location,
    archiveFormatLabel(row.original.fileType, row.copyFileType),
    row.original.path,
    row.original.sha256,
    row.retainUntil ?? `Sin fecha: conservar más${row.retentionHoldReason ? ` (${RETENTION_HOLD_LABELS[row.retentionHoldReason]})` : ""}`,
    warnings.join("; ") || null,
  ];
}

export type ArchiveIndexSheet = { name: string; rows: ArchiveIndexCell[][] };

/**
 * Las hojas del índice, cada una con su cabecera y sus facturas en el orden
 * en que llegan (el del archivo): Recibidas, Emitidas, Sin registrar (salvo
 * con «solo registradas») y, si se piden, Rechazadas.
 */
export function archiveIndexSheets(
  rows: readonly ArchiveIndexInput[],
  options: { onlyRegistered: boolean; includeRejected: boolean },
): ArchiveIndexSheet[] {
  const folders: ArchiveZipFolder[] = ["recibidas", "emitidas"];
  if (!options.onlyRegistered) folders.push("sin-registrar");
  if (options.includeRejected && !options.onlyRegistered) folders.push("rechazadas");
  return folders.map((folder) => ({
    name: ARCHIVE_INDEX_SHEETS[folder],
    rows: [archiveIndexHeaders(folder), ...rows.filter((row) => row.folder === folder).map(archiveIndexRow)],
  }));
}

// ── LEEME ───────────────────────────────────────────────────────────────────

export type ArchiveReadmeInput = {
  clientName: string;
  clientCif: string;
  /** «2026» o «2025-26». */
  fiscalYearLabel: string;
  /** «T2 (Abril – Junio 2026)», o null si es el ejercicio entero. */
  quarterLabel: string | null;
  onlyRegistered: boolean;
  includeRejected: boolean;
  /** dd/mm/aaaa hh:mm, en hora de Madrid. */
  generatedAt: string;
  invoiceCount: number;
  fileCount: number;
  errorCount: number;
  sheets: string[];
  /** Nº de los tacos enteros del cliente sin dividir ni anular en este periodo: sus facturas aún no existen. */
  pendingWholeTacos?: readonly number[];
};

/** «Hay 2 tacos enteros sin dividir en este ejercicio (T38, T41): sus facturas no están en el ZIP.» */
function pendingWholeTacosLines(numbers: readonly number[]): string[] {
  if (numbers.length === 0) return [];
  const list = numbers.map((n) => `T${n}`).join(", ");
  const lead = numbers.length === 1 ? "Hay 1 taco entero sin dividir" : `Hay ${numbers.length} tacos enteros sin dividir`;
  return [`  ${lead} en este ejercicio (${list}): sus facturas no están en el ZIP.`];
}

/**
 * El LEEME.txt del ZIP del ejercicio: qué es cada cosa y cómo comprobarla. Es
 * para el cliente o para una inspección: no lleva nombres ni correos del
 * personal de la asesoría.
 */
export function archiveReadme(r: ArchiveReadmeInput): string {
  const invoices = r.invoiceCount === 0
    ? ["  No hay facturas en este periodo: las hojas solo llevan la cabecera."]
    : [
      `  ${r.invoiceCount === 1 ? "La factura" : `Las ${r.invoiceCount} facturas`}, en el orden del archivo: primero por periodo de`,
      "  deducción y, dentro de cada periodo, las recibidas por orden de llegada y",
      "  las emitidas por fecha y número.",
    ];
  const files = r.fileCount === 0 ? "ningún fichero" : r.fileCount === 1 ? "1 fichero" : `${r.fileCount} ficheros`;
  const scope = [
    `Ejercicio ${r.fiscalYearLabel}`,
    r.quarterLabel,
    r.onlyRegistered ? "solo las facturas registradas" : "todas las facturas",
    r.includeRejected && !r.onlyRegistered ? "con las rechazadas" : null,
  ].filter(Boolean).join(" · ");
  const lines = [
    `Archivo de facturas de ${r.clientName} (CIF ${r.clientCif})`,
    scope,
    `Generado el ${r.generatedAt} con ${BRAND}.`,
    "",
    "Contenido",
    "---------",
    "",
    "indice.xlsx",
    ...invoices,
    `  Hojas: ${r.sheets.join(", ")}.`,
    "  «Fichero en el ZIP» dice dónde está el original de cada factura y «SHA-256»,",
    "  su huella.",
    "  Ubicación del papel: dónde está el papel en la asesoría (caja, taco y página),",
    "  si se devolvió al cliente o si lo guarda él.",
    ...pendingWholeTacosLines(r.pendingWholeTacos ?? []),
    "",
    "recibidas/ y emitidas/",
    "  Los originales de las facturas con nº de registro, por periodo de deducción",
    "  (AAAA-MM). Cada nombre empieza por su nº de registro (R-2026-0153 las",
    "  recibidas, E-2026-0012 las emitidas), seguido del nº de factura y del",
    "  tercero.",
    "",
  ];
  if (!r.onlyRegistered) {
    lines.push(
      "sin-registrar/",
      "  Las facturas que aún no se han exportado a la contabilidad, y por eso no",
      "  tienen nº de registro. Cada nombre empieza por SR- y el código de la",
      `  factura en ${BRAND}.`,
      "",
    );
  }
  if (r.includeRejected && !r.onlyRegistered) {
    lines.push(
      "rechazadas/",
      "  Las facturas rechazadas (ilegibles, duplicadas, de otro periodo…), que",
      "  también se conservan. El motivo está en el índice.",
      "",
    );
  }
  if (r.errorCount > 0) {
    lines.push(
      "ERRORES.txt",
      `  ${r.errorCount} original${r.errorCount === 1 ? "" : "es"} que falta${r.errorCount === 1 ? "" : "n"} o que no coincide${r.errorCount === 1 ? "" : "n"} con lo que se subió: la lista y el motivo.`,
      "",
    );
  }
  lines.push(
    "El nº de registro",
    "-----------------",
    "",
    `Es el nº de registro del archivo de facturas: ${BRAND} lo pone la primera vez`,
    "que la factura sale en un Excel para A3, correlativo por cliente, serie (R las",
    "recibidas, E las emitidas) y año del periodo de deducción. No es el nº que",
    "pone A3 al importar el Excel, y puede no coincidir con él: para cruzarlos,",
    "usad el nº de factura y el NIF del índice. «Registrada tarde» marca una",
    "factura que se exportó después que otras de periodos posteriores.",
    "",
    "Los originales",
    "--------------",
    "",
    `- Van tal como llegaron (${files}): PDF, imágenes, XML (factura`,
    "  electrónica) y, si se adjuntaron, Word, Excel, OpenDocument o RTF.",
    "- Un original en Word, Excel, OpenDocument o RTF va junto a su copia en PDF",
    "  («(copia).pdf»), que es la que se leyó.",
    "- Si un documento llevaba varias facturas y se dividió, va entero una sola",
    "  vez («(documento entero)»), y en el índice todas sus facturas apuntan a él.",
    "- «Original electrónico o en papel» dice si el original es electrónico o un",
    "  papel. Si es papel, el fichero es una copia escaneada: no es una",
    "  digitalización certificada, así que el papel se tiene que conservar.",
    "  «Por confirmar»: aún no se sabe si hay un papel detrás.",
    `- «Conservar hasta» es el cierre del ejercicio más ${RETENTION_MIN_YEARS} años (art. 30 del Código`,
    "  de Comercio); «conservar más» la deja sin fecha (inmovilizado, una",
    "  inspección…). Es orientativo: no sustituye a otros plazos que apliquen.",
    "",
    "Comprobar un original",
    "---------------------",
    "",
    `La huella SHA-256 del índice es la del fichero del ZIP, y ${BRAND} la ha`,
    "comparado con la que guardó al subirlo. Para comprobarla:",
    "  Windows:       certutil -hashfile \"fichero\" SHA256",
    "  Mac o Linux:   shasum -a 256 \"fichero\"",
    "",
    "Las fechas del índice son fechas de Excel; los importes, números en euros",
    "salvo que «Avisos» diga otra moneda. Los textos van siempre como texto: nada",
    "del índice se ejecuta como fórmula.",
    "",
    `Esta descarga no borra nada: el archivo sigue en ${BRAND}.`,
    "",
  );
  return lines.join("\r\n");
}

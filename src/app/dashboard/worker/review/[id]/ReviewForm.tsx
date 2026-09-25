"use client";

import { useState, useTransition, useEffect, useCallback, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  CheckCircle2, AlertTriangle, Save, ChevronLeft, ChevronRight, ChevronDown,
  Loader2, AlertCircle, ExternalLink, FileText, Image as ImageIcon,
  XCircle, RefreshCw, CheckCheck, Plus, Trash2,
  Globe, Scissors, Sparkles, Lock,
} from "lucide-react";
import { saveInvoiceFields, validateInvoice, rejectInvoice, deferInvoice, confirmThirdPartyName, type ReviewState } from "./actions";
import dynamic from "next/dynamic";
const SplitInvoiceModal = dynamic(() => import("./SplitInvoiceModal"), { ssr: false });
const SplitPdfModal = dynamic(() => import("./SplitPdfModal"), { ssr: false });
import type { Invoice, IssueType, IssueStatus } from "@prisma/client";
import {
  parseTaxId, isValidTaxIdWithPrefix,
  operationTypeLabel,
  OPERATION_TYPE_OPTIONS,
  OPERATION_TYPE_CODE,
  RETENTION_TYPE_LABEL,
  RETENTION_DEFAULT_RATE,
  INTRACOM_GOODS_TYPE_LABEL,
  equivalenceSurchargeRateForVat,
  taxIdWithCountry,
  type OperationTypeName,
  type RetentionTypeName,
  type IntracomGoodsTypeName,
} from "@/lib/validators";
import { dateMatchesPeriod, periodLabel, MONTH_NAMES, MONTH_OPTIONS, type PeriodTypeName } from "@/lib/period";
import { formatAmountEs, formatEur } from "@/lib/format";
import type { AppError } from "@/lib/errorCodes";
import { Select, type SelectOption } from "@/components/ui/Select";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { invoiceBalanceDiffCents } from "@/lib/invoiceBalance";
import { sanitizeAccountingAccountInput, padAccountingAccount } from "@/lib/accountingAccount";
import {
  isIntracomOperation,
  goodsTypeFromOperationType,
  goodsTypeFromSaleAccount,
  purchaseOperationTypeForGoods,
  saleAccountForGoodsType,
  initialIntracomGoods,
  goodsTypeQuestion,
  SALE_ACCOUNT_GROUP,
  type IntracomGoodsSourceName,
  type GoodsTypeScope,
} from "@/lib/intracomGoods";
import { isForeignCurrency } from "@/lib/currency";

const RETENTION_TYPE_OPTIONS: RetentionTypeName[] = ["PROFESSIONAL", "RENT"];

const RETENTION_SELECT_OPTIONS: SelectOption[] = [
  { value: "", label: "Sin retención" },
  ...RETENTION_TYPE_OPTIONS.map((rt) => ({ value: rt, label: RETENTION_TYPE_LABEL[rt] })),
];

const TYPE_OPTIONS: SelectOption[] = [
  { value: "PURCHASE", label: "Recibida (compra)" },
  { value: "SALE", label: "Emitida (venta)" },
];

const RECTIFICATIVE_TYPE_OPTIONS: SelectOption[] = [
  { value: "BY_DIFFERENCE", label: "1 · Por diferencias (solo el delta)" },
  { value: "BY_SUBSTITUTION", label: "2 · Por sustitución (anula y reemplaza)" },
];

/** Categorias de rechazo: el desplegable del rechazo y el aviso de una
 *  factura ya rechazada dicen lo mismo. */
const REJECT_CATEGORY_LABEL: Record<string, string> = {
  ILLEGIBLE: "Ilegible",
  INCOMPLETE: "Incompleta",
  WRONG_PERIOD: "Periodo incorrecto",
  DUPLICATE: "Duplicada",
  OTHER: "Otro",
};
const REJECT_CATEGORY_OPTIONS: SelectOption[] = [
  { value: "", label: "Categoría (opcional)" },
  ...Object.entries(REJECT_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
];

/** Texto de un error de las actions, venga con codigo o sin el. */
const errorText = (e: AppError | string) => (typeof e === "string" ? e : e.message);
import Link from "next/link";
import PdfViewer from "@/components/ui/PdfViewerDynamic";
import ImageViewer from "@/components/ui/ImageViewer";
import { OcrProcessingBanner } from "@/components/ui/OcrProcessingBanner";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { fieldPropsFromConfidence, ConfidenceHint } from "@/components/ui/SmartField";
import type { FieldBoundingBoxes } from "@/lib/boundingBoxes";
import { useReviewShortcuts } from "@/hooks/useReviewShortcuts";
import { useRouter } from "next/navigation";

type ExtractionData = {
  issuerName: string | null;
  issuerCif: string | null;
  receiverName: string | null;
  receiverCif: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  taxBase: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  irpfRate: number | null;
  irpfAmount: number | null;
  totalAmount: number | null;
  confidence: Record<string, number> | null;
  source: string;
  createdAt: string;
};

type IssueData = {
  id: string;
  type: IssueType;
  status: IssueStatus;
  description: string;
  field: string | null;
};

type SuggestedAccount = {
  supplierAccount: string;
  expenseAccount: string;
  defaultVatRate: number | null;
  name: string;
} | null;

type SessionContext = {
  clientName: string;
  clientCif: string;
  periodMonth: number;
  periodYear: number;
  type: "PURCHASE" | "SALE";
  /** Cliente minorista acogido a Recargo de Equivalencia — sus compras
   *  pueden llevar % y cuota de recargo ademas del IVA normal. */
  equivalenceSurchargeCustomer?: boolean;
};

/** Linea individual de IVA tal como la maneja el form (strings para
 *  permitir input vacio mientras escribe el usuario). */
type VatLineInput = {
  taxBase: string;
  vatRate: string;
  vatAmount: string;
  /** Recargo de equivalencia DE ESTA LINEA. "" = esta linea no lo lleva —
   *  no confundir con "0". Va por linea, no por factura. */
  equivalenceSurchargeRate: string;
  equivalenceSurchargeAmount: string;
};

/** Etiquetas legibles de los campos para el hint del visor PDF. */
const FIELD_LABELS: Record<string, string> = {
  issuerName:   "Nombre emisor",
  issuerCif:    "CIF emisor",
  receiverName: "Nombre receptor",
  receiverCif:  "CIF receptor",
  invoiceNumber:"Nº factura",
  invoiceDate:  "Fecha",
  taxBase:      "Base imponible",
  vatRate:      "% IVA",
  vatAmount:    "Cuota IVA",
  totalAmount:  "Total",
};

/** Tipos de IVA mas habituales en facturas espanolas. Se muestran como
 *  chips bajo el input %IVA y tienen atajos Alt+1/2/3. El gestor sigue
 *  pudiendo teclear cualquier valor (caso 5%, exenciones puntuales, etc). */
const VAT_RATE_SHORTCUTS = [21, 10, 4] as const;

// Los campos Decimal de Prisma se convierten a number en el Server Component
// antes de cruzar la frontera Server → Client. Redefinimos esos campos aquí.
type SerializedInvoice = Omit<
  Invoice,
  | "taxBase" | "vatRate" | "vatAmount" | "irpfRate" | "irpfAmount" | "retentionBase" | "totalAmount"
> & {
  taxBase:       number | null;
  vatRate:       number | null;
  vatAmount:     number | null;
  irpfRate:      number | null;
  irpfAmount:    number | null;
  retentionBase: number | null;
  totalAmount:   number | null;
};

type Props = {
  invoice: SerializedInvoice;
  /** Fecha del ultimo Excel en el que salio esta factura, o null si nunca se
   *  ha exportado. Corregir una ya exportada obliga a volver a exportarla. */
  exportedAt?: string | null;
  /** Salio en un Excel y se corrigio despues: A3 tiene el dato viejo. */
  pendingReexport?: boolean;
  /** Lineas de IVA iniciales (de InvoiceVatLine, o sintetizada desde los
   *  campos planos de la factura para datos legacy). Vacio si nunca se
   *  procesaron datos. El recargo de equivalencia va por linea: null =
   *  esa linea no lo lleva. */
  initialVatLines: {
    taxBase: number;
    vatRate: number;
    vatAmount: number;
    equivalenceSurchargeRate: number | null;
    equivalenceSurchargeAmount: number | null;
  }[];
  /** Anterior y siguiente del lote en cualquier estado (flechas). */
  prevId: string | null;
  nextId: string | null;
  /** Siguiente pendiente despues de esta: a donde van Validar, Rechazar y
   *  Posponer. */
  nextPendingId?: string | null;
  position: number;
  batchTotal: number;
  /** Facturas del lote ya terminadas (validadas, rechazadas, exportadas). */
  doneCount?: number;
  /** Pendientes que quedan en la cola actual (esta incluida si lo esta). */
  pendingInBucket?: number;
  /** El periodo contable de la factura esta cerrado: no se puede guardar. */
  periodClosed?: boolean;
  backHref: string;
  /** Listado de origen, para conservarlo al saltar a la siguiente. */
  back?: string | null;
  extraction: ExtractionData | null;
  issues: IssueData[];
  suggestedAccount?: SuggestedAccount;
  /** true si la cuenta sugerida se encontró por nombre (el NIF del tercero
   *  no era fiable) en vez de por NIF exacto. */
  accountMatchedByName?: boolean;
  /** true si hay una fila con este NIF pero a nombre de OTRO tercero: no se
   *  rellena nada y se avisa (dos proveedores que comparten numero). */
  accountNameMismatch?: boolean;
  /** Bienes/servicios asignado "siempre" a este tercero en el plan de cuentas.
   *  null si no hay nada o si la fila es de otro tercero. */
  thirdPartyGoodsType?: IntracomGoodsTypeName | null;
  /** Si se puede guardar esa asignacion (hay NIF o nombre y la fila no es de
   *  otro tercero). Sin esto no se pregunta al validar. */
  canRememberGoodsType?: boolean;
  boundingBoxes?: FieldBoundingBoxes;
  /** Querystring ya formada ("?bucket=clean" o ""), a pegar a las URLs de nav. */
  queueSuffix?: string;
  /** Bucket actual de la cola; se envia al server para calcular el siguiente. */
  bucket?: "clean" | "attention" | "all";
  /** Contexto de la "sesion de trabajo": cliente + periodo + tipo. Se muestra
   *  en cabecera para que el gestor sepa en que lote esta. */
  sessionContext?: SessionContext;
  /** Media historica de duracion del OCR en la firma (ms). Usada por
   *  el banner de "procesando" para mostrar una ETA realista. null si
   *  no hay historial todavia o la factura no esta en procesamiento. */
  avgOcrDurationMs?: number | null;
  /** Cuentas genéricas del cliente para facturas simplificadas (tickets sin
   *  datos). Si hay cuenta proveedor configurada, se muestra el botón "Usar
   *  cuenta genérica" que las vuelca a los campos de cuenta. */
  genericAccounts?: { supplier: string | null; expense: string | null };
};

// Convierte texto numérico del PDF (formato español) a número JS.
// Ejemplos: "180,00 EUR" → 180, "1.234,56 €" → 1234.56
function parseSpanishNumber(raw: string): number | null {
  let s = raw.replace(/[€$£]/g, "").replace(/EUR/gi, "").trim();
  if (s.includes(",") && s.includes(".")) {
    // "1.234,56" → miles=punto decimal=coma
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Para campos de importe: siempre 2 decimales ("180,00 EUR" → "180.00")
function toAmount(raw: string): string {
  const n = parseSpanishNumber(raw);
  return n !== null ? n.toFixed(2) : raw.trim();
}

// Para campos sin decimales forzados (% IVA: "21,00%" → "21")
function toNumeric(raw: string): string {
  const n = parseSpanishNumber(raw);
  return n !== null ? String(n) : raw.trim();
}

const MESES_ES: Record<string, string> = {
  enero:"01", febrero:"02", marzo:"03", abril:"04",
  mayo:"05", junio:"06", julio:"07", agosto:"08",
  septiembre:"09", octubre:"10", noviembre:"11", diciembre:"12",
};

// Intenta parsear texto de fecha del PDF a formato YYYY-MM-DD.
// Devuelve null si no reconoce el formato.
function toDateInput(raw: string): string | null {
  const s = raw.trim();
  // Ya en formato ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${y}-${m}-${d}`;
  }
  // "17 de mayo de 2025" o "17 mayo 2025"
  const textDate = s.toLowerCase().match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)(?:\s+de\s+|\s+)(\d{2,4})$/);
  if (textDate) {
    const mes = MESES_ES[textDate[2]];
    if (mes) {
      const d = textDate[1].padStart(2, "0");
      const y = textDate[3].length === 2 ? `20${textDate[3]}` : textDate[3];
      return `${y}-${mes}-${d}`;
    }
  }
  return null;
}

function fmt(v: unknown) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

export function ReviewForm({ invoice, exportedAt = null, pendingReexport = false, initialVatLines, prevId, nextId, nextPendingId = null, position, batchTotal, doneCount = 0, pendingInBucket = 0, periodClosed = false, backHref, back = null, extraction, issues, suggestedAccount, accountMatchedByName, accountNameMismatch = false, thirdPartyGoodsType = null, canRememberGoodsType = false, boundingBoxes, queueSuffix = "", bucket = "all", sessionContext, avgOcrDurationMs, genericAccounts }: Props) {
  const { success, error } = useToast();
  const isImage = invoice.fileType.startsWith("image/");
  const isPdf   = invoice.fileType === "application/pdf";
  const isXml   = invoice.fileType.includes("xml");

  // En que punto esta la factura. Con las flechas se llega tambien a las ya
  // terminadas, y la pantalla tiene que decir en cual se esta y ofrecer solo
  // lo que tiene sentido: una validada se corrige, no se vuelve a validar.
  const isValidated = invoice.status === "VALIDATED" || invoice.status === "EXPORTED";
  const isRejected  = invoice.status === "REJECTED";
  const isExported  = exportedAt != null;
  const isPending   = !isValidated && !isRejected;
  // Una exportada ya esta en A3: ni se rechaza ni se divide (el servidor
  // tambien lo impide).
  const canReject = !isExported && !isRejected;
  const canSplit  = !isExported && !isRejected;

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Form state — lineas de IVA dinamicas. Si no hay nada, una linea vacia
  // para que el gestor pueda empezar a teclear.
  const [vatLines, setVatLines] = useState<VatLineInput[]>(() => {
    if (initialVatLines.length === 0) {
      return [{ taxBase: "", vatRate: "", vatAmount: "", equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "" }];
    }
    return initialVatLines.map((l) => ({
      taxBase: String(l.taxBase),
      vatRate: String(l.vatRate),
      vatAmount: String(l.vatAmount),
      equivalenceSurchargeRate: l.equivalenceSurchargeRate != null ? String(l.equivalenceSurchargeRate) : "",
      equivalenceSurchargeAmount: l.equivalenceSurchargeAmount != null ? String(l.equivalenceSurchargeAmount) : "",
    }));
  });
  const [totalAmount, setTotalAmount] = useState(fmt(invoice.totalAmount));
  const [invoiceDateVal, setInvoiceDateVal] = useState(fmtDate(invoice.invoiceDate));
  // Bienes o servicios en intracomunitarias. Se decide al abrir, antes que el
  // tipo de operacion y la cuenta, porque los mueve: en compras es el 3 o el 8
  // y en ventas la cuenta de ingreso 700 o 705. Prioridad en initialIntracomGoods.
  const [intracomInit] = useState(() => {
    const direction = invoice.type === "SALE" ? "SALE" : "PURCHASE";
    const savedOperationType = (invoice.operationType as OperationTypeName | undefined) ?? "INTERIOR";
    const savedExpenseAccount = fmt(invoice.expenseAccount) || suggestedAccount?.expenseAccount || "";
    const locked = invoice.status === "VALIDATED" || invoice.status === "EXPORTED";
    const { goodsType, source } = initialIntracomGoods({
      direction,
      operationType: savedOperationType,
      saved: (invoice.intracomGoodsType as IntracomGoodsTypeName | null) ?? null,
      savedSource: (invoice.intracomGoodsSource as IntracomGoodsSourceName | null) ?? null,
      thirdParty: thirdPartyGoodsType,
      expenseAccount: savedExpenseAccount,
      locked,
    });
    const intracom = isIntracomOperation(direction, savedOperationType);
    return {
      goodsType,
      source,
      operationType: goodsType && intracom && direction === "PURCHASE"
        ? purchaseOperationTypeForGoods(goodsType)
        : savedOperationType,
      // Una factura ya validada se abre con su cuenta tal cual: si no cuadra con
      // bienes/servicios lo avisa el export, no se corrige sin que se vea.
      expenseAccount: goodsType && intracom && direction === "SALE" && !locked
        ? saleAccountForGoodsType(savedExpenseAccount, goodsType, false)
        : savedExpenseAccount,
    };
  });
  const [supplierAccountVal, setSupplierAccount] = useState(fmt(invoice.supplierAccount) || suggestedAccount?.supplierAccount || "");
  const [expenseAccountVal, setExpenseAccount]   = useState(intracomInit.expenseAccount);
  const [operationType, setOperationType] = useState<OperationTypeName>(intracomInit.operationType);
  const [intracomGoodsType, setIntracomGoodsType] = useState<IntracomGoodsTypeName | null>(intracomInit.goodsType);
  const [intracomGoodsSource, setIntracomGoodsSource] = useState<IntracomGoodsSourceName | null>(intracomInit.source);
  // Pregunta al validar: "NUEVO" (el tercero no tiene nada asignado) o
  // "CAMBIO" (tiene lo contrario de lo marcado).
  const [goodsQuestion, setGoodsQuestion] = useState<"NUEVO" | "CAMBIO" | null>(null);

  // Recargo de equivalencia: va por linea de IVA (ver vatLines), no aqui.
  // Solo relevante en compras de clientes minoristas acogidos a RE
  // (sessionContext.equivalenceSurchargeCustomer). Panel plegable, expandido
  // si ya venia con recargo en alguna linea.
  const [showSurchargePanel, setShowSurchargePanel] = useState<boolean>(
    initialVatLines.some((l) => l.equivalenceSurchargeRate != null),
  );

  // Tipo emitida/recibida — editable en la revisión. Si la factura se subió
  // como "No lo sé" (typeUnconfirmed), el OCR intentó detectarlo y aquí se
  // confirma o corrige. Cambiarlo conmuta qué lado es el cliente (lockedSide).
  const [type, setType] = useState<"PURCHASE" | "SALE">(
    invoice.type === "SALE" ? "SALE" : "PURCHASE",
  );

  const isIntracom = isIntracomOperation(type, operationType);
  // En compras el propio codigo ya dice bienes (3) o servicios (8).
  const goodsTypeShown: IntracomGoodsTypeName | null = !isIntracom
    ? null
    : type === "PURCHASE" ? goodsTypeFromOperationType(operationType) : intracomGoodsType;

  // Botones Bienes/Servicios: en compras cambian el codigo 3/8 y en ventas
  // ponen la cuenta de ingreso 700/705 (sustituyendo otra 7xx si la hubiera).
  const chooseGoodsType = (goods: IntracomGoodsTypeName) => {
    setIntracomGoodsType(goods);
    setIntracomGoodsSource("MANUAL");
    if (type === "PURCHASE") setOperationType(purchaseOperationTypeForGoods(goods));
    else setExpenseAccount((prev) => saleAccountForGoodsType(prev, goods, true));
  };

  // La "otra parte" (la que no es el cliente): emisor en compras,
  // receptor en ventas. Es el NIF por el que se busca y se aprende el
  // plan de cuentas.
  // Se lee del campo editable, no del valor guardado: si el gestor conmuta
  // el tipo, el guardado apunta al lado que ya no toca (en una emitida el
  // issuerCif es el propio cliente) y el aviso senalaria su propio NIF.

  // Retencion IRPF (Modelo 111 / 115). Si no hay tipo no aplica retencion.
  const [retentionType, setRetentionType] = useState<RetentionTypeName | "">(
    (invoice.retentionType as RetentionTypeName | null) ?? "",
  );
  const [retentionRate, setRetentionRate] = useState(fmt(invoice.irpfRate));
  const [retentionBase, setRetentionBase] = useState(fmt(invoice.retentionBase));

  // Factura rectificativa (abono / correccion). Auto-detectada si alguna
  // linea tiene importe negativo, o el gestor la marca manualmente.
  const [isRectificative, setIsRectificative] = useState<boolean>(
    Boolean(invoice.isRectificative),
  );
  const [rectifiedInvoiceSeries, setRectifiedInvoiceSeries] = useState(
    fmt(invoice.rectifiedInvoiceSeries),
  );
  const [rectifiedInvoiceNumber, setRectifiedInvoiceNumber] = useState(
    fmt(invoice.rectifiedInvoiceNumber),
  );
  const [rectificativeType, setRectificativeType] = useState<"BY_DIFFERENCE" | "BY_SUBSTITUTION">(
    (invoice.rectificativeType as "BY_DIFFERENCE" | "BY_SUBSTITUTION" | null) ?? "BY_DIFFERENCE",
  );
  const [art80Tres, setArt80Tres] = useState<boolean>(Boolean(invoice.art80Tres));

  // CIF del lado editable. Lo necesitamos en estado para detectar
  // colision con el CIF del cliente (lado bloqueado): si OCR puso el
  // CIF del cliente en los dos lados, o el gestor lo teclea por error,
  // estamos contabilizando una factura del cliente consigo mismo.
  // Para NIFs internacionales mostramos el prefijo de país (p.ej. "DE123456789")
  // para que el gestor lo vea claramente. La action parseTaxId lo volverá a separar.
  // Es el mismo helper que compone la columna E del Excel de A3: lo que el
  // gestor ve aqui es exactamente lo que acaba en el fichero.
  const [editableIssuerCif, setEditableIssuerCif] = useState(
    taxIdWithCountry(invoice.issuerCif, invoice.issuerCountry),
  );
  const [editableReceiverCif, setEditableReceiverCif] = useState(
    taxIdWithCountry(invoice.receiverCif, invoice.receiverCountry),
  );

  // NIF de la "otra parte" (la que no es el cliente): emisor en compras,
  // receptor en ventas. Es el NIF por el que se busca el plan de cuentas.
  const counterpartyNif = (type === "SALE" ? editableReceiverCif : editableIssuerCif).trim();

  // Lo asignado al tercero se cargo con el NIF y el sentido guardados. Si el
  // gestor los ha cambiado ya no vale: se pregunta como tercero nuevo, y el
  // servidor no pisa lo que tuviera asignado el otro tercero sin haberlo visto.
  const loadedDirection = invoice.type === "SALE" ? "SALE" : "PURCHASE";
  const loadedCounterpartyNif = loadedDirection === "SALE"
    ? taxIdWithCountry(invoice.receiverCif, invoice.receiverCountry)
    : taxIdWithCountry(invoice.issuerCif, invoice.issuerCountry);
  const counterpartyChanged = type !== loadedDirection
    || parseTaxId(counterpartyNif).clean !== parseTaxId(loadedCounterpartyNif).clean;
  const assignedGoodsType = counterpartyChanged ? null : thirdPartyGoodsType;
  // "Asignado siempre" solo mientras sea verdad: si se cambio el NIF o el
  // sentido, o al tercero se le asigno despues otra cosa (factura ya
  // validada), ni se enseña ni se guarda ese origen.
  const shownSource: IntracomGoodsSourceName | null =
    intracomGoodsSource === "TERCERO" && assignedGoodsType !== goodsTypeShown ? null : intracomGoodsSource;

  // Si la factura trae una moneda que no es euro, el gestor convierte los
  // importes a mano y la marca en euros. Solo se envia esa marca, nunca la
  // moneda leida al abrir: si el formulario se abrio mientras corria el OCR,
  // ese valor esta desfasado y al guardar borraria la que el OCR detecto.
  const [markedEuro, setMarkedEuro] = useState(false);
  const showForeignCurrency = isForeignCurrency(invoice.currency) && !markedEuro;

  // Estado de bloques plegables: Retencion y Rectificativa. Por defecto
  // plegados (uso poco frecuente); auto-expandidos si la factura ya
  // venia con esos campos rellenos (OCR los detecto o el gestor los
  // guardo antes). El gestor puede plegar/desplegar a mano.
  const [showRetentionPanel, setShowRetentionPanel] = useState<boolean>(
    Boolean(invoice.retentionType),
  );
  const [showRectificativePanel, setShowRectificativePanel] = useState<boolean>(
    Boolean(invoice.isRectificative),
  );
  // Periodo contable plegado por defecto: el caso comun es que coincida
  // con el de subida (ya visible en el strip superior). Se auto-expande
  // si el accountingPeriod difiere — entonces hay algo que el gestor
  // ya tocó y debe poder revisar/cambiar.
  const accountingDiffers =
    (invoice.accountingPeriodMonth !== null && invoice.accountingPeriodMonth !== invoice.periodMonth) ||
    (invoice.accountingPeriodYear !== null && invoice.accountingPeriodYear !== invoice.periodYear);
  const [showAccountingPanel, setShowAccountingPanel] = useState<boolean>(accountingDiffers);
  // En estado y no leido del DOM: con el desplegable propio, el id queda en
  // el boton y su .value no es el mes.
  const [accountingMonth, setAccountingMonth] = useState(String(invoice.accountingPeriodMonth ?? invoice.periodMonth));
  const [accountingYear, setAccountingYear] = useState(String(invoice.accountingPeriodYear ?? invoice.periodYear));
  const accountingDiffersNow =
    accountingMonth !== String(invoice.periodMonth) || accountingYear !== String(invoice.periodYear);
  // Los años de alrededor, mas los de la propia factura: una ya exportada de
  // hace años tiene que poder abrirse sin que el desplegable pierda su año.
  const accountingYearOptions: SelectOption[] = useMemo(() => {
    const actual = new Date().getFullYear();
    const years = new Set<number>([invoice.accountingPeriodYear ?? invoice.periodYear, invoice.periodYear]);
    for (let y = actual + 1; y >= actual - 4; y--) years.add(y);
    return [...years].sort((a, b) => b - a).map((y) => ({ value: String(y), label: String(y) }));
  }, [invoice.accountingPeriodYear, invoice.periodYear]);

  // Cuota retencion: derivada de base * % / 100. La calculamos en cada
  // render para evitar quedar desincronizada si el gestor cambia base o %.
  const retentionAmount = useMemo(() => {
    const b = parseFloat(retentionBase);
    const r = parseFloat(retentionRate);
    if (!retentionType || isNaN(b) || isNaN(r)) return 0;
    return Math.round((b * r)) / 100;
  }, [retentionBase, retentionRate, retentionType]);

  // Al cambiar el tipo, siempre actualizamos el % al default del nuevo
  // tipo (15 para Profesional, 19 para Arrendamiento). Si el gestor
  // tenia un % custom (ej. 7% nuevos autonomos), lo vuelve a teclear.
  // La base por defecto = suma de bases IVA si estaba vacia.
  const handleRetentionTypeChange = (value: string) => {
    if (value === "") {
      setRetentionType("");
      setRetentionRate("");
      setRetentionBase("");
      return;
    }
    const newType = value as RetentionTypeName;
    setRetentionType(newType);
    setRetentionRate(String(RETENTION_DEFAULT_RATE[newType]));
    if (!retentionBase) {
      const sumB = vatLines.reduce((s, l) => s + (parseFloat(l.taxBase) || 0), 0);
      if (sumB > 0) setRetentionBase(sumB.toFixed(2));
    }
  };

  // En facturas RECIBIDAS el cliente es el RECEPTOR, en EMITIDAS el EMISOR.
  // Esa parte queda bloqueada (read-only) porque la fija el sistema, pero
  // sin etiquetas adicionales — el fondo gris ya indica que no se edita.
  const lockedSide: "issuer" | "receiver" = type === "PURCHASE" ? "receiver" : "issuer";
  const lockedInputClass = "w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[13px] text-slate-600 cursor-not-allowed";

  // Conflicto de CIF: emisor == receptor (despues de normalizar). Tipicamente
  // pasa porque el OCR confunde los dos cuadros de la factura y pone el CIF
  // del cliente en ambos lados. Bloqueamos validar pero permitimos guardar
  // borrador para que el gestor corrija el lado editable.
  const cifConflict = useMemo(() => {
    const a = parseTaxId(editableIssuerCif).clean;
    const b = parseTaxId(editableReceiverCif).clean;
    return Boolean(a) && a === b;
  }, [editableIssuerCif, editableReceiverCif]);

  // Sin cuenta contable el boton de Validar no se pone verde — no bloquea
  // (el exportador a A3 ya avisa si falta), pero evita que parezca "todo
  // listo" cuando aun falta contabilizar. Pedido por un gestor.
  const accountsIncomplete = !supplierAccountVal.trim() || !expenseAccountVal.trim();

  const updateVatLine = (idx: number, field: keyof VatLineInput, value: string) => {
    setVatLines((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      // Auto-calculo de cuota cuando el usuario edita base o %.
      if (field === "taxBase" || field === "vatRate") {
        const b = parseFloat(field === "taxBase" ? value : copy[idx].taxBase);
        const r = parseFloat(field === "vatRate" ? value : copy[idx].vatRate);
        if (!isNaN(b) && !isNaN(r)) {
          copy[idx].vatAmount = (Math.round(b * r) / 100).toFixed(2);
        }
      }
      // La cuota de recargo depende de la base: si se corrige la base y no se
      // recalcula, queda el recargo de la base anterior y la factura descuadra
      // sin que se vea de donde viene.
      if (field === "taxBase" && copy[idx].equivalenceSurchargeRate !== "") {
        const b = parseFloat(value);
        const r = parseFloat(copy[idx].equivalenceSurchargeRate);
        if (!isNaN(b) && !isNaN(r)) {
          copy[idx].equivalenceSurchargeAmount = ((b * r) / 100).toFixed(2);
        }
      }
      // Idem para la cuota de recargo cuando se edita el % de recargo. Si se
      // borra el %, se borra la cuota: si no, se guardaba una cuota huerfana
      // y al recargar se le volvia a deducir el % (recargo fantasma).
      if (field === "equivalenceSurchargeRate") {
        const b = parseFloat(copy[idx].taxBase);
        const r = parseFloat(value);
        if (value.trim() === "") {
          copy[idx].equivalenceSurchargeAmount = "";
        } else if (!isNaN(b) && !isNaN(r)) {
          copy[idx].equivalenceSurchargeAmount = ((b * r) / 100).toFixed(2);
        }
      }
      return copy;
    });
  };

  const addVatLine = () => {
    setVatLines((prev) => [...prev, { taxBase: "", vatRate: "", vatAmount: "", equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "" }]);
  };

  // Lineas con el recargo abierto a mano. Un tipo de IVA sin recargo habitual
  // (5 %, o la linea aun sin %) no propone ningun valor, y la casilla se
  // quedaba muerta: se marcaba, no salia ningun campo y volvia a desmarcarse.
  const [openSurchargeLines, setOpenSurchargeLines] = useState<Set<number>>(new Set());

  const removeVatLine = (idx: number) => {
    if (vatLines.length === 1) return;
    setVatLines((prev) => prev.filter((_, i) => i !== idx));
    setOpenSurchargeLines((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); });
      return next;
    });
  };

  // Casilla de recargo de una linea: al marcarla se propone el mapeo
  // habitual segun el % de IVA de esa misma linea (21->5.2, 10->1.4,
  // 4->0.5); al desmarcarla se limpian ambos campos ("" = no lleva recargo,
  // no confundir con "0"). El gestor puede editar el valor propuesto o
  // ponerlo a 0 en lineas concretas (p.ej. portes).
  const toggleLineSurcharge = (idx: number, checked: boolean) => {
    setOpenSurchargeLines((prev) => {
      const next = new Set(prev);
      if (checked) next.add(idx); else next.delete(idx);
      return next;
    });
    setVatLines((prev) => {
      const copy = [...prev];
      if (!checked) {
        copy[idx] = { ...copy[idx], equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "" };
        return copy;
      }
      const rateNum = parseFloat(copy[idx].vatRate);
      const suggested = !isNaN(rateNum) ? equivalenceSurchargeRateForVat(rateNum) : null;
      const baseNum = parseFloat(copy[idx].taxBase);
      const suggestedAmount = suggested != null && !isNaN(baseNum)
        ? ((baseNum * suggested) / 100).toFixed(2)
        : "";
      copy[idx] = {
        ...copy[idx],
        equivalenceSurchargeRate: suggested != null ? String(suggested) : "",
        equivalenceSurchargeAmount: suggestedAmount,
      };
      return copy;
    });
  };

  const [saveState, setSaveState]         = useState<ReviewState>(null);
  const [validateState, setValidateState] = useState<ReviewState>(null);
  const [rejectState, setRejectState]     = useState<ReviewState>(null);
  const [isPendingSave, startSave]        = useTransition();
  const [isPendingValidate, startValidate]= useTransition();
  const [isPendingReject, startReject]    = useTransition();
  const [isPendingDefer, startDefer]      = useTransition();
  const [isPendingReprocess, startReprocess] = useTransition();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason]   = useState("");
  const [rejectCategory, setRejectCategory] = useState("");
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [showSplitPdfModal, setShowSplitPdfModal] = useState(false);
  const [activeField, setActiveField] = useState<string | null>(null);
  // Persiste el último campo enfocado aunque el usuario haga clic en el PDF
  // (el onBlur del panel derecho limpia activeField, pero este ref aguanta).
  const lastFocusedFieldRef = useRef<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const router = useRouter();

  const confidence = extraction?.confidence ?? null;

  // Sumas de las lineas de IVA. Cualquier linea con campos vacios cuenta
  // como 0 para no romper el semaforo mientras el usuario teclea.
  const vatTotals = useMemo(() => {
    let sumBase = 0;
    let sumAmount = 0;
    let sumSurcharge = 0;
    let anyFilled = false;
    for (const l of vatLines) {
      const b = parseFloat(l.taxBase);
      const a = parseFloat(l.vatAmount);
      const s = parseFloat(l.equivalenceSurchargeAmount);
      if (!isNaN(b)) { sumBase += b; anyFilled = true; }
      if (!isNaN(a)) { sumAmount += a; anyFilled = true; }
      if (!isNaN(s)) { sumSurcharge += s; }
    }
    return { sumBase, sumAmount, sumSurcharge, anyFilled };
  }, [vatLines]);

  // Math semaphore: Total = Σ Bases + Σ Cuotas + Σ Recargo - Retencion IRPF
  const totalNum   = parseFloat(totalAmount) || 0;
  const hasValues  = vatTotals.anyFilled && totalAmount;
  const balanceDiffCents = invoiceBalanceDiffCents({
    sumBase: vatTotals.sumBase,
    sumAmount: vatTotals.sumAmount,
    sumSurcharge: vatTotals.sumSurcharge,
    irpf: retentionAmount,
    total: totalNum,
  });
  const mathOk = hasValues ? balanceDiffCents === 0 : null;
  // Lo que suman las lineas, para ensenarlo junto al total cuando no cuadra.
  const calculado = vatTotals.sumBase + vatTotals.sumAmount + vatTotals.sumSurcharge - retentionAmount;

  // Aviso si la fecha de la factura no corresponde al periodo del lote.
  const periodMismatch = useMemo(() => {
    if (!invoiceDateVal) return false;
    const d = new Date(invoiceDateVal);
    if (isNaN(d.getTime())) return false;
    const invPeriodType = ((invoice as any).periodType ?? "MONTHLY") as PeriodTypeName;
    return !dateMatchesPeriod(d, invPeriodType, invoice.periodMonth, invoice.periodYear);
  }, [invoiceDateVal, invoice]);

  // Load signed URL
  useEffect(() => {
    fetch(`/api/invoices/${invoice.id}/preview`)
      .then((r) => r.json())
      .then((d) => { setPreviewUrl(d.url); setPreviewLoading(false); })
      .catch(() => setPreviewLoading(false));
  }, [invoice.id]);

  // Auto-foco en el primer campo dudoso al cargar la factura. Si todo es
  // de alta confianza, no robamos el foco (asi Enter valida directamente).
  useEffect(() => {
    if (!confidence) return;
    const order = [
      "issuerName", "issuerCif", "receiverName", "receiverCif",
      "invoiceNumber", "invoiceDate", "taxBase", "vatRate", "vatAmount", "totalAmount",
    ];
    const firstDubious = order.find((f) => {
      const s = confidence[f];
      return s == null || s < 0.92;
    });
    if (!firstDubious) return;
    // Pequeno delay para ganar al focus inicial del body.
    const timer = setTimeout(() => {
      const el = document.getElementById(firstDubious) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 50);
    return () => clearTimeout(timer);
  }, [invoice.id, confidence]);

  // Prefetch de la siguiente factura: cuando ya estamos viendo la actual,
  // pedimos la URL firmada de la siguiente y precargamos el archivo en
  // background. Asi al validar y saltar, el visor aparece al instante.
  // Pendiente: la siguiente es a la que lleva Validar. Ya terminada: la de
  // la flecha ">".
  const prefetchId = isPending ? nextPendingId : nextId;
  useEffect(() => {
    if (!prefetchId) return;
    // Esperar a que la actual termine de cargar; no robar banda a la cosa
    // que el usuario necesita ver ya.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/invoices/${prefetchId}/preview`);
        if (!res.ok) return;
        const d = await res.json();
        if (!d?.url) return;
        // <link rel="prefetch"> dispara la descarga del binario al cache
        // del navegador. Es seguro: si el usuario no llega a navegar, el
        // navegador libera el recurso al cabo de un rato.
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.as = d.fileType?.startsWith("image/") ? "image" : "fetch";
        link.href = d.url;
        link.crossOrigin = "anonymous";
        document.head.appendChild(link);
        return () => {
          document.head.removeChild(link);
        };
      } catch {
        /* ignore — el prefetch es oportunista */
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [prefetchId]);

  // Pega el texto seleccionado en el PDF en el último campo enfocado del form.
  const injectTextToField = useCallback((text: string) => {
    const field = lastFocusedFieldRef.current;
    if (!field || !text) return;
    const clean = text.trim();
    const numeric = toNumeric(clean);
    switch (field) {
      case "issuerCif":    setEditableIssuerCif(clean); break;
      case "receiverCif":  setEditableReceiverCif(clean); break;
      case "totalAmount":  setTotalAmount(toAmount(clean)); break;
      case "taxBase":      updateVatLine(0, "taxBase", toAmount(clean)); break;
      case "vatAmount":    updateVatLine(0, "vatAmount", toAmount(clean)); break;
      case "vatRate":      updateVatLine(0, "vatRate", toNumeric(clean)); break;
      case "invoiceDate": {
        const parsed = toDateInput(clean);
        if (parsed) setInvoiceDateVal(parsed);
        break;
      }
      default: {
        const el = document.getElementById(field) as HTMLInputElement | null;
        if (el && el.type !== "hidden" && !el.readOnly) el.value = clean;
      }
    }
    // Vuelve el foco al campo para confirmar visualmente la acción.
    setTimeout(() => document.getElementById(field)?.focus(), 0);
  }, [setEditableIssuerCif, setEditableReceiverCif, setTotalAmount, updateVatLine]);

  const buildFormData = useCallback((extra?: Record<string,string>) => {
    const fd = new FormData();
    fd.set("invoiceId",    invoice.id);
    fd.set("updatedAt",    new Date(invoice.updatedAt).toISOString());
    fd.set("type",         type);
    fd.set("issuerName",   (document.getElementById("issuerName")   as HTMLInputElement)?.value ?? "");
    fd.set("issuerCif",    (document.getElementById("issuerCif")    as HTMLInputElement)?.value ?? "");
    fd.set("receiverName", (document.getElementById("receiverName") as HTMLInputElement)?.value ?? "");
    fd.set("receiverCif",  (document.getElementById("receiverCif")  as HTMLInputElement)?.value ?? "");
    fd.set("invoiceNumber",(document.getElementById("invoiceNumber")as HTMLInputElement)?.value ?? "");
    fd.set("invoiceDate",  invoiceDateVal);
    // Lineas de IVA: serializadas como JSON. El server las reparte en
    // InvoiceVatLine y recalcula los totales denormalizados de Invoice.
    fd.set("vatLines", JSON.stringify(vatLines));
    fd.set("totalAmount",totalAmount);
    if (markedEuro) fd.set("currency", "EUR");
    fd.set("accountingPeriodMonth", accountingMonth);
    fd.set("accountingPeriodYear",  accountingYear);
    fd.set("supplierAccount", supplierAccountVal);
    fd.set("expenseAccount",  expenseAccountVal);
    fd.set("operationType", operationType);
    fd.set("intracomGoodsType", goodsTypeShown ?? "");
    fd.set("intracomGoodsSource", goodsTypeShown ? (shownSource ?? "") : "");
    // El recargo de equivalencia va incluido en vatLines (por linea), no
    // aparte: el fd.set("vatLines", ...) de mas arriba ya lo manda.
    fd.set("retentionType", retentionType);
    fd.set("retentionBase", retentionBase);
    fd.set("retentionRate", retentionRate);
    fd.set("retentionAmount", String(retentionAmount));
    fd.set("isRectificative", isRectificative ? "1" : "0");
    fd.set("rectifiedInvoiceSeries", rectifiedInvoiceSeries);
    fd.set("rectifiedInvoiceNumber", rectifiedInvoiceNumber);
    fd.set("rectificativeType", isRectificative ? rectificativeType : "");
    fd.set("art80Tres", isRectificative && art80Tres ? "1" : "0");
    fd.set("bucket", bucket);
    if (back) fd.set("back", back);
    if (extra) Object.entries(extra).forEach(([k,v]) => fd.set(k,v));
    return fd;
  }, [type, vatLines, totalAmount, markedEuro, invoiceDateVal, accountingMonth, accountingYear, supplierAccountVal, expenseAccountVal, operationType, goodsTypeShown, shownSource, retentionType, retentionBase, retentionRate, retentionAmount, isRectificative, rectifiedInvoiceSeries, rectifiedInvoiceNumber, rectificativeType, art80Tres, invoice.id, invoice.updatedAt, bucket, back]);

  const handleSave = () => {
    startSave(async () => {
      const res = await saveInvoiceFields(null, buildFormData());
      setSaveState(res);
      if (res?.error) {
        error(`No se han guardado los cambios: ${errorText(res.error)}`);
      } else {
        success("Cambios guardados");
      }
    });
  };

  const runValidate = (goodsTypeScope: GoodsTypeScope) => {
    setGoodsQuestion(null);
    startValidate(async () => {
      const res = await validateInvoice(null, buildFormData({
        nextId: nextPendingId ?? "",
        goodsTypeScope,
        goodsTypeAssignedSeen: assignedGoodsType ?? "",
      }));
      setValidateState(res);
      if (res?.error) {
        error(isValidated
          ? `No se ha guardado la corrección: ${errorText(res.error)}`
          : `No se ha podido validar: ${errorText(res.error)}`);
      } else {
        // Una ya validada no salta a otra: se queda en ella con la correccion.
        success(isValidated ? "Corrección guardada" : "Factura validada");
      }
    });
  };

  // En una intracomunitaria se pregunta antes si el tercero va siempre como
  // bienes o como servicios. Validar redirige a la siguiente factura, asi
  // que la respuesta tiene que viajar con la propia validacion.
  const handleValidate = () => {
    const question = goodsTypeQuestion({
      direction: type,
      operationType,
      goodsType: goodsTypeShown,
      thirdParty: assignedGoodsType,
      canRemember: counterpartyChanged ? Boolean(counterpartyNif) : canRememberGoodsType,
    });
    if (question) {
      setGoodsQuestion(question);
      return;
    }
    runValidate("");
  };

  // Si faltan cuentas contables el boton no llega a estar disabled (asi
  // puede capturar el click) pero tampoco valida: en vez de un texto en el
  // boton, resalta con un shake los campos de cuenta para que el aviso
  // salga de donde esta el problema.
  // Lo mismo cuando el importe no cuadra o el CIF es el del cliente: antes
  // Enter no hacia nada y el gestor no sabia por que.
  const shakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shake, setShake] = useState<"accounts" | "math" | "cif" | null>(null);
  const triggerShake = (target: "accounts" | "math" | "cif") => {
    if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
    setShake(null);
    requestAnimationFrame(() => {
      setShake(target);
      shakeTimeoutRef.current = setTimeout(() => setShake(null), 400);
    });
  };

  const attemptValidate = () => {
    if (isPendingValidate) return;
    if (periodClosed) {
      error("El periodo contable de esta factura está cerrado: hay que reabrirlo en Cierres para poder cambiarla.");
      return;
    }
    if (cifConflict) {
      triggerShake("cif");
      error("El CIF coincide con el del cliente: corrígelo antes de validar.");
      return;
    }
    if (mathOk === false) {
      triggerShake("math");
      error(`El importe no cuadra: hay ${formatEur(Math.abs(balanceDiffCents) / 100)} de diferencia.`);
      return;
    }
    if (accountsIncomplete) {
      triggerShake("accounts");
      return;
    }
    handleValidate();
  };

  const handleReject = () => {
    if (!rejectReason.trim()) return;
    startReject(async () => {
      const fd = new FormData();
      fd.set("invoiceId", invoice.id);
      fd.set("rejectionReason", rejectReason);
      if (rejectCategory) fd.set("rejectionCategory", rejectCategory);
      fd.set("nextId", nextPendingId ?? "");
      // Sin el bucket, rechazar en la cola de incidencias saltaba a la
      // siguiente de todo el lote.
      fd.set("bucket", bucket);
      if (back) fd.set("back", back);
      const res = await rejectInvoice(null, fd);
      setRejectState(res);
      if (res?.error) {
        error(typeof res.error === "string" ? res.error : res.error.message);
      } else {
        success("Factura rechazada");
        setShowRejectModal(false);
      }
    });
  };

  const handleDefer = () => {
    startDefer(async () => {
      const fd = new FormData();
      fd.set("invoiceId", invoice.id);
      fd.set("nextId", nextPendingId ?? "");
      fd.set("bucket", bucket);
      if (back) fd.set("back", back);
      const res = await deferInvoice(null, fd);
      // El action redirecciona en caso de exito; solo veremos retorno si hay error.
      if (res?.error) {
        error(typeof res.error === "string" ? res.error : res.error.message);
      }
    });
  };

  // El gestor confirma que la fila del plan de cuentas con este NIF es este
  // mismo tercero: se le pone el nombre de la factura y deja de avisar.
  // Se usa el nombre que hay en pantalla (puede haber corregido el del OCR sin
  // guardar); tras confirmar el aviso se oculta, porque la pagina lo sigue
  // comparando con el nombre guardado hasta que se guarde o valide.
  const [isPendingThirdPartyName, startThirdPartyName] = useTransition();
  const [thirdPartyNameConfirmed, setThirdPartyNameConfirmed] = useState(false);
  const handleConfirmThirdPartyName = () => {
    const nameInput = document.getElementById(type === "SALE" ? "receiverName" : "issuerName") as HTMLInputElement | null;
    const typedName = nameInput?.value.trim() ?? "";
    startThirdPartyName(async () => {
      const res = await confirmThirdPartyName(invoice.id, typedName);
      if (res?.error) {
        error(typeof res.error === "string" ? res.error : res.error.message);
      } else {
        setThirdPartyNameConfirmed(true);
        success("Nombre actualizado en el plan de cuentas");
        router.refresh();
      }
    });
  };

  const handleReprocess = () => {
    startReprocess(async () => {
      try {
        const res = await fetch(`/api/invoices/${invoice.id}/process`, { method: "POST" });
        if (res.ok) {
          success("OCR relanzado — recarga en unos segundos");
          setTimeout(() => window.location.reload(), 3000);
        } else {
          const data = await res.json();
          error(data.error ?? "Error al reprocesar");
        }
      } catch {
        error("Error de conexión al reprocesar");
      }
    });
  };

  const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-100";

  // Props de estilo + tabIndex en funcion de la confianza OCR de cada campo.
  // Campos "seguros" (score alto) reciben tabIndex={-1} y color apagado:
  // Tab los salta y el gestor va directo a los dudosos.
  const fp = (field: string) => fieldPropsFromConfidence(confidence?.[field] ?? null);

  // Atajos de teclado globales. Enter valida, R abre rechazo, D marca
  // duplicado, Ctrl/Cmd+S guarda borrador, Alt+Arrow navega, "?" abre ayuda.
  useReviewShortcuts({
    onValidate: () => { attemptValidate(); },
    // En una validada, Ctrl+S guarda la correccion (sin pasar por borrador).
    onSave: () => {
      if (isValidated) attemptValidate();
      else if (periodClosed) attemptValidate();
      else if (!isPendingSave) handleSave();
    },
    onReject: () => { if (canReject) setShowRejectModal(true); },
    onMarkDuplicate: () => {
      if (!canReject) return;
      setRejectCategory("DUPLICATE");
      setRejectReason((prev) => prev || "Factura duplicada");
      setShowRejectModal(true);
    },
    onNext: () => { if (nextId) router.push(`/dashboard/worker/review/${nextId}${queueSuffix}`); },
    onPrev: () => { if (prevId) router.push(`/dashboard/worker/review/${prevId}${queueSuffix}`); },
    onToggleHelp: () => setShowHelp((s) => !s),
    isBlocked: () => showRejectModal || showHelp || showSplitModal || showSplitPdfModal || goodsQuestion !== null,
  });

  // Etiqueta del bucket activo en la sesion. Ayuda al gestor a saber
  // "estoy en la cola de incidencias" vs "la de validacion rapida".
  const bucketLabel =
    bucket === "attention" ? "Con incidencias" :
    bucket === "clean" ? "Listas para validar" :
    null;

  // Progreso del lote: lo hecho, no la posicion. Con la posicion, volver
  // con "<" a la 5 bajaba la barra al 4 % aunque hubiera 30 validadas.
  const progressPct = batchTotal > 0 ? Math.round((doneCount / batchTotal) * 100) : 0;

  // Trimestral: "T3 2026", como en Lotes y en el resto de listados.
  const batchPeriodLabel = sessionContext
    ? periodLabel(invoice.periodType ?? "MONTHLY", sessionContext.periodMonth, sessionContext.periodYear)
    : null;

  // Titulo: lo que el gestor reconoce (numero y tercero), no el nombre del
  // fichero ("scan0042.pdf"), que queda en el tooltip.
  const savedThirdParty = invoice.type === "SALE" ? invoice.receiverName : invoice.issuerName;
  const headerTitle = [invoice.invoiceNumber, savedThirdParty].filter(Boolean).join(" · ") || invoice.filename;

  // El rechazo se cierra con Escape y pinchando fuera, pero solo si el clic
  // empezo fuera: al seleccionar texto del motivo y soltar fuera se cerraba.
  const rejectBackdropDown = useRef(false);
  const closeRejectModal = () => { setShowRejectModal(false); setRejectReason(""); };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <Link href={backHref} className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-700">
            <ChevronLeft className="h-4 w-4" />
            Volver
          </Link>
          <span className="text-slate-200">|</span>
          <span className="max-w-[360px] truncate text-[13px] font-semibold text-slate-800" title={invoice.filename}>
            {headerTitle}
          </span>
          {!isPending && (
            <InvoiceStatusBadge status={invoice.status} exported={isExported} pendingReexport={pendingReexport} />
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            title="Atajos de teclado (?)"
            className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
          >
            <kbd className="rounded bg-slate-100 px-1 text-[10px] font-semibold">?</kbd>
            atajos
          </button>
          {/* En una ya terminada (se llega con las flechas), el camino de
              vuelta a lo que queda por hacer. */}
          {!isPending && nextPendingId && (
            <Link
              href={`/dashboard/worker/review/${nextPendingId}${queueSuffix}`}
              className="flex h-7 items-center gap-1 rounded-lg bg-blue-50 px-2.5 text-[12px] font-medium text-blue-700 hover:bg-blue-100"
            >
              Siguiente pendiente
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
          <span className="text-[12px] text-slate-400 tabular-nums">{position} de {batchTotal}</span>
          {prevId ? (
            <Link href={`/dashboard/worker/review/${prevId}${queueSuffix}`} prefetch
              title="Factura anterior del lote (Alt+←)" aria-label="Factura anterior del lote"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <button disabled title="Es la primera factura del lote" aria-label="Es la primera factura del lote"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-100 text-slate-200">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {nextId ? (
            <Link href={`/dashboard/worker/review/${nextId}${queueSuffix}`} prefetch
              title="Factura siguiente del lote (Alt+→)" aria-label="Factura siguiente del lote"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <button disabled title="Es la última factura del lote" aria-label="Es la última factura del lote"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-100 text-slate-200">
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Session strip: contexto del lote + progreso visual. Solo se renderiza
          si venimos de un lote (sessionContext disponible) para no mostrar
          nada en accesos directos. */}
      {sessionContext && batchTotal > 0 && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-2">
          <div className="flex items-center gap-2 text-[12px] text-slate-600">
            <span className="font-semibold text-slate-700">{sessionContext.clientName}</span>
            {/* CIF del cliente al lado del nombre — asi el bloque del lado
                bloqueado (Receptor en PURCHASE, Emisor en SALE) ya no hace
                falta en el form. */}
            <span className="font-mono text-[10px] text-slate-400">{sessionContext.clientCif}</span>
            <span className="text-slate-300">·</span>
            <span>{batchPeriodLabel}</span>
            <span className="text-slate-300">·</span>
            <span>{type === "PURCHASE" ? "Recibidas" : "Emitidas"}</span>
            {bucketLabel && (
              <>
                <span className="text-slate-300">·</span>
                <span className={
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold " +
                  (bucket === "attention"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-blue-100 text-blue-700")
                }>
                  {bucketLabel}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-1 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className={
                  "h-full transition-all " +
                  (progressPct === 100 ? "bg-green-500" : "bg-blue-500")
                }
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="whitespace-nowrap text-[11px] font-medium text-slate-500 tabular-nums">
              {doneCount} de {batchTotal} hechas · {pendingInBucket === 0 ? "ninguna por revisar" : `${pendingInBucket} por revisar`}
            </span>
          </div>
        </div>
      )}

      {/* Split panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT — file viewer */}
        <div className="flex w-[55%] min-h-0 flex-col border-r border-slate-200 bg-slate-50 overflow-hidden">
          {previewLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
            </div>
          ) : previewUrl && !isXml ? (
            isImage ? (
              <ImageViewer
                url={previewUrl}
                alt={invoice.filename}
                activeBox={activeField ? (boundingBoxes?.[activeField] ?? null) : null}
              />
            ) : (
              <PdfViewer
                url={previewUrl}
                fieldValues={{
                  issuerName:    invoice.issuerName,
                  issuerCif:     invoice.issuerCif,
                  receiverName:  invoice.receiverName,
                  receiverCif:   invoice.receiverCif,
                  invoiceNumber: invoice.invoiceNumber,
                  invoiceDate:   invoice.invoiceDate
                    ? new Date(invoice.invoiceDate).toISOString().slice(0, 10)
                    : null,
                  taxBase:     invoice.taxBase,
                  vatRate:     invoice.vatRate,
                  vatAmount:   invoice.vatAmount,
                  totalAmount: invoice.totalAmount,
                }}
                activeFieldId={activeField}
                activeBox={activeField ? (boundingBoxes?.[activeField] ?? null) : null}
                onTextSelect={injectTextToField}
                copyTargetLabel={lastFocusedFieldRef.current ? FIELD_LABELS[lastFocusedFieldRef.current] : undefined}
              />
            )
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
              {isXml ? <FileText className="h-12 w-12" /> : <ImageIcon className="h-12 w-12" />}
              <p className="text-[13px]">{isXml ? "Archivo XML — datos extraídos automáticamente" : "Vista previa no disponible"}</p>
              {previewUrl && (
                <a href={previewUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Abrir archivo
                </a>
              )}
            </div>
          )}
        </div>

        {/* RIGHT — extracted data form */}
        <div
          className="flex w-[45%] flex-col overflow-y-auto bg-white"
          onFocus={(e) => {
            const id = (e.target as HTMLElement).id;
            if (id) lastFocusedFieldRef.current = id;
            if (id) setActiveField(id);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setActiveField(null);
            }
          }}
          // La rueda sobre un importe enfocado lo cambiaba (21 -> 20,99) al
          // desplazar el panel. Se suelta el foco y la rueda solo desplaza.
          onWheel={(e) => {
            const el = e.target as HTMLElement;
            if (el instanceof HTMLInputElement && el.type === "number" && document.activeElement === el) el.blur();
          }}
        >
          <div className="flex-1 px-4 py-3 space-y-2.5">

            {periodClosed && (
              <div className="flex items-start gap-2.5 rounded-xl bg-slate-100 px-4 py-3 text-slate-700">
                <Lock className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1 text-[12px]">
                  <p className="font-medium">Periodo cerrado</p>
                  <p className="mt-0.5">
                    No se puede cambiar esta factura. Si hay que corregirla, un administrador tiene que reabrir el periodo en Cierres.
                  </p>
                </div>
              </div>
            )}

            {isValidated && !isExported && (
              <div className="flex items-start gap-2.5 rounded-xl bg-green-50 px-4 py-3 text-green-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1 text-[12px]">
                  <p className="font-medium">Factura ya validada</p>
                  <p className="mt-0.5">
                    Si corriges algo, pulsa «Guardar corrección»: sigue validada con los cambios.
                  </p>
                </div>
              </div>
            )}

            {isRejected && (
              <div className="flex items-start gap-2.5 rounded-xl bg-red-50 px-4 py-3 text-red-800">
                <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1 text-[12px]">
                  <p className="font-medium">
                    Factura rechazada
                    {invoice.rejectionCategory && REJECT_CATEGORY_LABEL[invoice.rejectionCategory]
                      ? ` · ${REJECT_CATEGORY_LABEL[invoice.rejectionCategory]}`
                      : ""}
                  </p>
                  {invoice.rejectionReason && (
                    <p className="mt-0.5">Motivo: {invoice.rejectionReason}</p>
                  )}
                  <p className="mt-0.5 text-red-700/80">Si la validas, deja de estar rechazada.</p>
                </div>
              </div>
            )}

            {/* Ya exportada: el gestor tiene que saber que lo que corrija
                aqui NO esta en A3 hasta que se vuelva a exportar. */}
            {exportedAt && (
              <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1 text-[12px]">
                  <p className="font-medium">
                    {pendingReexport
                      ? `Exportada el ${new Date(exportedAt).toLocaleDateString("es-ES")} y corregida después`
                      : `Ya exportada el ${new Date(exportedAt).toLocaleDateString("es-ES")}`}
                  </p>
                  <p className="mt-0.5">
                    {pendingReexport
                      ? "A3 tiene todavía los datos anteriores: vuelve a exportarla para que le lleguen las correcciones, y allí corrige el asiento o bórralo antes de importarla otra vez."
                      : "Si corriges algo que va al Excel, la factura vuelve a entrar en la próxima exportación. En A3 tendrás que corregir el asiento o borrarlo antes de volver a importarla."}
                  </p>
                </div>
              </div>
            )}

            {/* Moneda extranjera: A3 solo admite euros y la validacion
                matematica no lo detecta (la factura cuadra en su moneda). */}
            {showForeignCurrency && (
              <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="flex-1 text-[12px]">
                  <p className="font-medium">Importes en {invoice.currency}</p>
                  <p className="mt-0.5">
                    A3 solo admite euros. Convierte la base, las cuotas y el total a euros y después marca la factura en euros.
                  </p>
                  <button
                    type="button"
                    onClick={() => setMarkedEuro(true)}
                    className="mt-2 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100"
                  >
                    Ya están en euros
                  </button>
                </div>
              </div>
            )}

            {/* OCR procesando: factura recien subida o en analisis activo.
                Se auto-refresca cada 3s para mostrar el form en cuanto
                Document AI devuelva. */}
            {(invoice.status === "UPLOADED" || invoice.status === "ANALYZING") && (
              <OcrProcessingBanner
                startedAt={invoice.createdAt}
                avgDurationMs={avgOcrDurationMs ?? undefined}
              />
            )}

            {/* OCR Error banner — parsea el codigo si lo trae prefijado
                "[ERR-OCR-XXX] mensaje" y lo muestra como chip. */}
            {invoice.status === "OCR_ERROR" && (() => {
              const raw = invoice.lastOcrError ?? "";
              const codeMatch = raw.match(/^\[(ERR-[A-Z]+-\d+)\]\s*(.*)/);
              const code = codeMatch?.[1];
              const techMsg = codeMatch?.[2] ?? raw;
              return (
                <div className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-red-700">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium">Error en el procesamiento OCR</p>
                      {techMsg && (
                        <p className="text-[11px] text-red-500 mt-0.5 truncate">{techMsg}</p>
                      )}
                      {code && (
                        <code className="mt-1 inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-red-700">
                          {code}
                        </code>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleReprocess}
                    disabled={isPendingReprocess}
                    className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {isPendingReprocess ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Reprocesar
                  </button>
                </div>
              );
            })()}

            {/* Errors — un solo ErrorBox para los tres actions. */}
            {(saveState?.error || validateState?.error || rejectState?.error) && (
              <ErrorBox
                error={saveState?.error ?? validateState?.error ?? rejectState?.error!}
              />
            )}

            {/* ── Cabecera 2 columnas: parte editable + datos factura ──────
                El lado bloqueado (datos del cliente: nombre + CIF) ya
                vive arriba en el strip de sesion — quitamos su bloque
                para reducir scroll. Los hidden inputs llevan los
                valores que parseAndSave espera del lado bloqueado
                (de todas formas los fuerza al cliente, pero los
                enviamos para no romper buildFormData). */}
            <input
              key={`locked-name-${lockedSide}`}
              type="hidden"
              id={lockedSide === "issuer" ? "issuerName" : "receiverName"}
              defaultValue={lockedSide === "issuer" ? (invoice.issuerName ?? "") : (invoice.receiverName ?? "")}
            />
            <input
              key={`locked-cif-${lockedSide}`}
              type="hidden"
              id={lockedSide === "issuer" ? "issuerCif" : "receiverCif"}
              defaultValue={lockedSide === "issuer" ? (invoice.issuerCif ?? "") : (invoice.receiverCif ?? "")}
            />

            <div className="grid grid-cols-2 gap-2.5">
              {/* Lado editable: Emisor en PURCHASE, Receptor en SALE.
                  Es siempre la "otra parte" — la que NO es el cliente. El key
                  por lockedSide fuerza remontar los inputs al cambiar el tipo,
                  así el campo no controlado (nombre) se resetea al lado nuevo. */}
              <fieldset key={`editable-${lockedSide}`} className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {lockedSide === "receiver" ? "Emisor" : "Receptor"}
                </legend>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Nombre / razón social
                    <ConfidenceHint score={confidence?.[lockedSide === "receiver" ? "issuerName" : "receiverName"] ?? null} />
                  </label>
                  {lockedSide === "receiver" ? (
                    <input id="issuerName" {...fp("issuerName")} defaultValue={invoice.issuerName ?? ""} />
                  ) : (
                    <input id="receiverName" {...fp("receiverName")} defaultValue={invoice.receiverName ?? ""} />
                  )}
                </div>
                <div className={shake === "cif" ? "animate-shake" : undefined}>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    CIF / NIF
                    <ConfidenceHint score={confidence?.[lockedSide === "receiver" ? "issuerCif" : "receiverCif"] ?? null} />
                  </label>
                  {lockedSide === "receiver" ? (
                    <input
                      id="issuerCif"
                      {...fp("issuerCif")}
                      value={editableIssuerCif}
                      onChange={(e) => setEditableIssuerCif(e.target.value)}
                      placeholder="B12345678"
                    />
                  ) : (
                    <input
                      id="receiverCif"
                      {...fp("receiverCif")}
                      value={editableReceiverCif}
                      onChange={(e) => setEditableReceiverCif(e.target.value)}
                      placeholder="B12345678"
                    />
                  )}
                  {(() => {
                    const v = lockedSide === "receiver" ? editableIssuerCif : editableReceiverCif;
                    return v && !isValidTaxIdWithPrefix(v) ? (
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-orange-600">
                        <AlertTriangle className="h-3 w-3" />
                        CIF/NIF con formato inválido
                      </p>
                    ) : null;
                  })()}
                  {cifConflict && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-red-600">
                      <AlertTriangle className="h-3 w-3" />
                      Coincide con el CIF del cliente — revisa el OCR
                    </p>
                  )}
                </div>
              </fieldset>

              {/* Datos factura: N + Fecha + Tipo de operacion. En la
                  columna derecha, al lado del Emisor/Receptor. */}
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Factura
                </legend>
                <div>
                  <label htmlFor="invoiceType" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Tipo
                    {invoice.typeUnconfirmed && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700">
                        <AlertTriangle className="h-2.5 w-2.5" /> Por confirmar
                      </span>
                    )}
                  </label>
                  <Select
                    id="invoiceType"
                    size="xs"
                    options={TYPE_OPTIONS}
                    value={type}
                    onChange={(value) => {
                      const next = value as "PURCHASE" | "SALE";
                      setType(next);
                      // Una intracomunitaria sigue siendolo al cambiar de
                      // sentido: en compras bienes/servicios es el 3 o el 8 y
                      // en ventas siempre el 3. Cualquier otro tipo que no
                      // exista en el otro sentido se rechazaria al guardar.
                      if (isIntracom && goodsTypeShown) {
                        setIntracomGoodsType(goodsTypeShown);
                        setOperationType(next === "PURCHASE" ? purchaseOperationTypeForGoods(goodsTypeShown) : "INTRACOM");
                      } else if (!OPERATION_TYPE_OPTIONS[next].includes(operationType)) {
                        setOperationType(OPERATION_TYPE_OPTIONS[next][0]);
                      }
                    }}
                  />
                  {invoice.typeUnconfirmed && (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Tipo sin determinar automáticamente — indica si es emitida o recibida.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="invoiceNumber" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Nº factura
                    <ConfidenceHint score={confidence?.invoiceNumber ?? null} />
                  </label>
                  <input id="invoiceNumber" {...fp("invoiceNumber")} defaultValue={invoice.invoiceNumber ?? ""} />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Fecha
                    <ConfidenceHint score={confidence?.invoiceDate ?? null} />
                  </label>
                  <input
                    id="invoiceDate"
                    type="date"
                    {...fp("invoiceDate")}
                    value={invoiceDateVal}
                    onChange={(e) => setInvoiceDateVal(e.target.value)}
                  />
                  {periodMismatch && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                      Fecha fuera del periodo del lote ({periodLabel(
                        ((invoice as any).periodType ?? "MONTHLY") as PeriodTypeName,
                        invoice.periodMonth,
                        invoice.periodYear,
                      )})
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="operationType" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Tipo de operación
                    {operationType !== "INTERIOR" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700">
                        <Globe className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </label>
                  <Select
                    id="operationType"
                    size="xs"
                    value={operationType}
                    options={(OPERATION_TYPE_OPTIONS[type].includes(operationType)
                      ? OPERATION_TYPE_OPTIONS[type]
                      : [...OPERATION_TYPE_OPTIONS[type], operationType]
                    ).map((op) => ({ value: op, label: `${OPERATION_TYPE_CODE[op]} · ${operationTypeLabel(op, type)}` }))}
                    onChange={(value) => {
                      const next = value as OperationTypeName;
                      setOperationType(next);
                      // Elegir 3 u 8 en una compra es marcar bienes o servicios a mano.
                      if (type === "PURCHASE" && isIntracomOperation("PURCHASE", next)) {
                        setIntracomGoodsType(goodsTypeFromOperationType(next));
                        setIntracomGoodsSource("MANUAL");
                      }
                      // Venta que pasa a intracomunitaria sin clasificar: si
                      // ya tiene una 700/705, esa cuenta lo dice.
                      if (type === "SALE" && next === "INTRACOM" && !intracomGoodsType) {
                        const fromAccount = goodsTypeFromSaleAccount(expenseAccountVal);
                        if (fromAccount) {
                          setIntracomGoodsType(fromAccount);
                          setIntracomGoodsSource("CUENTA");
                        }
                      }
                    }}
                  />
                </div>
              </fieldset>
            </div>

            {/* Intracomunitarias: bienes o servicios. En compras mueve el
                código 3/8 y en ventas la cuenta de ingreso 700/705. Se enseña
                de dónde sale para que el gestor sepa qué comprobar.
                Fuera del grid para no romper alturas, igual que el aviso. */}
            {isIntracom && (() => {
              const party = type === "SALE" ? "cliente" : "proveedor";
              const label = goodsTypeShown ? INTRACOM_GOODS_TYPE_LABEL[goodsTypeShown] : "";
              const status = !goodsTypeShown
                ? { tone: "bg-amber-50 text-amber-800", icon: <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Sin marcar: indica si son bienes o servicios antes de validar.</> }
                : shownSource === "TERCERO"
                  ? { tone: "bg-green-50 text-green-700", icon: <CheckCheck className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Asignado siempre a este {party}: <strong>{label}</strong></> }
                  : shownSource === "IA"
                    ? { tone: "bg-blue-50 text-blue-700", icon: <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Detectado por la IA: <strong>{label}</strong>. Compruébalo en la factura.</> }
                    : shownSource === "CUENTA"
                      ? { tone: "bg-blue-50 text-blue-700", icon: <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Según la cuenta de ingreso: <strong>{label}</strong></> }
                      : shownSource === "MANUAL"
                        ? { tone: "bg-slate-100 text-slate-700", icon: <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Marcado a mano: <strong>{label}</strong></> }
                        : { tone: "bg-amber-50 text-amber-800", icon: <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />, text: <>Sin detectar: está como <strong>{label}</strong>. Compruébalo en la factura.</> };
              return (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      ¿Bienes o servicios?
                    </span>
                    <div className="flex gap-1.5" role="group" aria-label="Bienes o servicios">
                      {(["BIENES", "SERVICIOS"] as IntracomGoodsTypeName[]).map((g) => (
                        <button
                          key={g}
                          type="button"
                          aria-pressed={goodsTypeShown === g}
                          onClick={() => chooseGoodsType(g)}
                          className={
                            "rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-accent-100 " +
                            (goodsTypeShown === g
                              ? "bg-blue-600 text-white shadow-sm"
                              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                          }
                        >
                          {INTRACOM_GOODS_TYPE_LABEL[g]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] ${status.tone}`}>
                    {status.icon}
                    <span>{status.text}</span>
                  </p>
                  {goodsTypeShown && (
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      En A3: tipo de operación {OPERATION_TYPE_CODE[operationType]}
                      {type === "SALE" && <> y cuenta de ingreso {expenseAccountVal || SALE_ACCOUNT_GROUP[goodsTypeShown]}</>}.
                    </p>
                  )}
                  {assignedGoodsType && goodsTypeShown && assignedGoodsType !== goodsTypeShown && (
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-600">
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                      Este {party} está asignado siempre como {INTRACOM_GOODS_TYPE_LABEL[assignedGoodsType].toLowerCase()}: al validar se te preguntará si es una excepción.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Aviso ISP/intracom — fuera del grid para no romper alturas. */}
            {operationType !== "INTERIOR" && operationType !== "AGRARIA"
              && operationType !== "IVA_NO_DEDUCIBLE"
              && vatTotals.sumAmount > 0.01 && (
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                {operationType === "INTRACOM" || operationType === "INTRACOM_SERVICIOS" ? (
                  <>
                    Operación intracomunitaria con IVA declarado: estas operaciones suelen ir con IVA 0%. Revisa el desglose antes de exportar.
                    <button
                      type="button"
                      onClick={() => setVatLines((prev) => prev.map((l) => ({ ...l, vatRate: "0", vatAmount: "0" })))}
                      className="ml-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-100"
                    >
                      Poner IVA a 0%
                    </button>
                  </>
                ) : (
                  <>Las facturas de tipo &quot;{operationTypeLabel(operationType, type)}&quot; suelen ir sin IVA en factura (inversión del sujeto pasivo). Revisa el desglose.</>
                )}
              </p>
            )}

            {/* Venta intracomunitaria sin cuenta de ingreso: el plan de cuentas
                puede tener solo la cuenta de cliente (43x). Al marcar bienes o
                servicios se pone la 700 o la 705. */}
            {type === "SALE" && operationType === "INTRACOM" && !expenseAccountVal && (
              <p className="flex items-center gap-1 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                Venta intracomunitaria sin cuenta de ingreso: marca bienes (700) o servicios (705) y se pondrá sola.
              </p>
            )}

            {/* Factura rectificativa (abono / correccion).
                Plegada por defecto (uso poco frecuente). El header es
                clicable y muestra un badge cuando esta activa, asi
                desde fuera se ve si la factura es rectificativa sin
                tener que abrir. */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setShowRectificativePanel((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Factura rectificativa
                  </span>
                  {isRectificative && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700">
                      Activa
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${
                    showRectificativePanel ? "rotate-0" : "-rotate-90"
                  }`}
                />
              </button>
              {showRectificativePanel && (
                <div className="space-y-2 border-t border-slate-100 p-3 pt-2">
                  <label className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 cursor-pointer">
                    <div className="flex flex-col">
                      <span className="text-[12px] font-medium text-slate-700">
                        Es una rectificativa (abono o corrección)
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Detección automática si el OCR encuentra líneas con importe negativo
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={isRectificative}
                      onChange={(e) => setIsRectificative(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-accent-400"
                    />
                  </label>

                  {isRectificative && (
                    <div className="space-y-2 border-l-2 border-amber-200 pl-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-500">
                            Serie rectificada
                          </label>
                          <input
                            type="text"
                            className={inputClass}
                            value={rectifiedInvoiceSeries}
                            onChange={(e) => setRectifiedInvoiceSeries(e.target.value)}
                            placeholder="F24"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-500">
                            Factura rectificada
                          </label>
                          <input
                            type="text"
                            className={inputClass}
                            value={rectifiedInvoiceNumber}
                            onChange={(e) => setRectifiedInvoiceNumber(e.target.value)}
                            placeholder="F24-001"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="rectificativeType" className="mb-1 block text-[11px] font-medium text-slate-500">
                          Tipo de rectificación
                        </label>
                        <Select
                          id="rectificativeType"
                          size="xs"
                          value={rectificativeType}
                          options={RECTIFICATIVE_TYPE_OPTIONS}
                          onChange={(value) => setRectificativeType(value as "BY_DIFFERENCE" | "BY_SUBSTITUTION")}
                        />
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600">
                        <input
                          type="checkbox"
                          checked={art80Tres}
                          onChange={(e) => setArt80Tres(e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-accent-400"
                        />
                        Art. 80.Tres (concurso de acreedores / crédito incobrable)
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Periodo contable — plegado por defecto. El caso normal es
                que coincida con el de subida (que ya se muestra en el
                strip de arriba), asi que ocupar sitio para repetirlo es
                ruido. El badge "abril 2026" en el header del panel da el
                resumen sin abrir. Se auto-expande si el accountingPeriod
                difiere — caso "el gestor ya lo cambio antes". */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setShowAccountingPanel((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Periodo contable
                  </span>
                  <span className={
                    "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                    (accountingDiffersNow ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500")
                  }>
                    {MONTH_NAMES[Number(accountingMonth) - 1]} {accountingYear}
                  </span>
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${
                    showAccountingPanel ? "rotate-0" : "-rotate-90"
                  }`}
                />
              </button>
              {showAccountingPanel && (
                <div className="border-t border-slate-100 p-3 pt-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="accountingPeriodMonth" className="mb-1 block text-[11px] font-medium text-slate-500">Mes</label>
                      <Select
                        id="accountingPeriodMonth"
                        size="xs"
                        value={accountingMonth}
                        options={MONTH_OPTIONS}
                        onChange={setAccountingMonth}
                      />
                    </div>
                    <div>
                      <label htmlFor="accountingPeriodYear" className="mb-1 block text-[11px] font-medium text-slate-500">Año</label>
                      <Select
                        id="accountingPeriodYear"
                        size="xs"
                        value={accountingYear}
                        options={accountingYearOptions}
                        onChange={setAccountingYear}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Importes — desglose de IVA. Una linea por tipo impositivo.
                Las facturas con varios tipos (4% + 10% + 21%) usan varias
                lineas; al exportar se emite una fila por cada una. */}
            <fieldset className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Desglose de IVA
              </legend>

              <div className="space-y-2">
                {/* Cabecera */}
                <div className="grid grid-cols-[1fr_90px_1fr_28px] gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <span>Base imponible</span>
                  <span>% IVA</span>
                  <span>Cuota IVA</span>
                  <span></span>
                </div>

                {vatLines.map((line, idx) => {
                  // En facturas rectificativas permitimos valores negativos
                  // (abonos / descuentos). En facturas normales restringimos
                  // a >= 0 para evitar errores de tecleo.
                  const minVal = isRectificative ? undefined : "0";
                  // Atajos en el % IVA: Alt+1=21, Alt+2=10, Alt+3=4. Mucho
                  // mas rapido que teclear cuando el gestor pasa por
                  // decenas de facturas seguidas.
                  const onRateKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (!e.altKey) return;
                    if (e.key === "1") { e.preventDefault(); updateVatLine(idx, "vatRate", "21"); }
                    else if (e.key === "2") { e.preventDefault(); updateVatLine(idx, "vatRate", "10"); }
                    else if (e.key === "3") { e.preventDefault(); updateVatLine(idx, "vatRate", "4"); }
                  };
                  return (
                    <div key={idx} className="grid grid-cols-[1fr_90px_1fr_28px] gap-2 items-start">
                      <input
                        type="number"
                        step="0.01"
                        min={minVal}
                        id={idx === 0 ? "taxBase" : undefined}
                        className={inputClass}
                        value={line.taxBase}
                        onChange={(e) => updateVatLine(idx, "taxBase", e.target.value)}
                        placeholder="1000.00"
                      />
                      <div className="flex flex-col gap-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          id={idx === 0 ? "vatRate" : undefined}
                          className={inputClass}
                          value={line.vatRate}
                          onChange={(e) => updateVatLine(idx, "vatRate", e.target.value)}
                          onKeyDown={onRateKey}
                          placeholder="21"
                        />
                        <div className="flex gap-1">
                          {VAT_RATE_SHORTCUTS.map((r, i) => {
                            const active = parseFloat(line.vatRate) === r;
                            return (
                              <button
                                key={r}
                                type="button"
                                onClick={() => updateVatLine(idx, "vatRate", String(r))}
                                title={`Aplicar ${r}% (Alt+${i + 1})`}
                                className={`flex-1 rounded text-[10px] font-semibold py-0.5 transition ${
                                  active
                                    ? "bg-blue-600 text-white"
                                    : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                                }`}
                              >
                                {r}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        min={minVal}
                        id={idx === 0 ? "vatAmount" : undefined}
                        className={inputClass}
                        value={line.vatAmount}
                        onChange={(e) => updateVatLine(idx, "vatAmount", e.target.value)}
                        placeholder="210.00"
                      />
                      <button
                        type="button"
                        onClick={() => removeVatLine(idx)}
                        disabled={vatLines.length === 1}
                        title="Eliminar línea"
                        className="flex h-[34px] w-7 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}

                {/* Totales calculados */}
                <div className="grid grid-cols-[1fr_90px_1fr_28px] gap-2 border-t border-slate-200 pt-2 text-[12px] font-medium text-slate-600">
                  <div className="px-3 py-1 tabular-nums">{formatAmountEs(vatTotals.sumBase)}</div>
                  <div className="px-1 py-1 text-[10px] uppercase text-slate-400">Suma</div>
                  <div className="px-3 py-1 tabular-nums">{formatAmountEs(vatTotals.sumAmount)}</div>
                  <div></div>
                </div>

                <button
                  type="button"
                  onClick={addVatLine}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-200 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
                >
                  <Plus className="h-3 w-3" />
                  Añadir línea de IVA
                </button>
              </div>

              {/* Retencion IRPF — Modelo 111 (profesional) o 115 (alquiler).
                  Plegada por defecto; se expande al hacer click en el
                  header o si la factura ya traia retencion (auto-expand
                  en el mount via showRetentionPanel). El header muestra
                  un badge con el resumen cuando esta activa para no
                  tener que abrir solo para ver "tiene 15%". */}
              <div className="border-t border-slate-200 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRetentionPanel((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Retención IRPF
                    </span>
                    {retentionType && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-700">
                        {retentionRate || "0"}% · {retentionType === "PROFESSIONAL" ? "Mod. 111" : "Mod. 115"}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${
                      showRetentionPanel ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                </button>
                {showRetentionPanel && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-end">
                      {retentionType && (
                        <button
                          type="button"
                          onClick={() => handleRetentionTypeChange("")}
                          className="text-[10px] font-medium text-slate-400 hover:text-red-500"
                        >
                          Quitar retención
                        </button>
                      )}
                    </div>
                    <Select
                      id="retentionType"
                      aria-label="Tipo de retención"
                      size="xs"
                      value={retentionType}
                      options={RETENTION_SELECT_OPTIONS}
                      onChange={handleRetentionTypeChange}
                    />
                    {retentionType && (
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Base ret.</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            className={inputClass}
                            value={retentionBase}
                            onChange={(e) => setRetentionBase(e.target.value)}
                            placeholder="100.00"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">% Ret.</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            className={inputClass}
                            value={retentionRate}
                            onChange={(e) => setRetentionRate(e.target.value)}
                            placeholder="15"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Cuota ret.</label>
                          <input
                            type="text"
                            className={`${inputClass} bg-slate-50 cursor-not-allowed`}
                            value={formatAmountEs(retentionAmount)}
                            readOnly
                            tabIndex={-1}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Recargo de Equivalencia — en compras Y en ventas, y POR
                  LINEA de IVA (una fila del desglose de arriba puede
                  llevarlo y otra no, p.ej. portes sin recargo). La casilla
                  la marca la IA sola si detecto el recargo explicito en el
                  documento para esa linea (ver ocrLlm.ts), sea recibida o
                  emitida; si no, el gestor la marca a mano. La sugerencia
                  automatica por % de IVA (21->5.2/10->1.4/4->0.5) solo se
                  ofrece si el cliente esta marcado como minorista en RE (ver
                  ficha del cliente), pero se ofrece igual en las dos
                  direcciones. */}
              <div className="border-t border-slate-200 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSurchargePanel((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Recargo de equivalencia
                    </span>
                    {vatTotals.sumSurcharge > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-700">
                        {formatEur(vatTotals.sumSurcharge)}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${
                      showSurchargePanel ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                </button>
                {/* Fuera del panel a proposito: el panel arranca plegado
                    cuando ninguna linea trae recargo, que es justo el caso en
                    el que hay que avisar. Dentro, el aviso no se veia nunca. */}
                {sessionContext?.equivalenceSurchargeCustomer && vatTotals.sumSurcharge === 0 && (
                  <button
                    type="button"
                    onClick={() => setShowSurchargePanel(true)}
                    className="mt-1 flex w-full items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-left text-[12px] text-amber-700"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    Cliente en recargo de equivalencia: revisa si esta factura lo lleva
                  </button>
                )}
                {showSurchargePanel && (
                  <div className="mt-2 space-y-2">
                    {vatLines.map((line, idx) => {
                      const hasSurcharge = line.equivalenceSurchargeRate !== "" || openSurchargeLines.has(idx);
                      return (
                        <div key={idx} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2">
                          <label className="flex w-24 flex-shrink-0 items-center gap-1.5 text-[12px] font-medium text-slate-600">
                            <input
                              type="checkbox"
                              checked={hasSurcharge}
                              onChange={(e) => toggleLineSurcharge(idx, e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-accent-400"
                            />
                            {line.vatRate || "?"}% IVA
                          </label>
                          {hasSurcharge ? (
                            <>
                              <div className="flex-1">
                                <input
                                  type="number"
                                  step="0.01"
                                  className={inputClass}
                                  value={line.equivalenceSurchargeRate}
                                  onChange={(e) => updateVatLine(idx, "equivalenceSurchargeRate", e.target.value)}
                                  placeholder="% recargo"
                                />
                              </div>
                              <div className="flex-1">
                                <input
                                  type="number"
                                  step="0.01"
                                  className={inputClass}
                                  value={line.equivalenceSurchargeAmount}
                                  onChange={(e) => updateVatLine(idx, "equivalenceSurchargeAmount", e.target.value)}
                                  placeholder="cuota"
                                />
                              </div>
                            </>
                          ) : (
                            <span className="flex-1 text-[11px] text-slate-400">Sin recargo en esta línea</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Total factura — fila compacta al pie del bloque
                  desglose. Antes vivia como bloque ancho separado abajo;
                  ahora es la "fila final" del IVA, alineada a la
                  derecha y en negrita. Se mantiene editable porque
                  puede incluir IRPF u otros conceptos no desglosados. */}
              <div className="flex items-center justify-between gap-3 border-t-2 border-slate-300 pt-2.5 mt-1">
                <label htmlFor="totalAmount" className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-slate-700">
                  Total factura
                  <ConfidenceHint score={confidence?.totalAmount ?? null} />
                </label>
                {(() => {
                  const props = fp("totalAmount");
                  return (
                    <div className="flex items-center gap-1.5">
                      <input
                        id="totalAmount"
                        type="number"
                        step="0.01"
                        min={isRectificative ? undefined : "0"}
                        className={`${props.className} w-36 text-right text-[14px] font-bold tabular-nums`}
                        tabIndex={props.tabIndex}
                        value={totalAmount}
                        onChange={e => setTotalAmount(e.target.value)}
                        placeholder="0.00"
                      />
                      <span className="text-[12px] text-slate-400">€</span>
                    </div>
                  );
                })()}
              </div>
            </fieldset>

            {/* Semaforo de cuadre matematico. Se muestra aqui, justo encima de
                las cuentas contables, para que se vea sin desplazarse hasta
                arriba en pantallas pequenas (a peticion de una gestora). */}
            {hasValues && (
              <div className={`flex items-center gap-2.5 rounded-xl px-4 py-3 ${
                mathOk ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
              } ${shake === "math" ? "animate-shake" : ""}`}>
                {mathOk
                  ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  : <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                }
                <span className="text-[12px] font-medium">
                  {/* El recargo cuenta en el calculo desde que va por linea:
                      sin el, el mensaje de error ensenaba una diferencia que
                      no cuadraba con la que hacia ponerse rojo al semaforo. */}
                  {mathOk
                    ? `Validación matemática correcta — Σ Bases + Σ Cuotas${vatTotals.sumSurcharge !== 0 ? " + Σ Recargo" : ""}${retentionAmount > 0 ? " − Retención" : ""} = Total`
                    : `No cuadra: las líneas suman ${formatEur(calculado)} y el total es ${formatEur(totalNum)} (diferencia: ${formatEur(Math.abs(balanceDiffCents) / 100)})`
                  }
                </span>
              </div>
            )}

            {/* Cuentas contables */}
            <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
              <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Cuentas contables
              </legend>
              {suggestedAccount?.supplierAccount && !invoice.supplierAccount && !accountNameMismatch && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-[12px] text-green-700">
                  <CheckCheck className="h-4 w-4" />
                  {accountMatchedByName
                    ? `Auto-asignada por nombre (${suggestedAccount.name}) — el NIF de este proveedor no es fiable, verifica que sea el tercero correcto`
                    : `Auto-asignada desde plan de cuentas (${suggestedAccount.name})`}
                </div>
              )}
              {/* El tercero esta en el plan pero por el otro lado: en A3 una
                  misma empresa tiene ficha de proveedor (41x) y de cliente
                  (43x), y el campo sale vacio sin explicar por que. */}
              {suggestedAccount && !suggestedAccount.supplierAccount && !accountNameMismatch && (
                <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>
                    «{suggestedAccount.name}» está en el plan de cuentas, pero sin cuenta de {type === "SALE" ? "cliente" : "proveedor"}: en A3 cada tercero tiene una ficha por cada lado. La que escribas se guardará en la suya al validar.
                  </span>
                </div>
              )}
              {!suggestedAccount && counterpartyNif && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  NIF {counterpartyNif} no registrado en el plan de cuentas — tampoco se encontró por nombre, revisa/da de alta la cuenta manualmente
                </div>
              )}
              {/* Con el NIF o el tipo cambiados sin guardar, la fila encontrada
                  al abrir ya no es la de este tercero: ni aviso ni boton. */}
              {suggestedAccount && accountNameMismatch && !counterpartyChanged && !thirdPartyNameConfirmed && (
                <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      El NIF {counterpartyNif} está en el plan de cuentas a nombre de «{suggestedAccount.name}», que no coincide con esta factura. Se han puesto sus cuentas: comprueba que es el mismo {type === "SALE" ? "cliente" : "proveedor"}. Mientras el nombre no coincida, al validar no se guarda nada en el plan de cuentas.
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={handleConfirmThirdPartyName}
                    disabled={isPendingThirdPartyName}
                    className="ml-5 mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {isPendingThirdPartyName && <Loader2 className="h-3 w-3 animate-spin" />}
                    Es el mismo: usar el nombre de esta factura
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">
                    {type === "SALE" ? "Cuenta cliente (43x)" : "Cuenta proveedor (4xx)"}
                  </label>
                  <input
                    className={`${inputClass} ${shake === "accounts" && !supplierAccountVal.trim() ? "animate-shake" : ""}`}
                    value={supplierAccountVal}
                    onChange={(e) => setSupplierAccount(sanitizeAccountingAccountInput(e.target.value))}
                    onBlur={(e) => setSupplierAccount(padAccountingAccount(e.target.value))}
                    placeholder={type === "SALE" ? "43000001" : "40000001"}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">
                    {type === "SALE" ? "Cuenta ingreso (7xx)" : "Cuenta gasto (6xx)"}
                  </label>
                  <input
                    className={`${inputClass} ${shake === "accounts" && !expenseAccountVal.trim() ? "animate-shake" : ""}`}
                    value={expenseAccountVal}
                    onChange={(e) => {
                      const value = sanitizeAccountingAccountInput(e.target.value);
                      setExpenseAccount(value);
                      // En una venta intracomunitaria teclear la 700 o la 705
                      // es marcar bienes o servicios.
                      if (type === "SALE" && operationType === "INTRACOM") {
                        const fromAccount = goodsTypeFromSaleAccount(value);
                        if (fromAccount && fromAccount !== intracomGoodsType) {
                          setIntracomGoodsType(fromAccount);
                          setIntracomGoodsSource("MANUAL");
                        }
                      }
                    }}
                    onBlur={(e) => {
                      const padded = padAccountingAccount(e.target.value);
                      setExpenseAccount(padded);
                      // "70" o "705" cortos: hasta completarlos no se sabia el grupo.
                      if (type === "SALE" && operationType === "INTRACOM") {
                        const fromAccount = goodsTypeFromSaleAccount(padded);
                        if (fromAccount && fromAccount !== intracomGoodsType) {
                          setIntracomGoodsType(fromAccount);
                          setIntracomGoodsSource("MANUAL");
                        }
                      }
                    }}
                    placeholder={type === "SALE" ? "70000000" : "62900000"}
                  />
                </div>
              </div>
              {/* Cuenta genérica para tickets/simplificadas sin datos: vuelca
                  la cuenta configurada por cliente con un clic. */}
              {genericAccounts?.supplier && (
                <button
                  type="button"
                  onClick={() => {
                    setSupplierAccount(genericAccounts.supplier ?? "");
                    if (genericAccounts.expense) setExpenseAccount(genericAccounts.expense);
                  }}
                  title="Asignar la cuenta genérica de facturas simplificadas de este cliente"
                  className="mt-3 flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Usar cuenta genérica ({genericAccounts.supplier})
                </button>
              )}
            </fieldset>


          </div>

          {/* Sticky action bar */}
          {/* Por debajo de 2xl los botones secundarios se quedan en icono (el
              title lo explica): con texto no cabian en el 45 % derecho y el
              boton verde se salia del panel. */}
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-slate-100 bg-white px-4 py-3 2xl:gap-2.5 2xl:px-5">
            {/* En una validada no hay borrador: se guarda como correccion. */}
            {!isValidated && (
              <button
                type="button"
                onClick={handleSave}
                disabled={isPendingSave || periodClosed}
                title={periodClosed ? "Periodo cerrado" : "Guardar sin validar (Ctrl+S)"}
                aria-label="Guardar sin validar"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 2xl:px-3.5"
              >
                {isPendingSave ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                <span className="hidden 2xl:inline">Guardar</span>
                <kbd className="ml-1 hidden rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500 2xl:inline">Ctrl+S</kbd>
              </button>
            )}
            {canSplit && isImage && previewUrl && (
              <button
                type="button"
                onClick={() => setShowSplitModal(true)}
                title="Dividir esta foto en varios tickets"
                aria-label="Dividir esta foto en varios tickets"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 px-3 py-2 text-[13px] font-medium text-blue-700 transition hover:bg-blue-50 2xl:px-3.5"
              >
                <Scissors className="h-3.5 w-3.5" />
                <span className="hidden 2xl:inline">Dividir</span>
              </button>
            )}
            {canSplit && isPdf && previewUrl && (
              <button
                type="button"
                onClick={() => setShowSplitPdfModal(true)}
                title="Dividir este PDF en varias facturas por páginas"
                aria-label="Dividir este PDF en varias facturas por páginas"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 px-3 py-2 text-[13px] font-medium text-blue-700 transition hover:bg-blue-50 2xl:px-3.5"
              >
                <Scissors className="h-3.5 w-3.5" />
                <span className="hidden 2xl:inline">Dividir</span>
              </button>
            )}
            {canReject && (
              <button
                type="button"
                onClick={() => setShowRejectModal(true)}
                title="Rechazar (R)"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-red-200 px-3 py-2 text-[13px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 2xl:px-3.5"
              >
                <XCircle className="h-3.5 w-3.5" />
                Rechazar
                <kbd className="ml-1 hidden rounded bg-red-50 px-1 text-[10px] font-semibold text-red-500 2xl:inline">R</kbd>
              </button>
            )}
            {isPending && (
              <button
                type="button"
                onClick={handleDefer}
                disabled={isPendingDefer || !nextPendingId}
                title={!nextPendingId ? "No quedan más facturas por revisar en el lote" : "Posponer: saltar a la siguiente sin tocar esta"}
                aria-label="Posponer"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-200 px-3 py-2 text-[13px] font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-40 2xl:px-3.5"
              >
                {isPendingDefer
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <ChevronRight className="h-3.5 w-3.5" />
                }
                <span className="hidden 2xl:inline">Posponer</span>
              </button>
            )}
            {(() => {
              // No se deshabilita por el importe o el CIF: asi el clic (y
              // Enter) explica que falla en vez de no hacer nada.
              const blocked = cifConflict || mathOk === false || accountsIncomplete;
              return (
                <button
                  type="button"
                  onClick={attemptValidate}
                  disabled={isPendingValidate || periodClosed}
                  title={
                    periodClosed
                      ? "Periodo cerrado"
                      : cifConflict
                        ? "Corrige el CIF antes de validar (coincide con el del cliente)"
                        : mathOk === false
                          ? "El importe no cuadra: corrígelo antes de validar"
                          : accountsIncomplete
                            ? "Faltan cuentas contables: rellénalas antes de validar"
                            : isValidated
                              ? "Guardar los cambios de esta factura ya validada (Enter)"
                              : "Validar y pasar a la siguiente (Enter)"
                  }
                  className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    cifConflict
                      ? "bg-red-500 hover:bg-red-600"
                      : blocked
                        ? "bg-green-600 opacity-50"
                        : "bg-green-600 hover:bg-green-700"
                  }`}
                >
                  {isPendingValidate
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : isValidated ? <Save className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />
                  }
                  {cifConflict ? "CIF igual al del cliente" : isValidated ? "Guardar corrección" : "Validar factura"}
                  <kbd className="ml-1 hidden rounded bg-white/20 px-1 text-[10px] font-semibold text-white 2xl:inline">Enter</kbd>
                  {!isValidated && nextPendingId && <ChevronRight className="h-4 w-4" />}
                </button>
              );
            })()}
          </div>

          {/* Shortcuts help overlay */}
          {showHelp && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={() => setShowHelp(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="shortcuts-title"
                className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                // Los atajos globales estan parados con la ayuda abierta: la
                // propia ayuda se cierra con Escape y con "?", como dice.
                onKeyDown={(e) => {
                  if (e.key === "Escape" || e.key === "?") {
                    e.preventDefault();
                    setShowHelp(false);
                  }
                }}
              >
                <h3 id="shortcuts-title" className="text-[15px] font-semibold text-slate-800">Atajos de teclado</h3>
                <p className="mt-1 text-[12px] text-slate-500">
                  Pensados para revisar rápido sin tocar el ratón.
                </p>
                <ul className="mt-4 space-y-2 text-[13px] text-slate-700">
                  {[
                    ["Enter", "Validar (en una ya validada, guardar la corrección). Si estás en un campo, Ctrl + Enter"],
                    ["Ctrl + S", "Guardar sin validar"],
                    ["R", "Rechazar"],
                    ["D", "Rechazar como duplicada (con el motivo ya escrito)"],
                    ["Alt + →", "Factura siguiente del lote"],
                    ["Alt + ←", "Factura anterior del lote, también las ya validadas"],
                    ["Alt + 1 / 2 / 3", "% IVA rápido (21 / 10 / 4) en la línea enfocada"],
                    ["Tab", "Saltar entre campos dudosos (omite los seguros)"],
                    ["Esc", "Cerrar esta ayuda o la ventana de rechazo"],
                    ["?", "Abrir / cerrar esta ayuda"],
                  ].map(([k, desc]) => (
                    <li key={k} className="flex items-start gap-3">
                      <kbd className="flex-shrink-0 rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700 shadow-sm">
                        {k}
                      </kbd>
                      <span className="text-slate-600">{desc}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[11px] text-slate-400">
                  Los atajos se ignoran mientras escribes en un campo. Los campos en gris con ✓ verde son seguros (el OCR los ha leído con mucha confianza) y Tab se los salta.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    autoFocus
                    onClick={() => setShowHelp(false)}
                    className="rounded-lg bg-slate-800 px-4 py-2 text-[13px] font-medium text-white hover:bg-slate-700"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Al validar una intracomunitaria: ¿este tercero va siempre como
              bienes o como servicios? */}
          {goodsQuestion && goodsTypeShown && (() => {
            const party = type === "SALE" ? "cliente" : "proveedor";
            const chosen = INTRACOM_GOODS_TYPE_LABEL[goodsTypeShown].toLowerCase();
            const assigned = assignedGoodsType ? INTRACOM_GOODS_TYPE_LABEL[assignedGoodsType].toLowerCase() : "";
            const detail = type === "SALE"
              ? `cuenta ${SALE_ACCOUNT_GROUP[goodsTypeShown]}`
              : `tipo ${OPERATION_TYPE_CODE[purchaseOperationTypeForGoods(goodsTypeShown)]}`;
            return (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
                onClick={() => setGoodsQuestion(null)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="goods-question-title"
                  className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setGoodsQuestion(null);
                    // Enter mantenido desde validar: las repeticiones activarian
                    // el boton enfocado y se contestaria sin leer la pregunta.
                    if (e.key === "Enter" && e.repeat) e.preventDefault();
                  }}
                >
                  <h3 id="goods-question-title" className="text-[15px] font-semibold text-slate-800 flex items-center gap-2">
                    <Globe className="h-5 w-5 text-blue-600" />
                    {goodsQuestion === "NUEVO"
                      ? `¿Este ${party} es siempre de ${chosen}?`
                      : `Este ${party} está asignado siempre como ${assigned}`}
                  </h3>
                  <p className="mt-1.5 text-[12px] text-slate-500">
                    {goodsQuestion === "NUEVO"
                      ? `Si dices que sí, sus próximas facturas vendrán marcadas como ${chosen} (${detail}). Si alguna es distinta, se cambia a mano.`
                      : `En esta factura has marcado ${chosen}. ¿Es solo una excepción o a partir de ahora va siempre como ${chosen}?`}
                  </p>
                  {/* Las dos respuestas en columnas iguales: en una fila con
                      flex-wrap, "Sí, siempre servicios" no cabia y el boton
                      verde bajaba solo a otra linea. */}
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      autoFocus={goodsQuestion === "CAMBIO"}
                      onClick={() => runValidate("SOLO_ESTA")}
                      className="rounded-lg border border-slate-300 px-3 py-2.5 text-[13px] font-semibold leading-tight text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-accent-100"
                    >
                      {goodsQuestion === "NUEVO" ? "Solo esta factura" : "Es una excepción"}
                    </button>
                    <button
                      type="button"
                      autoFocus={goodsQuestion === "NUEVO"}
                      onClick={() => runValidate("SIEMPRE")}
                      className="rounded-lg bg-green-600 px-3 py-2.5 text-[13px] font-semibold leading-tight text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                    >
                      {goodsQuestion === "NUEVO" ? `Sí, siempre ${chosen}` : `Cambiar a ${chosen} para siempre`}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGoodsQuestion(null)}
                    className="mt-3 w-full text-center text-[12px] font-medium text-slate-500 hover:text-slate-700"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Reject modal */}
          {showRejectModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onMouseDown={(e) => { rejectBackdropDown.current = e.target === e.currentTarget; }}
              onClick={(e) => {
                if (rejectBackdropDown.current && e.target === e.currentTarget && !isPendingReject) closeRejectModal();
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="reject-title"
                className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !isPendingReject) {
                    e.preventDefault();
                    closeRejectModal();
                  }
                }}
              >
                <h3 id="reject-title" className="text-[15px] font-semibold text-slate-800 flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  Rechazar factura
                </h3>
                <p className="mt-1.5 text-[12px] text-slate-500">
                  Indica el motivo del rechazo. El cliente recibirá una notificación con este mensaje.
                </p>
                <Select
                  id="rejectCategory"
                  aria-label="Categoría del rechazo"
                  size="sm"
                  className="mt-3"
                  value={rejectCategory}
                  options={REJECT_CATEGORY_OPTIONS}
                  onChange={setRejectCategory}
                />
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  aria-label="Motivo del rechazo"
                  placeholder="P. ej.: la factura está ilegible, falta la segunda página, el CIF no coincide…"
                  className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100 resize-none"
                  rows={3}
                  autoFocus
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={closeRejectModal}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleReject}
                    disabled={!rejectReason.trim() || isPendingReject}
                    className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {isPendingReject ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    Confirmar rechazo
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showSplitModal && previewUrl && (
        <SplitInvoiceModal
          invoiceId={invoice.id}
          imageUrl={previewUrl}
          bucket={bucket ?? "all"}
          back={back}
          onClose={() => setShowSplitModal(false)}
        />
      )}
      {showSplitPdfModal && previewUrl && (
        <SplitPdfModal
          invoiceId={invoice.id}
          pdfUrl={previewUrl}
          bucket={bucket ?? "all"}
          back={back}
          onClose={() => setShowSplitPdfModal(false)}
        />
      )}
    </div>
  );
}

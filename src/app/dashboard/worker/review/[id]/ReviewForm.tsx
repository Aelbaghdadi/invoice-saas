"use client";

import { useState, useTransition, useEffect, useCallback, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  CheckCircle2, AlertTriangle, Save, ChevronLeft, ChevronRight, ChevronDown,
  Loader2, AlertCircle, ExternalLink, FileText, Image as ImageIcon,
  XCircle, RefreshCw, CheckCheck, Plus, Trash2,
  Globe, Scissors,
} from "lucide-react";
import { saveInvoiceFields, validateInvoice, rejectInvoice, deferInvoice, type ReviewState } from "./actions";
import dynamic from "next/dynamic";
const SplitInvoiceModal = dynamic(() => import("./SplitInvoiceModal"), { ssr: false });
const SplitPdfModal = dynamic(() => import("./SplitPdfModal"), { ssr: false });
import type { Invoice, IssueType, IssueStatus } from "@prisma/client";
import {
  isValidNIF, parseTaxId,
  OPERATION_TYPE_LABEL,
  OPERATION_TYPE_CODE,
  RETENTION_TYPE_LABEL,
  RETENTION_DEFAULT_RATE,
  type OperationTypeName,
  type RetentionTypeName,
} from "@/lib/validators";
import { dateMatchesPeriod, periodLabel, type PeriodTypeName } from "@/lib/period";

const OPERATION_TYPE_OPTIONS: OperationTypeName[] = [
  "INTERIOR",
  "AGRARIA",
  "INTRACOM",
  "INVERSION_SP",
  "IMPORTACION",
  "IVA_NO_DEDUCIBLE",
];

const RETENTION_TYPE_OPTIONS: RetentionTypeName[] = ["PROFESSIONAL", "RENT"];
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
};

/** Linea individual de IVA tal como la maneja el form (strings para
 *  permitir input vacio mientras escribe el usuario). */
type VatLineInput = {
  taxBase: string;
  vatRate: string;
  vatAmount: string;
};

/** Etiquetas legibles de los campos para el hint del visor PDF. */
const FIELD_LABELS: Record<string, string> = {
  issuerName:   "Nombre emisor",
  issuerCif:    "CIF emisor",
  receiverName: "Nombre receptor",
  receiverCif:  "CIF receptor",
  invoiceNumber:"N° Factura",
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
  "taxBase" | "vatRate" | "vatAmount" | "irpfRate" | "irpfAmount" | "retentionBase" | "totalAmount"
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
  /** Lineas de IVA iniciales (de InvoiceVatLine, o sintetizada desde los
   *  campos planos de la factura para datos legacy). Vacio si nunca se
   *  procesaron datos. */
  initialVatLines: { taxBase: number; vatRate: number; vatAmount: number }[];
  prevId: string | null;
  nextId: string | null;
  position: number;
  batchTotal: number;
  backHref: string;
  extraction: ExtractionData | null;
  issues: IssueData[];
  suggestedAccount?: SuggestedAccount;
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

export function ReviewForm({ invoice, initialVatLines, prevId, nextId, position, batchTotal, backHref, extraction, issues, suggestedAccount, boundingBoxes, queueSuffix = "", bucket = "all", sessionContext, avgOcrDurationMs, genericAccounts }: Props) {
  const { success, error } = useToast();
  const isImage = invoice.fileType.startsWith("image/");
  const isPdf   = invoice.fileType === "application/pdf";
  const isXml   = invoice.fileType.includes("xml");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Form state — lineas de IVA dinamicas. Si no hay nada, una linea vacia
  // para que el gestor pueda empezar a teclear.
  const [vatLines, setVatLines] = useState<VatLineInput[]>(() => {
    if (initialVatLines.length === 0) {
      return [{ taxBase: "", vatRate: "", vatAmount: "" }];
    }
    return initialVatLines.map((l) => ({
      taxBase: String(l.taxBase),
      vatRate: String(l.vatRate),
      vatAmount: String(l.vatAmount),
    }));
  });
  const [totalAmount, setTotalAmount] = useState(fmt(invoice.totalAmount));
  const [invoiceDateVal, setInvoiceDateVal] = useState(fmtDate(invoice.invoiceDate));
  const [supplierAccountVal, setSupplierAccount] = useState(fmt(invoice.supplierAccount) || suggestedAccount?.supplierAccount || "");
  const [expenseAccountVal, setExpenseAccount]   = useState(fmt(invoice.expenseAccount) || suggestedAccount?.expenseAccount || "");
  const [operationType, setOperationType] = useState<OperationTypeName>(
    (invoice.operationType as OperationTypeName | undefined) ?? "INTERIOR",
  );

  // Tipo emitida/recibida — editable en la revisión. Si la factura se subió
  // como "No lo sé" (typeUnconfirmed), el OCR intentó detectarlo y aquí se
  // confirma o corrige. Cambiarlo conmuta qué lado es el cliente (lockedSide).
  const [type, setType] = useState<"PURCHASE" | "SALE">(
    invoice.type === "SALE" ? "SALE" : "PURCHASE",
  );

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
  const [editableIssuerCif, setEditableIssuerCif] = useState(invoice.issuerCif ?? "");
  const [editableReceiverCif, setEditableReceiverCif] = useState(invoice.receiverCif ?? "");

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
      return copy;
    });
  };

  const addVatLine = () => {
    setVatLines((prev) => [...prev, { taxBase: "", vatRate: "", vatAmount: "" }]);
  };

  const removeVatLine = (idx: number) => {
    setVatLines((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
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
    let anyFilled = false;
    for (const l of vatLines) {
      const b = parseFloat(l.taxBase);
      const a = parseFloat(l.vatAmount);
      if (!isNaN(b)) { sumBase += b; anyFilled = true; }
      if (!isNaN(a)) { sumAmount += a; anyFilled = true; }
    }
    return { sumBase, sumAmount, anyFilled };
  }, [vatLines]);

  // Math semaphore: Total = Σ Bases + Σ Cuotas - Retencion IRPF
  const totalNum   = parseFloat(totalAmount) || 0;
  const hasValues  = vatTotals.anyFilled && totalAmount;
  const calculated = Math.round((vatTotals.sumBase + vatTotals.sumAmount - retentionAmount) * 100);
  const actual     = Math.round(totalNum * 100);
  const mathOk     = hasValues ? Math.abs(calculated - actual) <= 2 : null;

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
  useEffect(() => {
    if (!nextId) return;
    // Esperar a que la actual termine de cargar; no robar banda a la cosa
    // que el usuario necesita ver ya.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/invoices/${nextId}/preview`);
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
  }, [nextId]);

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
    fd.set("accountingPeriodMonth", (document.getElementById("accountingPeriodMonth") as HTMLSelectElement)?.value ?? "");
    fd.set("accountingPeriodYear",  (document.getElementById("accountingPeriodYear")  as HTMLSelectElement)?.value ?? "");
    fd.set("supplierAccount", supplierAccountVal);
    fd.set("expenseAccount",  expenseAccountVal);
    fd.set("operationType", operationType);
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
    if (extra) Object.entries(extra).forEach(([k,v]) => fd.set(k,v));
    return fd;
  }, [type, vatLines, totalAmount, invoiceDateVal, supplierAccountVal, expenseAccountVal, operationType, retentionType, retentionBase, retentionRate, retentionAmount, isRectificative, rectifiedInvoiceSeries, rectifiedInvoiceNumber, rectificativeType, art80Tres, invoice.id, invoice.updatedAt, bucket]);

  const handleSave = () => {
    startSave(async () => {
      const res = await saveInvoiceFields(null, buildFormData());
      setSaveState(res);
      if (res?.error) {
        error("Error al guardar");
      } else {
        success("Cambios guardados");
      }
    });
  };

  const handleValidate = () => {
    startValidate(async () => {
      const res = await validateInvoice(null, buildFormData({ nextId: nextId ?? "" }));
      setValidateState(res);
      if (res?.error) {
        error("Error al guardar");
      } else {
        success("Factura validada correctamente");
      }
    });
  };

  const handleReject = () => {
    if (!rejectReason.trim()) return;
    startReject(async () => {
      const fd = new FormData();
      fd.set("invoiceId", invoice.id);
      fd.set("rejectionReason", rejectReason);
      if (rejectCategory) fd.set("rejectionCategory", rejectCategory);
      fd.set("nextId", nextId ?? "");
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
      fd.set("nextId", nextId ?? "");
      const res = await deferInvoice(null, fd);
      // El action redirecciona en caso de exito; solo veremos retorno si hay error.
      if (res?.error) {
        error(typeof res.error === "string" ? res.error : res.error.message);
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

  const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

  // Props de estilo + tabIndex en funcion de la confianza OCR de cada campo.
  // Campos "seguros" (score alto) reciben tabIndex={-1} y color apagado:
  // Tab los salta y el gestor va directo a los dudosos.
  const fp = (field: string) => fieldPropsFromConfidence(confidence?.[field] ?? null);

  // Atajos de teclado globales. Enter valida, R abre rechazo, D marca
  // duplicado, Ctrl/Cmd+S guarda borrador, Alt+Arrow navega, "?" abre ayuda.
  useReviewShortcuts({
    onValidate: () => { if (!isPendingValidate) handleValidate(); },
    onSave: () => { if (!isPendingSave) handleSave(); },
    onReject: () => setShowRejectModal(true),
    onMarkDuplicate: () => {
      setRejectCategory("DUPLICATE");
      setRejectReason((prev) => prev || "Factura duplicada");
      setShowRejectModal(true);
    },
    onNext: () => { if (nextId) router.push(`/dashboard/worker/review/${nextId}${queueSuffix}`); },
    onPrev: () => { if (prevId) router.push(`/dashboard/worker/review/${prevId}${queueSuffix}`); },
    onToggleHelp: () => setShowHelp((s) => !s),
    isBlocked: () => showRejectModal || showHelp || showSplitModal || showSplitPdfModal,
  });

  // Etiqueta del bucket activo en la sesion. Ayuda al gestor a saber
  // "estoy en la cola de incidencias" vs "la de validacion rapida".
  const bucketLabel =
    bucket === "attention" ? "Incidencias" :
    bucket === "clean" ? "Listas para validar" :
    null;

  // Progreso de la sesion: en "attention" y "clean", la factura actual
  // sigue en la cola hasta que se valida/rechaza, asi que "posicion/total"
  // ya es el indicador natural. % = (position-1)/total procesado.
  const progressPct = batchTotal > 0 ? Math.round(((position - 1) / batchTotal) * 100) : 0;

  const monthLabel = sessionContext
    ? new Date(2000, sessionContext.periodMonth - 1).toLocaleString("es-ES", { month: "long" })
    : null;

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
          <span className="text-[13px] font-semibold text-slate-800 max-w-[200px] truncate">{invoice.filename}</span>
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
          <span className="text-[12px] text-slate-400">{position} de {batchTotal}</span>
          {prevId ? (
            <Link href={`/dashboard/worker/review/${prevId}${queueSuffix}`} prefetch
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <button disabled className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-100 text-slate-200">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {nextId ? (
            <Link href={`/dashboard/worker/review/${nextId}${queueSuffix}`} prefetch
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <button disabled className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-100 text-slate-200">
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
            <span className="capitalize">{monthLabel} {sessionContext.periodYear}</span>
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
            <span className="text-[11px] font-medium text-slate-500 tabular-nums">
              {position}/{batchTotal}
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
            if (id && boundingBoxes?.[id]) setActiveField(id);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setActiveField(null);
            }
          }}
        >
          <div className="flex-1 px-4 py-3 space-y-2.5">

            {/* Semaphore */}
            {hasValues && (
              <div className={`flex items-center gap-2.5 rounded-xl px-4 py-3 ${
                mathOk ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
              }`}>
                {mathOk
                  ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  : <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                }
                <span className="text-[12px] font-medium">
                  {mathOk
                    ? `Validación matemática correcta — Σ Bases + Σ Cuotas${retentionAmount > 0 ? " − Retención" : ""} = Total`
                    : `Error: ${(vatTotals.sumBase + vatTotals.sumAmount - retentionAmount).toFixed(2)} ≠ ${totalNum.toFixed(2)} (diferencia: ${Math.abs(vatTotals.sumBase + vatTotals.sumAmount - retentionAmount - totalNum).toFixed(2)} €)`
                  }
                </span>
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
                    Nombre / Razón social
                    <ConfidenceHint score={confidence?.[lockedSide === "receiver" ? "issuerName" : "receiverName"] ?? null} />
                  </label>
                  {lockedSide === "receiver" ? (
                    <input id="issuerName" {...fp("issuerName")} defaultValue={invoice.issuerName ?? ""} />
                  ) : (
                    <input id="receiverName" {...fp("receiverName")} defaultValue={invoice.receiverName ?? ""} />
                  )}
                </div>
                <div>
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
                    return v && !isValidNIF(v) ? (
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
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Tipo
                    {invoice.typeUnconfirmed && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700">
                        <AlertTriangle className="h-2.5 w-2.5" /> Confirma
                      </span>
                    )}
                  </label>
                  <select
                    className={inputClass}
                    value={type}
                    onChange={(e) => setType(e.target.value as "PURCHASE" | "SALE")}
                  >
                    <option value="PURCHASE">Recibida (compra)</option>
                    <option value="SALE">Emitida (venta)</option>
                  </select>
                  {invoice.typeUnconfirmed && (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Tipo sin determinar automáticamente — indica si es emitida o recibida.
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    N factura
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
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Tipo de operación
                    {operationType !== "INTERIOR" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700">
                        <Globe className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </label>
                  <select
                    className={inputClass}
                    value={operationType}
                    onChange={(e) => setOperationType(e.target.value as OperationTypeName)}
                  >
                    {OPERATION_TYPE_OPTIONS.map((op) => (
                      <option key={op} value={op}>
                        {OPERATION_TYPE_CODE[op]} · {OPERATION_TYPE_LABEL[op]}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>
            </div>

            {/* Aviso ISP/intracom — fuera del grid para no romper alturas. */}
            {operationType !== "INTERIOR" && operationType !== "AGRARIA"
              && operationType !== "IVA_NO_DEDUCIBLE"
              && vatTotals.sumAmount > 0.01 && (
              <p className="flex items-center gap-1 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                Las facturas de tipo &quot;{OPERATION_TYPE_LABEL[operationType]}&quot; suelen ir sin IVA en factura (inversión del sujeto pasivo). Revisa el desglose.
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
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
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
                        <label className="mb-1 block text-[11px] font-medium text-slate-500">
                          Tipo de rectificación
                        </label>
                        <select
                          className={inputClass}
                          value={rectificativeType}
                          onChange={(e) => setRectificativeType(e.target.value as "BY_DIFFERENCE" | "BY_SUBSTITUTION")}
                        >
                          <option value="BY_DIFFERENCE">1 · Por diferencias (solo el delta)</option>
                          <option value="BY_SUBSTITUTION">2 · Por sustitución (anula y reemplaza)</option>
                        </select>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600">
                        <input
                          type="checkbox"
                          checked={art80Tres}
                          onChange={(e) => setArt80Tres(e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
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
                    (accountingDiffers ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500")
                  }>
                    {new Date(0, (invoice.accountingPeriodMonth ?? invoice.periodMonth) - 1).toLocaleString("es", { month: "long" })}
                    {" "}
                    {invoice.accountingPeriodYear ?? invoice.periodYear}
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
                      <label className="mb-1 block text-[11px] font-medium text-slate-500">Mes</label>
                      <select
                        id="accountingPeriodMonth"
                        className={inputClass}
                        defaultValue={String(invoice.accountingPeriodMonth ?? invoice.periodMonth)}
                      >
                        {Array.from({ length: 12 }, (_, i) => (
                          <option key={i + 1} value={i + 1}>
                            {new Date(0, i).toLocaleString("es", { month: "long" })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-500">Año</label>
                      <select
                        id="accountingPeriodYear"
                        className={inputClass}
                        defaultValue={String(invoice.accountingPeriodYear ?? invoice.periodYear)}
                      >
                        {Array.from({ length: 5 }, (_, i) => {
                          const y = new Date().getFullYear() - 2 + i;
                          return <option key={y} value={y}>{y}</option>;
                        })}
                      </select>
                    </div>
                  </div>
                </div>
              )}
              {/* Hidden inputs cuando el panel esta cerrado: los selects
                  no estan en el DOM y `buildFormData` lee del DOM via id.
                  Garantizamos que siempre se envia un valor (el por
                  defecto = periodo de subida) aunque el gestor nunca
                  abra el panel. */}
              {!showAccountingPanel && (
                <>
                  <input
                    type="hidden"
                    id="accountingPeriodMonth"
                    value={String(invoice.accountingPeriodMonth ?? invoice.periodMonth)}
                    readOnly
                  />
                  <input
                    type="hidden"
                    id="accountingPeriodYear"
                    value={String(invoice.accountingPeriodYear ?? invoice.periodYear)}
                    readOnly
                  />
                </>
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
                        title="Eliminar linea"
                        className="flex h-[34px] w-7 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}

                {/* Totales calculados */}
                <div className="grid grid-cols-[1fr_90px_1fr_28px] gap-2 border-t border-slate-200 pt-2 text-[12px] font-medium text-slate-600">
                  <div className="px-3 py-1 tabular-nums">{vatTotals.sumBase.toFixed(2)}</div>
                  <div className="px-1 py-1 text-[10px] uppercase text-slate-400">Suma</div>
                  <div className="px-3 py-1 tabular-nums">{vatTotals.sumAmount.toFixed(2)}</div>
                  <div></div>
                </div>

                <button
                  type="button"
                  onClick={addVatLine}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-200 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
                >
                  <Plus className="h-3 w-3" />
                  Anadir linea de IVA
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
                    <select
                      className={inputClass}
                      value={retentionType}
                      onChange={(e) => handleRetentionTypeChange(e.target.value)}
                    >
                      <option value="">Sin retención</option>
                      {RETENTION_TYPE_OPTIONS.map((rt) => (
                        <option key={rt} value={rt}>
                          {RETENTION_TYPE_LABEL[rt]}
                        </option>
                      ))}
                    </select>
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
                            value={retentionAmount.toFixed(2)}
                            readOnly
                            tabIndex={-1}
                          />
                        </div>
                      </div>
                    )}
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

            {/* Cuentas contables */}
            <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
              <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Cuentas Contables
              </legend>
              {suggestedAccount && !invoice.supplierAccount && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-[12px] text-green-700">
                  <CheckCheck className="h-4 w-4" />
                  Auto-asignada desde plan de cuentas ({suggestedAccount.name})
                </div>
              )}
              {!suggestedAccount && invoice.issuerCif && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  NIF {invoice.issuerCif} no registrado en el plan de cuentas
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Cuenta Proveedor (4xx)</label>
                  <input
                    className={inputClass}
                    value={supplierAccountVal}
                    onChange={(e) => setSupplierAccount(e.target.value)}
                    placeholder="400.00001"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Cuenta Gasto (6xx/7xx)</label>
                  <input
                    className={inputClass}
                    value={expenseAccountVal}
                    onChange={(e) => setExpenseAccount(e.target.value)}
                    placeholder="629.00000"
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
          <div className="sticky bottom-0 flex items-center gap-2.5 border-t border-slate-100 bg-white px-5 py-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPendingSave}
              title="Guardar borrador (Ctrl+S)"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {isPendingSave ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Guardar
              <kbd className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500">⌘S</kbd>
            </button>
            {isImage && previewUrl && (
              <button
                type="button"
                onClick={() => setShowSplitModal(true)}
                title="Dividir esta foto en varios tickets"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-200 px-3.5 py-2 text-[13px] font-medium text-indigo-700 transition hover:bg-indigo-50"
              >
                <Scissors className="h-3.5 w-3.5" />
                Dividir
              </button>
            )}
            {isPdf && previewUrl && (
              <button
                type="button"
                onClick={() => setShowSplitPdfModal(true)}
                title="Dividir este PDF en varias facturas por páginas"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-200 px-3.5 py-2 text-[13px] font-medium text-indigo-700 transition hover:bg-indigo-50"
              >
                <Scissors className="h-3.5 w-3.5" />
                Dividir
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowRejectModal(true)}
              title="Rechazar (R)"
              className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3.5 py-2 text-[13px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" />
              Rechazar
              <kbd className="ml-1 rounded bg-red-50 px-1 text-[10px] font-semibold text-red-500">R</kbd>
            </button>
            <button
              type="button"
              onClick={handleDefer}
              disabled={isPendingDefer || !nextId}
              title={!nextId ? "No hay más facturas en la cola" : "Posponer: saltar a la siguiente sin tocar el estado"}
              className="flex items-center gap-1.5 rounded-lg border border-amber-200 px-3.5 py-2 text-[13px] font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-40"
            >
              {isPendingDefer
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ChevronRight className="h-3.5 w-3.5" />
              }
              Posponer
            </button>
            <button
              type="button"
              onClick={handleValidate}
              disabled={isPendingValidate || cifConflict}
              title={cifConflict ? "Corrige el CIF antes de validar (coincide con el cliente)" : "Validar y pasar a la siguiente (Enter)"}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition disabled:opacity-50 ${
                cifConflict
                  ? "bg-red-500 hover:bg-red-600"
                  : mathOk === false
                    ? "bg-orange-500 hover:bg-orange-600"
                    : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {isPendingValidate
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CheckCircle2 className="h-4 w-4" />
              }
              {cifConflict
                ? "CIF duplicado"
                : mathOk === false
                  ? "Validar igualmente"
                  : "Validar factura"}
              <kbd className="ml-1 rounded bg-white/20 px-1 text-[10px] font-semibold text-white">Enter</kbd>
              {nextId && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>

          {/* Shortcuts help overlay */}
          {showHelp && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={() => setShowHelp(false)}
            >
              <div
                className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-[15px] font-semibold text-slate-800">Atajos de teclado</h3>
                <p className="mt-1 text-[12px] text-slate-500">
                  Pensados para revisar rapido sin tocar el raton.
                </p>
                <ul className="mt-4 space-y-2 text-[13px] text-slate-700">
                  {[
                    ["Enter", "Validar — solo con Ctrl/Cmd o foco fuera de inputs"],
                    ["Ctrl / Cmd + S", "Guardar como borrador sin validar"],
                    ["R", "Abrir dialogo de rechazo"],
                    ["D", "Marcar como duplicada (abre rechazo prerellenado)"],
                    ["Alt + Flecha derecha", "Siguiente factura sin validar"],
                    ["Alt + Flecha izquierda", "Factura anterior sin validar"],
                    ["Alt + 1 / 2 / 3", "% IVA rápido (21 / 10 / 4) en la línea enfocada"],
                    ["Tab", "Saltar entre campos dudosos (omite los seguros)"],
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
                  Los atajos se ignoran mientras escribes en un campo. Los campos marcados en verde son "seguros" (alta confianza OCR) y Tab los salta.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => setShowHelp(false)}
                    className="rounded-lg bg-slate-800 px-4 py-2 text-[13px] font-medium text-white hover:bg-slate-700"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reject modal */}
          {showRejectModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
                <h3 className="text-[15px] font-semibold text-slate-800 flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  Rechazar factura
                </h3>
                <p className="mt-1.5 text-[12px] text-slate-500">
                  Indica el motivo del rechazo. El cliente recibira una notificacion con este mensaje.
                </p>
                <select
                  value={rejectCategory}
                  onChange={e => setRejectCategory(e.target.value)}
                  className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100"
                >
                  <option value="">Categoría (opcional)</option>
                  <option value="ILLEGIBLE">Ilegible</option>
                  <option value="INCOMPLETE">Incompleta</option>
                  <option value="WRONG_PERIOD">Periodo incorrecto</option>
                  <option value="DUPLICATE">Duplicada</option>
                  <option value="OTHER">Otro</option>
                </select>
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  placeholder="Ej: La factura esta ilegible, falta la segunda pagina, el CIF no coincide..."
                  className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100 resize-none"
                  rows={3}
                  autoFocus
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => { setShowRejectModal(false); setRejectReason(""); }}
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
          onClose={() => setShowSplitModal(false)}
        />
      )}
      {showSplitPdfModal && previewUrl && (
        <SplitPdfModal
          invoiceId={invoice.id}
          pdfUrl={previewUrl}
          bucket={bucket ?? "all"}
          onClose={() => setShowSplitPdfModal(false)}
        />
      )}
    </div>
  );
}

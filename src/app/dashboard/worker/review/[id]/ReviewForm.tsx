"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  CheckCircle2, AlertTriangle, Save, ChevronLeft, ChevronRight,
  Loader2, AlertCircle, ExternalLink, FileText, Image as ImageIcon,
  XCircle, RefreshCw, Eye, EyeOff, ShieldAlert, CheckCheck, X,
} from "lucide-react";
import { saveInvoiceFields, validateInvoice, rejectInvoice, type ReviewState } from "./actions";
import { resolveIssue, dismissIssue } from "@/app/dashboard/worker/issues/actions";
import type { Invoice, IssueType, IssueStatus } from "@prisma/client";
import { isValidNIF } from "@/lib/validators";
import Link from "next/link";
import PdfViewer from "@/components/ui/PdfViewerDynamic";
import { fieldPropsFromConfidence, ConfidenceHint } from "@/components/ui/SmartField";
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
  periodMonth: number;
  periodYear: number;
  type: "PURCHASE" | "SALE";
};

type Props = {
  invoice: Invoice;
  prevId: string | null;
  nextId: string | null;
  position: number;
  batchTotal: number;
  backHref: string;
  extraction: ExtractionData | null;
  issues: IssueData[];
  suggestedAccount?: SuggestedAccount;
  /** Querystring ya formada ("?bucket=clean" o ""), a pegar a las URLs de nav. */
  queueSuffix?: string;
  /** Bucket actual de la cola; se envia al server para calcular el siguiente. */
  bucket?: "clean" | "attention" | "all";
  /** Contexto de la "sesion de trabajo": cliente + periodo + tipo. Se muestra
   *  en cabecera para que el gestor sepa en que lote esta. */
  sessionContext?: SessionContext;
};

function fmt(v: unknown) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

export function ReviewForm({ invoice, prevId, nextId, position, batchTotal, backHref, extraction, issues, suggestedAccount, queueSuffix = "", bucket = "all", sessionContext }: Props) {
  const { success, error } = useToast();
  const isImage = invoice.fileType.startsWith("image/");
  const isXml   = invoice.fileType.includes("xml");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Form state
  const [taxBase,     setTaxBase]     = useState(fmt(invoice.taxBase));
  const [vatRate,     setVatRate]     = useState(fmt(invoice.vatRate));
  const [vatAmount,   setVatAmount]   = useState(fmt(invoice.vatAmount));
  const [totalAmount, setTotalAmount] = useState(fmt(invoice.totalAmount));
  const [supplierAccountVal, setSupplierAccount] = useState(fmt(invoice.supplierAccount) || suggestedAccount?.supplierAccount || "");
  const [expenseAccountVal, setExpenseAccount]   = useState(fmt(invoice.expenseAccount) || suggestedAccount?.expenseAccount || "");

  const [saveState, setSaveState]         = useState<ReviewState>(null);
  const [validateState, setValidateState] = useState<ReviewState>(null);
  const [rejectState, setRejectState]     = useState<ReviewState>(null);
  const [isPendingSave, startSave]        = useTransition();
  const [isPendingValidate, startValidate]= useTransition();
  const [isPendingReject, startReject]    = useTransition();
  const [isPendingReprocess, startReprocess] = useTransition();
  const [isPendingIssueAction, startIssueAction] = useTransition();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason]   = useState("");
  const [rejectCategory, setRejectCategory] = useState("");
  const [showOcrComparison, setShowOcrComparison] = useState(false);
  const [dismissedIssues, setDismissedIssues] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const router = useRouter();

  const confidence = extraction?.confidence ?? null;
  const openIssues = issues.filter((i) => i.status === "OPEN" && !dismissedIssues.has(i.id));

  // Math semaphore: Base + IVA = Total
  const base       = parseFloat(taxBase)     || 0;
  const vat        = parseFloat(vatAmount)   || 0;
  const totalNum   = parseFloat(totalAmount) || 0;
  const hasValues  = taxBase && vatAmount && totalAmount;
  const calculated = Math.round((base + vat) * 100);
  const actual     = Math.round(totalNum * 100);
  const mathOk     = hasValues ? Math.abs(calculated - actual) <= 2 : null;

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

  const buildFormData = useCallback((extra?: Record<string,string>) => {
    const fd = new FormData();
    fd.set("invoiceId",    invoice.id);
    fd.set("updatedAt",    new Date(invoice.updatedAt).toISOString());
    fd.set("issuerName",   (document.getElementById("issuerName")   as HTMLInputElement)?.value ?? "");
    fd.set("issuerCif",    (document.getElementById("issuerCif")    as HTMLInputElement)?.value ?? "");
    fd.set("receiverName", (document.getElementById("receiverName") as HTMLInputElement)?.value ?? "");
    fd.set("receiverCif",  (document.getElementById("receiverCif")  as HTMLInputElement)?.value ?? "");
    fd.set("invoiceNumber",(document.getElementById("invoiceNumber")as HTMLInputElement)?.value ?? "");
    fd.set("invoiceDate",  (document.getElementById("invoiceDate")  as HTMLInputElement)?.value ?? "");
    fd.set("taxBase",    taxBase);
    fd.set("vatRate",    vatRate);
    fd.set("vatAmount",  vatAmount);
    fd.set("totalAmount",totalAmount);
    fd.set("accountingPeriodMonth", (document.getElementById("accountingPeriodMonth") as HTMLSelectElement)?.value ?? "");
    fd.set("accountingPeriodYear",  (document.getElementById("accountingPeriodYear")  as HTMLSelectElement)?.value ?? "");
    fd.set("supplierAccount", supplierAccountVal);
    fd.set("expenseAccount",  expenseAccountVal);
    fd.set("bucket", bucket);
    if (extra) Object.entries(extra).forEach(([k,v]) => fd.set(k,v));
    return fd;
  }, [taxBase, vatRate, vatAmount, totalAmount, supplierAccountVal, expenseAccountVal, invoice.id, invoice.updatedAt, bucket]);

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
        error(res.error);
      } else {
        success("Factura rechazada");
        setShowRejectModal(false);
      }
    });
  };

  const handleResolveIssue = (issueId: string) => {
    startIssueAction(async () => {
      const fd = new FormData();
      fd.set("issueId", issueId);
      const res = await resolveIssue(null, fd);
      if (res?.error) error(res.error);
      else {
        setDismissedIssues((prev) => new Set(prev).add(issueId));
        success("Incidencia resuelta");
      }
    });
  };

  const handleDismissIssue = (issueId: string) => {
    startIssueAction(async () => {
      const fd = new FormData();
      fd.set("issueId", issueId);
      const res = await dismissIssue(null, fd);
      if (res?.error) error(res.error);
      else {
        setDismissedIssues((prev) => new Set(prev).add(issueId));
        success("Incidencia descartada");
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
        error("Error de conexion al reprocesar");
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
    isBlocked: () => showRejectModal || showHelp,
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
            <span className="text-slate-300">·</span>
            <span className="capitalize">{monthLabel} {sessionContext.periodYear}</span>
            <span className="text-slate-300">·</span>
            <span>{sessionContext.type === "PURCHASE" ? "Recibidas" : "Emitidas"}</span>
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
              <div className="flex flex-1 items-center justify-center overflow-auto bg-[#1e1e2e] p-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt={invoice.filename} className="max-h-full max-w-full rounded-lg shadow-2xl object-contain" />
              </div>
            ) : (
              <PdfViewer url={previewUrl} />
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
        <div className="flex w-[45%] flex-col overflow-y-auto bg-white">
          <div className="flex-1 px-5 py-4 space-y-4">

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
                    ? "Validación matemática correcta — Base + IVA = Total"
                    : `Error: ${(base + vat).toFixed(2)} ≠ ${totalNum.toFixed(2)} (diferencia: ${Math.abs(base + vat - totalNum).toFixed(2)} €)`
                  }
                </span>
              </div>
            )}

            {/* OCR Error banner */}
            {invoice.status === "OCR_ERROR" && (
              <div className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-red-700">
                <div className="flex items-center gap-2.5">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <div>
                    <p className="text-[12px] font-medium">Error en el procesamiento OCR</p>
                    {invoice.lastOcrError && (
                      <p className="text-[11px] text-red-500 mt-0.5">{invoice.lastOcrError}</p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleReprocess}
                  disabled={isPendingReprocess}
                  className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isPendingReprocess ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Reprocesar
                </button>
              </div>
            )}

            {/* Issues banner */}
            {openIssues.length > 0 && (
              <div className="space-y-2">
                {openIssues.map((issue) => (
                  <div key={issue.id} className={`flex items-start justify-between gap-2 rounded-xl px-4 py-3 ${
                    issue.type === "POSSIBLE_DUPLICATE" ? "bg-orange-50 text-orange-700" :
                    issue.type === "MATH_MISMATCH" ? "bg-red-50 text-red-600" :
                    "bg-amber-50 text-amber-700"
                  }`}>
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide">
                          {issue.type === "OCR_FAILED" ? "Error OCR" :
                           issue.type === "LOW_CONFIDENCE" ? "Baja confianza" :
                           issue.type === "MATH_MISMATCH" ? "Error matematico" :
                           issue.type === "POSSIBLE_DUPLICATE" ? "Posible duplicado" : "Incidencia"}
                        </p>
                        <p className="text-[12px] mt-0.5">{issue.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleResolveIssue(issue.id)}
                        disabled={isPendingIssueAction}
                        className="flex items-center gap-1 rounded-md bg-white/80 px-2 py-1 text-[11px] font-medium hover:bg-white"
                        title="Resolver"
                      >
                        <CheckCheck className="h-3 w-3" /> Resolver
                      </button>
                      <button
                        onClick={() => handleDismissIssue(issue.id)}
                        disabled={isPendingIssueAction}
                        className="flex items-center gap-1 rounded-md bg-white/80 px-2 py-1 text-[11px] font-medium hover:bg-white"
                        title="Descartar"
                      >
                        <X className="h-3 w-3" /> Descartar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Errors */}
            {(saveState?.error || validateState?.error || rejectState?.error) && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-[12px] text-red-600">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {saveState?.error ?? validateState?.error ?? rejectState?.error}
              </div>
            )}

            {/* Emisor */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Emisor</legend>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                  Nombre / Razon social
                  <ConfidenceHint score={confidence?.issuerName ?? null} />
                </label>
                <input id="issuerName" {...fp("issuerName")} defaultValue={invoice.issuerName ?? ""} />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                  CIF / NIF
                  <ConfidenceHint score={confidence?.issuerCif ?? null} />
                </label>
                <input id="issuerCif" {...fp("issuerCif")} defaultValue={invoice.issuerCif ?? ""} placeholder="B12345678" />
                {invoice.issuerCif && !isValidNIF(invoice.issuerCif) && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-orange-600">
                    <AlertTriangle className="h-3 w-3" />
                    CIF/NIF con formato inválido
                  </p>
                )}
              </div>
            </fieldset>

            {/* Receptor */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Receptor</legend>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                  Nombre / Razon social
                  <ConfidenceHint score={confidence?.receiverName ?? null} />
                </label>
                <input id="receiverName" {...fp("receiverName")} defaultValue={invoice.receiverName ?? ""} />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                  CIF / NIF
                  <ConfidenceHint score={confidence?.receiverCif ?? null} />
                </label>
                <input id="receiverCif" {...fp("receiverCif")} defaultValue={invoice.receiverCif ?? ""} placeholder="B12345678" />
              </div>
            </fieldset>

            {/* Factura */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Factura</legend>
              <div className="grid grid-cols-2 gap-3">
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
                  <input id="invoiceDate" type="date" {...fp("invoiceDate")} defaultValue={fmtDate(invoice.invoiceDate)} />
                </div>
              </div>
            </fieldset>

            {/* Periodo contable */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Periodo contable</legend>
              <p className="text-[10px] text-slate-400 -mt-1">Si difiere del periodo de subida ({invoice.periodMonth}/{invoice.periodYear})</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Mes</label>
                  <select id="accountingPeriodMonth" className={inputClass} defaultValue={invoice.accountingPeriodMonth ?? ""}>
                    <option value="">Mismo que subida</option>
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {new Date(0, i).toLocaleString("es", { month: "long" })}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Ano</label>
                  <select id="accountingPeriodYear" className={inputClass} defaultValue={invoice.accountingPeriodYear ?? ""}>
                    <option value="">Mismo que subida</option>
                    {Array.from({ length: 5 }, (_, i) => {
                      const y = new Date().getFullYear() - 2 + i;
                      return <option key={y} value={y}>{y}</option>;
                    })}
                  </select>
                </div>
              </div>
            </fieldset>

            {/* Importes */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Importes</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Base imponible
                    <ConfidenceHint score={confidence?.taxBase ?? null} />
                  </label>
                  <input id="taxBase" type="number" step="0.01" min="0" {...fp("taxBase")} value={taxBase} onChange={e => setTaxBase(e.target.value)} placeholder="1000.00" />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    % IVA
                    <ConfidenceHint score={confidence?.vatRate ?? null} />
                  </label>
                  <input id="vatRate" type="number" step="0.01" min="0" max="100" {...fp("vatRate")} value={vatRate} onChange={e => setVatRate(e.target.value)} placeholder="21" />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    Cuota IVA
                    <ConfidenceHint score={confidence?.vatAmount ?? null} />
                  </label>
                  <input id="vatAmount" type="number" step="0.01" min="0" {...fp("vatAmount")} value={vatAmount} onChange={e => setVatAmount(e.target.value)} placeholder="210.00" />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 font-semibold">
                    Total factura
                    <ConfidenceHint score={confidence?.totalAmount ?? null} />
                  </label>
                  {(() => {
                    const props = fp("totalAmount");
                    return (
                      <input
                        id="totalAmount"
                        type="number"
                        step="0.01"
                        min="0"
                        className={`${props.className} font-semibold`}
                        tabIndex={props.tabIndex}
                        value={totalAmount}
                        onChange={e => setTotalAmount(e.target.value)}
                        placeholder="1060.00"
                      />
                    );
                  })()}
                </div>
              </div>
            </fieldset>

            {/* Cuentas contables */}
            <fieldset className="rounded-xl border border-slate-200 bg-white p-4">
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
            </fieldset>

            {/* OCR Comparison panel */}
            {extraction && (
              <div className="rounded-xl border border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowOcrComparison(!showOcrComparison)}
                  className="flex w-full items-center justify-between px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600"
                >
                  <span className="flex items-center gap-1.5">
                    {showOcrComparison ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    Comparar con OCR ({extraction.source})
                  </span>
                  <span className="text-[10px] font-normal normal-case text-slate-400">
                    {new Date(extraction.createdAt).toLocaleString("es-ES")}
                  </span>
                </button>
                {showOcrComparison && (
                  <div className="border-t border-slate-100 px-4 py-3">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-slate-400">
                          <th className="pb-2 text-left font-semibold">Campo</th>
                          <th className="pb-2 text-left font-semibold">Valor OCR</th>
                          <th className="pb-2 text-left font-semibold">Valor actual</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {([
                          ["issuerName", "Emisor", extraction.issuerName, invoice.issuerName],
                          ["issuerCif", "CIF Emisor", extraction.issuerCif, invoice.issuerCif],
                          ["receiverName", "Receptor", extraction.receiverName, invoice.receiverName],
                          ["receiverCif", "CIF Receptor", extraction.receiverCif, invoice.receiverCif],
                          ["invoiceNumber", "N Factura", extraction.invoiceNumber, invoice.invoiceNumber],
                          ["invoiceDate", "Fecha", extraction.invoiceDate, fmtDate(invoice.invoiceDate)],
                          ["taxBase", "Base", extraction.taxBase != null ? String(extraction.taxBase) : null, fmt(invoice.taxBase)],
                          ["vatRate", "% IVA", extraction.vatRate != null ? String(extraction.vatRate) : null, fmt(invoice.vatRate)],
                          ["vatAmount", "Cuota IVA", extraction.vatAmount != null ? String(extraction.vatAmount) : null, fmt(invoice.vatAmount)],
                          ["totalAmount", "Total", extraction.totalAmount != null ? String(extraction.totalAmount) : null, fmt(invoice.totalAmount)],
                        ] as [string, string, string | null, string | null][]).map(([key, label, ocrVal, currentVal]) => {
                          const changed = (ocrVal ?? "") !== (currentVal ?? "");
                          return (
                            <tr key={key} className={changed ? "bg-amber-50/50" : ""}>
                              <td className="py-1.5 font-medium text-slate-600">{label}</td>
                              <td className="py-1.5 text-slate-500">{ocrVal ?? "—"}</td>
                              <td className={`py-1.5 ${changed ? "font-semibold text-amber-700" : "text-slate-500"}`}>
                                {currentVal || "—"}
                                {changed && <span className="ml-1 text-[10px] text-amber-500">modificado</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
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
              onClick={handleValidate}
              disabled={isPendingValidate}
              title="Validar y pasar a la siguiente (Enter)"
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition disabled:opacity-50 ${
                mathOk === false ? "bg-orange-500 hover:bg-orange-600" : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {isPendingValidate
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CheckCircle2 className="h-4 w-4" />
              }
              {mathOk === false ? "Validar igualmente" : "Validar factura"}
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
                    ["Enter", "Validar la factura actual y pasar a la siguiente"],
                    ["Ctrl / Cmd + S", "Guardar como borrador sin validar"],
                    ["R", "Abrir dialogo de rechazo"],
                    ["D", "Marcar como duplicada (abre rechazo prerellenado)"],
                    ["Alt + Flecha derecha", "Siguiente factura sin validar"],
                    ["Alt + Flecha izquierda", "Factura anterior sin validar"],
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
                  <option value="">Categoria (opcional)</option>
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
    </div>
  );
}

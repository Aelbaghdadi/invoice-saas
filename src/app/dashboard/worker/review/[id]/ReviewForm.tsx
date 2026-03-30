"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  CheckCircle2, AlertTriangle, Save, ChevronLeft, ChevronRight,
  Loader2, AlertCircle, ExternalLink, FileText, Image as ImageIcon,
  XCircle, RefreshCw,
} from "lucide-react";
import { saveInvoiceFields, validateInvoice, rejectInvoice, type ReviewState } from "./actions";
import type { Invoice } from "@prisma/client";
import Link from "next/link";
import PdfViewer from "@/components/ui/PdfViewerDynamic";

type Props = {
  invoice: Invoice;
  prevId: string | null;
  nextId: string | null;
  position: number;
  batchTotal: number;
  backHref: string;
};

function fmt(v: unknown) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

export function ReviewForm({ invoice, prevId, nextId, position, batchTotal, backHref }: Props) {
  const { success, error } = useToast();
  const isImage = invoice.fileType.startsWith("image/");
  const isXml   = invoice.fileType.includes("xml");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Form state
  const [taxBase,     setTaxBase]     = useState(fmt(invoice.taxBase));
  const [vatRate,     setVatRate]     = useState(fmt(invoice.vatRate));
  const [vatAmount,   setVatAmount]   = useState(fmt(invoice.vatAmount));
  const [irpfRate,    setIrpfRate]    = useState(fmt(invoice.irpfRate));
  const [irpfAmount,  setIrpfAmount]  = useState(fmt(invoice.irpfAmount));
  const [totalAmount, setTotalAmount] = useState(fmt(invoice.totalAmount));

  const [saveState, setSaveState]         = useState<ReviewState>(null);
  const [validateState, setValidateState] = useState<ReviewState>(null);
  const [rejectState, setRejectState]     = useState<ReviewState>(null);
  const [isPendingSave, startSave]        = useTransition();
  const [isPendingValidate, startValidate]= useTransition();
  const [isPendingReject, startReject]    = useTransition();
  const [isPendingReprocess, startReprocess] = useTransition();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason]   = useState("");

  // Math semaphore
  const base       = parseFloat(taxBase)     || 0;
  const vat        = parseFloat(vatAmount)   || 0;
  const irpf       = parseFloat(irpfAmount)  || 0;
  const totalNum   = parseFloat(totalAmount) || 0;
  const hasValues  = taxBase && vatAmount && totalAmount;
  const calculated = Math.round((base + vat - irpf) * 100);
  const actual     = Math.round(totalNum * 100);
  const mathOk     = hasValues ? Math.abs(calculated - actual) <= 2 : null;

  // Load signed URL
  useEffect(() => {
    fetch(`/api/invoices/${invoice.id}/preview`)
      .then((r) => r.json())
      .then((d) => { setPreviewUrl(d.url); setPreviewLoading(false); })
      .catch(() => setPreviewLoading(false));
  }, [invoice.id]);

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
    fd.set("irpfRate",   irpfRate);
    fd.set("irpfAmount", irpfAmount);
    fd.set("totalAmount",totalAmount);
    if (extra) Object.entries(extra).forEach(([k,v]) => fd.set(k,v));
    return fd;
  }, [taxBase, vatRate, vatAmount, irpfRate, irpfAmount, totalAmount, invoice.id]);

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
          <span className="text-[12px] text-slate-400">{position} de {batchTotal}</span>
          {prevId ? (
            <Link href={`/dashboard/worker/review/${prevId}`}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <button disabled className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-100 text-slate-200">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {nextId ? (
            <Link href={`/dashboard/worker/review/${nextId}`}
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
                    ? "Validación matemática correcta — Base + IVA − IRPF = Total"
                    : `Error: ${(base + vat - irpf).toFixed(2)} ≠ ${totalNum.toFixed(2)} (diferencia: ${Math.abs(base + vat - irpf - totalNum).toFixed(2)} €)`
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
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Nombre / Razón social</label>
                <input id="issuerName" className={inputClass} defaultValue={invoice.issuerName ?? ""} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">CIF / NIF</label>
                <input id="issuerCif" className={inputClass} defaultValue={invoice.issuerCif ?? ""} placeholder="B12345678" />
              </div>
            </fieldset>

            {/* Receptor */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Receptor</legend>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Nombre / Razón social</label>
                <input id="receiverName" className={inputClass} defaultValue={invoice.receiverName ?? ""} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">CIF / NIF</label>
                <input id="receiverCif" className={inputClass} defaultValue={invoice.receiverCif ?? ""} placeholder="B12345678" />
              </div>
            </fieldset>

            {/* Factura */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Factura</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Nº factura</label>
                  <input id="invoiceNumber" className={inputClass} defaultValue={invoice.invoiceNumber ?? ""} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Fecha</label>
                  <input id="invoiceDate" type="date" className={inputClass} defaultValue={fmtDate(invoice.invoiceDate)} />
                </div>
              </div>
            </fieldset>

            {/* Importes */}
            <fieldset className="rounded-xl border border-slate-100 p-4 space-y-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Importes (€)</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Base imponible</label>
                  <input className={inputClass} value={taxBase} onChange={e => setTaxBase(e.target.value)} placeholder="1000.00" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">% IVA</label>
                  <input className={inputClass} value={vatRate} onChange={e => setVatRate(e.target.value)} placeholder="21" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Cuota IVA</label>
                  <input className={inputClass} value={vatAmount} onChange={e => setVatAmount(e.target.value)} placeholder="210.00" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">% IRPF</label>
                  <input className={inputClass} value={irpfRate} onChange={e => setIrpfRate(e.target.value)} placeholder="15" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Cuota IRPF</label>
                  <input className={inputClass} value={irpfAmount} onChange={e => setIrpfAmount(e.target.value)} placeholder="150.00" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500 font-semibold">Total factura</label>
                  <input className={`${inputClass} font-semibold`} value={totalAmount} onChange={e => setTotalAmount(e.target.value)} placeholder="1060.00" />
                </div>
              </div>
            </fieldset>
          </div>

          {/* Sticky action bar */}
          <div className="sticky bottom-0 flex items-center gap-2.5 border-t border-slate-100 bg-white px-5 py-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPendingSave}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {isPendingSave ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Guardar
            </button>
            <button
              type="button"
              onClick={() => setShowRejectModal(true)}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3.5 py-2 text-[13px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" />
              Rechazar
            </button>
            <button
              type="button"
              onClick={handleValidate}
              disabled={isPendingValidate}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition disabled:opacity-50 ${
                mathOk === false ? "bg-orange-500 hover:bg-orange-600" : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {isPendingValidate
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CheckCircle2 className="h-4 w-4" />
              }
              {mathOk === false ? "Validar igualmente" : "Validar factura"}
              {nextId && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>

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
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  placeholder="Ej: La factura esta ilegible, falta la segunda pagina, el CIF no coincide..."
                  className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100 resize-none"
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

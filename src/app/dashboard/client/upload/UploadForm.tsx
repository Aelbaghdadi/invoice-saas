"use client";

import { useState, useTransition, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import {
  Upload,
  FileText,
  FileCode2,
  Image,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  CloudUpload,
} from "lucide-react";
import { uploadInvoicesAction, type UploadState } from "./actions";

const MONTHS = [
  { value: 1, label: "Enero" },
  { value: 2, label: "Febrero" },
  { value: 3, label: "Marzo" },
  { value: 4, label: "Abril" },
  { value: 5, label: "Mayo" },
  { value: 6, label: "Junio" },
  { value: 7, label: "Julio" },
  { value: 8, label: "Agosto" },
  { value: 9, label: "Septiembre" },
  { value: 10, label: "Octubre" },
  { value: 11, label: "Noviembre" },
  { value: 12, label: "Diciembre" },
];

const YEARS = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

const ACCEPTED_EXTS = new Set(["pdf", "xml", "jpg", "jpeg", "png", "webp", "heic"]);
const ACCEPTED_MIME = new Set([
  "application/pdf",
  "text/xml",
  "application/xml",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadForm() {
  const { success, error: toastError } = useToast();
  const now = new Date();
  const [files, setFiles] = useState<File[]>([]);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [type, setType] = useState<"PURCHASE" | "SALE">("PURCHASE");
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<UploadState>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return ACCEPTED_MIME.has(f.type) || ACCEPTED_EXTS.has(ext);
    });
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !existing.has(f.name))];
    });
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const removeFile = (name: string) =>
    setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length || isPending) return;

    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("periodMonth", String(month));
    fd.append("periodYear", String(year));
    fd.append("type", type);

    startTransition(async () => {
      const res = await uploadInvoicesAction(null, fd);
      setResult(res);
      if (res?.success) {
        setFiles([]);
        success("Facturas subidas correctamente");
      } else if (res?.error) {
        toastError("Error al subir facturas");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Batch settings */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-[14px] font-semibold text-slate-800">
          Configuración del lote
        </h2>
        <div className="grid grid-cols-3 gap-4">
          {/* Month */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Mes
            </label>
            <Select
              value={String(month)}
              onChange={(v) => setMonth(Number(v))}
              options={MONTHS.map((m) => ({ value: String(m.value), label: m.label }))}
            />
          </div>

          {/* Year */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Ano
            </label>
            <Select
              value={String(year)}
              onChange={(v) => setYear(Number(v))}
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
            />
          </div>

          {/* Type */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Tipo
            </label>
            <Select
              value={type}
              onChange={(v) => setType(v as "PURCHASE" | "SALE")}
              options={[
                { value: "PURCHASE", label: "Facturas recibidas" },
                { value: "SALE", label: "Facturas emitidas" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-12 transition-colors ${
          isDragging
            ? "border-blue-400 bg-blue-50"
            : "border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,.heic"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <div
          className={`mb-4 flex h-14 w-14 items-center justify-center rounded-xl ${
            isDragging ? "bg-blue-100" : "bg-slate-100"
          }`}
        >
          <CloudUpload
            className={`h-7 w-7 ${isDragging ? "text-blue-500" : "text-slate-400"}`}
          />
        </div>
        <p className="text-[14px] font-semibold text-slate-700">
          Arrastra aquí tus facturas o{" "}
          <span className="text-blue-600">selecciona archivos</span>
        </p>
        <p className="mt-1 text-[12px] text-slate-400">
          PDF, XML, JPG, PNG, WEBP · Máximo 10 MB por archivo
        </p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-3">
            <p className="text-[13px] font-semibold text-slate-700">
              {files.length} archivo{files.length !== 1 ? "s" : ""} seleccionado
              {files.length !== 1 ? "s" : ""}
            </p>
          </div>
          <ul className="divide-y divide-slate-50">
            {files.map((file) => {
              const ext = file.name.split(".").pop()?.toLowerCase();
              const Icon =
                ext === "xml" ? FileCode2
                : ["jpg", "jpeg", "png", "webp", "heic"].includes(ext ?? "") ? Image
                : FileText;
              return (
                <li
                  key={file.name}
                  className="flex items-center gap-3 px-5 py-3"
                >
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                    <Icon className="h-4 w-4 text-slate-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-slate-700">
                      {file.name}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {formatSize(file.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(file.name)}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Result banner */}
      {result?.success && (
        <div className="flex items-center gap-2.5 rounded-xl bg-green-50 px-4 py-3 text-[13px] text-green-700">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          <span>
            {result.count} factura{result.count !== 1 ? "s" : ""} subida
            {result.count !== 1 ? "s" : ""} correctamente. Serán procesadas en
            breve.
          </span>
        </div>
      )}

      {result?.error && (
        <div className="flex items-center gap-2.5 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{result.error}</span>
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-slate-400">
          Las facturas serán analizadas automáticamente con OCR.
        </p>
        <button
          type="submit"
          disabled={!files.length || isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {isPending
            ? "Subiendo..."
            : `Subir ${files.length > 0 ? `${files.length} archivo${files.length !== 1 ? "s" : ""}` : "archivos"}`}
        </button>
      </div>
    </form>
  );
}

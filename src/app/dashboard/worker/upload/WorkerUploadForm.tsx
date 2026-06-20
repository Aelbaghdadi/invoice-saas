"use client";

import { useState, useRef } from "react";
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
  Copy,
} from "lucide-react";
import {
  uploadFilesDirect,
  type UploadStatus,
  type UploadResult,
} from "@/lib/uploadDirectClient";
import { quarterStartMonth, QUARTER_OPTIONS } from "@/lib/period";

const MONTHS = [
  { value: "1", label: "Enero" },
  { value: "2", label: "Febrero" },
  { value: "3", label: "Marzo" },
  { value: "4", label: "Abril" },
  { value: "5", label: "Mayo" },
  { value: "6", label: "Junio" },
  { value: "7", label: "Julio" },
  { value: "8", label: "Agosto" },
  { value: "9", label: "Septiembre" },
  { value: "10", label: "Octubre" },
  { value: "11", label: "Noviembre" },
  { value: "12", label: "Diciembre" },
];

const YEARS = Array.from({ length: 5 }, (_, i) => {
  const y = new Date().getFullYear() - i;
  return { value: String(y), label: String(y) };
});

const ACCEPTED_EXTS = new Set(["pdf", "xml", "jpg", "jpeg", "png", "webp", "heic"]);
const ACCEPTED_MIME = new Set([
  "application/pdf", "text/xml", "application/xml",
  "image/jpeg", "image/png", "image/webp", "image/heic",
]);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Item = {
  id: string;
  file: File;
  status: UploadStatus;
  duplicateOf?: string;
  errorMsg?: string;
};

type Props = {
  clients: { id: string; name: string; cif: string }[];
  groups: { id: string; name: string; clientIds: string[] }[];
};

export function WorkerUploadForm({ clients, groups }: Props) {
  const { success, error: toastError, info } = useToast();
  const now = new Date();
  const [items, setItems] = useState<Item[]>([]);
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  // Modo de subida: "single" = un cliente; "classify" = clasificar por CIF
  // entre varias empresas candidatas (grupo guardado o selección ad-hoc).
  const [mode, setMode] = useState<"single" | "classify">("single");
  const [candidateIds, setCandidateIds] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState("");
  const [periodType, setPeriodType] = useState<"MONTHLY" | "QUARTERLY">("MONTHLY");
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [quarter, setQuarter] = useState(Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [type, setType] = useState<"PURCHASE" | "SALE">("PURCHASE");
  const [isDragging, setIsDragging] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Empresas del grupo que este usuario puede ver/subir: un gestor puede no
  // tener asignadas todas las del grupo (que es de la firma). Filtramos el
  // desplegable y la preselección a lo accesible para no marcar empresas que
  // no salen en los checkboxes y que el backend rechazaría (403).
  const accessibleClientIds = new Set(clients.map((c) => c.id));
  const visibleGroups = groups.filter((g) => g.clientIds.some((cid) => accessibleClientIds.has(cid)));

  const addFiles = (incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return ACCEPTED_MIME.has(f.type) || ACCEPTED_EXTS.has(ext);
    });
    setItems((prev) => {
      // De-dupe en cliente por nombre+size (mismo archivo arrastrado dos
      // veces antes de subir). El dedupe real por hash lo hace el server.
      const seen = new Set(prev.map((i) => `${i.file.name}::${i.file.size}`));
      const fresh = valid
        .filter((f) => !seen.has(`${f.name}::${f.size}`))
        .map<Item>((f) => ({
          id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`,
          file: f,
          status: "queued",
        }));
      return [...prev, ...fresh];
    });
  };

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((i) => i.id !== id));

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isPending) addFiles(e.dataTransfer.files);
  };

  const updateItem = (idx: number, patch: Partial<Item>) =>
    setItems((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], ...patch };
      return next;
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!items.length || isPending) return;
    if (mode === "single" && !clientId) return;
    if (mode === "classify" && candidateIds.size === 0) return;

    setIsPending(true);
    setItems((prev) =>
      prev.map((i) => (i.status === "error" ? { ...i, status: "queued", errorMsg: undefined } : i)),
    );

    // Snapshot inmediato — el state cambia durante el upload, pero el
    // mapping uploadIdx → realIdx tiene que ser estable.
    const snapshot = items;
    const toUpload = snapshot
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => it.status !== "ok" && it.status !== "duplicate");

    const effectivePeriodMonth = periodType === "QUARTERLY" ? quarterStartMonth(quarter) : Number(month);
    const results = await uploadFilesDirect(
      toUpload.map((x) => x.it.file),
      mode === "classify"
        ? {
            candidateClientIds: [...candidateIds],
            periodType,
            periodMonth: effectivePeriodMonth,
            periodYear: Number(year),
            type,
          }
        : {
            clientId,
            periodType,
            periodMonth: effectivePeriodMonth,
            periodYear: Number(year),
            type,
          },
      3,
      (uploadIdx, status) => {
        const realIdx = toUpload[uploadIdx]?.idx;
        if (realIdx != null) updateItem(realIdx, { status });
      },
      (uploadIdx, result: UploadResult) => {
        const realIdx = toUpload[uploadIdx]?.idx;
        if (realIdx == null) return;
        if (result.status === "ok") {
          updateItem(realIdx, { status: "ok" });
        } else if (result.status === "duplicate") {
          updateItem(realIdx, { status: "duplicate", duplicateOf: result.of });
        } else {
          updateItem(realIdx, { status: "error", errorMsg: result.message });
        }
      },
    );

    setIsPending(false);

    const okCount = results.filter((r) => r.status === "ok").length;
    const dupCount = results.filter((r) => r.status === "duplicate").length;
    const errCount = results.filter((r) => r.status === "error").length;

    if (okCount > 0) {
      success(`${okCount} factura${okCount !== 1 ? "s" : ""} subida${okCount !== 1 ? "s" : ""} correctamente`);
    }
    if (dupCount > 0 && okCount === 0) {
      info(`${dupCount} duplicada${dupCount !== 1 ? "s" : ""} omitida${dupCount !== 1 ? "s" : ""}`);
    }
    if (errCount > 0) {
      toastError(`${errCount} archivo${errCount !== 1 ? "s" : ""} con error`);
    }

    // Auto-limpiar OK y duplicadas tras 1.5s. Los errores se quedan
    // para que el gestor vea que paso y pueda reintentar.
    setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.status === "error" || i.status === "queued"));
    }, 1500);
  };

  const pendingCount = items.filter((i) => i.status !== "ok" && i.status !== "duplicate").length;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-[14px] font-semibold text-slate-800">
          Configuración del lote
        </h2>
        {/* Modo: un cliente vs clasificar entre varios por CIF */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Modo de subida
          </label>
          <div className="flex gap-2">
            {([["single", "Un cliente"], ["classify", "Clasificar entre varios"]] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                disabled={m === "classify" && clients.length < 2}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition disabled:opacity-40 ${
                  mode === m ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === "single" ? (
          <div className="mb-4">
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Cliente
            </label>
            <Select
              value={clientId}
              onChange={setClientId}
              options={clients.map((c) => ({ value: c.id, label: `${c.name} (${c.cif})` }))}
            />
          </div>
        ) : (
          <div className="mb-4 space-y-2">
            {visibleGroups.length > 0 && (
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Grupo guardado
                </label>
                <Select
                  value={groupId}
                  onChange={(v) => {
                    setGroupId(v);
                    const g = visibleGroups.find((x) => x.id === v);
                    // Solo las empresas del grupo que este usuario puede subir.
                    setCandidateIds(new Set(g ? g.clientIds.filter((cid) => accessibleClientIds.has(cid)) : []));
                  }}
                  options={[{ value: "", label: "— Selección manual —" }, ...visibleGroups.map((g) => ({ value: g.id, label: g.name }))]}
                />
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Empresas candidatas ({candidateIds.size})
              </label>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {clients.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={candidateIds.has(c.id)}
                      onChange={() => {
                        setGroupId("");
                        setCandidateIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        });
                      }}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    />
                    <span className="truncate" title={`${c.name} (${c.cif})`}>{c.name}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                Cada factura se asigna automáticamente a su empresa por el CIF —y si no, por el nombre— que aparezca en el documento (según el tipo de abajo); las que no casen con claridad quedan en “Por clasificar”.
              </p>
            </div>
          </div>
        )}
        {/* Toggle mensual / trimestral */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Agrupación del periodo
          </label>
          <div className="flex gap-2">
            {(["MONTHLY", "QUARTERLY"] as const).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => setPeriodType(pt)}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition ${
                  periodType === pt
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {pt === "MONTHLY" ? "Mensual" : "Trimestral"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {periodType === "MONTHLY" ? "Mes" : "Trimestre"}
            </label>
            {periodType === "MONTHLY" ? (
              <Select value={month} onChange={setMonth} options={MONTHS} />
            ) : (
              <Select
                value={String(quarter)}
                onChange={(v) => setQuarter(Number(v))}
                options={QUARTER_OPTIONS.map((q) => ({ value: String(q.value), label: q.label }))}
              />
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Año
            </label>
            <Select value={year} onChange={setYear} options={YEARS} />
          </div>
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

      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => !isPending && inputRef.current?.click()}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-12 transition-colors ${
          isPending ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        } ${
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
        <div className={`mb-4 flex h-14 w-14 items-center justify-center rounded-xl ${isDragging ? "bg-blue-100" : "bg-slate-100"}`}>
          <CloudUpload className={`h-7 w-7 ${isDragging ? "text-blue-500" : "text-slate-400"}`} />
        </div>
        <p className="text-[14px] font-semibold text-slate-700">
          Arrastra aquí las facturas o{" "}
          <span className="text-blue-600">selecciona archivos</span>
        </p>
        <p className="mt-1 text-[12px] text-slate-400">
          PDF, XML, JPG, PNG, WEBP · Máximo 20 MB por archivo
        </p>
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <p className="text-[13px] font-semibold text-slate-700">
              {items.length} archivo{items.length !== 1 ? "s" : ""}
            </p>
            {!isPending && items.some((i) => i.status === "queued" || i.status === "error") && (
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((i) => i.status !== "queued" && i.status !== "error"))}
                className="text-[11px] font-medium text-slate-400 hover:text-slate-600"
              >
                Limpiar lista
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-50">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                onRemove={() => removeItem(item.id)}
                disabled={isPending}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[12px] text-slate-400">
          Las facturas se suben directamente al almacenamiento y se analizan automáticamente con OCR.
        </p>
        <button
          type="submit"
          disabled={!items.length || isPending || pendingCount === 0 || (mode === "single" ? !clientId : candidateIds.size === 0)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {isPending
            ? "Subiendo..."
            : `Subir ${pendingCount > 0 ? `${pendingCount} archivo${pendingCount !== 1 ? "s" : ""}` : "archivos"}`}
        </button>
      </div>
    </form>
  );
}

function ItemRow({
  item,
  onRemove,
  disabled,
}: {
  item: Item;
  onRemove: () => void;
  disabled: boolean;
}) {
  const ext = item.file.name.split(".").pop()?.toLowerCase();
  const Icon = ext === "xml" ? FileCode2
    : ["jpg", "jpeg", "png", "webp", "heic"].includes(ext ?? "") ? Image
    : FileText;

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-slate-700">{item.file.name}</p>
        <p className="text-[11px] text-slate-400">
          {formatSize(item.file.size)}
          {item.status === "duplicate" && item.duplicateOf && (
            <span className="ml-2 text-amber-600">· duplicado de {item.duplicateOf}</span>
          )}
          {item.status === "error" && item.errorMsg && (
            <span className="ml-2 text-red-600">· {item.errorMsg}</span>
          )}
        </p>
      </div>
      <StatusBadge item={item} />
      {(item.status === "queued" || item.status === "error" || item.status === "duplicate") && !disabled && (
        <button
          type="button"
          onClick={onRemove}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

function StatusBadge({ item }: { item: Item }) {
  switch (item.status) {
    case "queued":
      return null;
    case "hashing":
    case "uploading":
    case "registering":
      return (
        <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          {item.status === "hashing"
            ? "Preparando"
            : item.status === "uploading"
              ? "Subiendo"
              : "Registrando"}
        </span>
      );
    case "ok":
      return (
        <span className="flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
          <CheckCircle2 className="h-3 w-3" />
          Subida
        </span>
      );
    case "duplicate":
      return (
        <span
          className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700"
          title={item.duplicateOf ? `Duplicado de: ${item.duplicateOf}` : "Ya existe en el sistema"}
        >
          <Copy className="h-3 w-3" />
          Duplicada
        </span>
      );
    case "error":
      return (
        <span
          className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-700"
          title={item.errorMsg ?? "Error"}
        >
          <AlertCircle className="h-3 w-3" />
          Error
        </span>
      );
  }
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { extendTacoAction } from "@/app/dashboard/archivo/tacoActions";
import { tacoLabel } from "@/lib/paperLocation";
import {
  completionSummary,
  endPositions,
  hasTargetClash,
  planTacoCompletion,
  type CompletionRow,
  type CompletionTarget,
} from "@/lib/tacoCompletion";
import { uploadFilesDirect, type UploadMeta, type UploadResult } from "@/lib/uploadDirectClient";
import { uploadFileNotice } from "@/lib/uploadListState";

type RowStatus = { state: "queued" | "uploading" | "ok" | "already" | "duplicate" | "error"; message?: string };

type Row = CompletionRow & { file: File; hash: string; status: RowStatus };

const CONCURRENCY = 3;

/** SHA-256 en hexadecimal, como la huella que guarda la subida. */
async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const STATUS_TEXT: Record<RowStatus["state"], string> = {
  queued: "",
  uploading: "Subiendo…",
  ok: "Subida",
  already: "Ya estaba",
  duplicate: "Duplicada",
  error: "Error",
};

/**
 * «Completar el taco» (5.7, B-R23): sube los ficheros que faltan a sus
 * páginas vacías o al final, en el mismo taco. Lo que ya está se reconoce por
 * su huella (calculada aquí) y no se sube.
 */
export function TacoCompleteUpload({
  batchId,
  tacoNumber,
  fileCount,
  occupied,
  takenPages,
  meta,
  onClose,
}: {
  batchId: string;
  tacoNumber: number;
  fileCount: number;
  occupied: { position: number; fileHash: string }[];
  takenPages: number[];
  /** El cliente (o los candidatos que ve, en un taco de varios), el lote y el tipo del taco. */
  meta: UploadMeta;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [hashing, setHashing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { success } = useToast();

  // Mientras sube, avisar antes de cerrar o recargar la pestaña.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const emptyPages = Array.from({ length: fileCount }, (_, i) => i + 1).filter((page) => !takenPages.includes(page));

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      const notice = uploadFileNotice({ name: file.name, size: file.size, mimeType: file.type }, "perInvoice");
      if (notice) rejected.push(notice);
      else accepted.push(file);
    }
    setNotices([...new Set(rejected)]);
    if (accepted.length === 0) return;
    setHashing(true);
    try {
      // Lo que aún no se ha subido se vuelve a repartir junto con lo nuevo.
      const previous = rows.filter((row) => row.status.state === "queued" || row.status.state === "error");
      const fresh = await Promise.all(accepted.map(async (file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        name: file.name,
        hash: await sha256(file),
        file,
        status: { state: "queued" } as RowStatus,
      })));
      const all = [...previous.map(({ id, name, hash, file, status }) => ({ id, name, hash, file, status })), ...fresh];
      const byId = new Map(all.map((file) => [file.id, file]));
      const plan = planTacoCompletion({ files: all, occupied, takenPages, fileCount });
      setRows(plan.map((row) => {
        const file = byId.get(row.id)!;
        return { ...row, file: file.file, hash: file.hash, status: file.status };
      }));
    } catch {
      setError("No se ha podido leer algún fichero. Vuelve a elegirlos.");
    } finally {
      setHashing(false);
    }
  }

  const setTarget = (id: string, target: CompletionTarget) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, target } : row)));
  const setStatus = (id: string, status: RowStatus) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, status } : row)));

  const pending = rows.filter((row) => row.target != null && (row.status.state === "queued" || row.status.state === "error"));

  async function upload() {
    setError(null);
    if (hasTargetClash(rows)) {
      setError("Dos ficheros van a la misma página: cambia uno de los dos.");
      return;
    }
    setUploading(true);
    try {
      // Las que van al final, primero se hace sitio en el taco (B-R23).
      let positions = new Map<string, number>();
      const toEnd = pending.filter((row) => row.target === "end");
      if (toEnd.length > 0) {
        const res = await extendTacoAction({ batchId, expectedFileCount: fileCount, addCount: toEnd.length });
        if ("error" in res) {
          setError(res.error);
          return;
        }
        positions = endPositions(pending, res.firstNewPosition);
        // Ya tienen su página: un reintento va a la misma.
        setRows((prev) => prev.map((row) => (positions.has(row.id) ? { ...row, target: positions.get(row.id)! } : row)));
      }
      const batch = pending.map((row) => ({ row, position: typeof row.target === "number" ? row.target : positions.get(row.id)! }));
      let uploaded = 0;
      await uploadFilesDirect(
        batch.map(({ row }) => row.file),
        meta,
        CONCURRENCY,
        (i) => setStatus(batch[i].row.id, { state: "uploading" }),
        (i, result: UploadResult) => {
          const id = batch[i].row.id;
          if (result.status === "ok") {
            uploaded++;
            setStatus(id, { state: result.alreadyUploaded ? "already" : "ok" });
          } else if (result.status === "duplicate") {
            setStatus(id, { state: "duplicate", message: `Ya está en el archivo: ${result.of}` });
          } else if (result.status === "error") {
            setStatus(id, { state: "error", message: result.message });
          }
        },
        (i) => ({ uploadBatchId: batchId, uploadPosition: batch[i].position }),
      );
      if (uploaded > 0) {
        success(`${tacoLabel(tacoNumber)}: ${uploaded} ${uploaded === 1 ? "página subida" : "páginas subidas"}.`);
      }
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  const options = (row: Row) => {
    const chosenElsewhere = new Set(rows.filter((other) => other.id !== row.id && typeof other.target === "number").map((other) => other.target));
    return emptyPages.filter((page) => page === row.target || !chosenElsewhere.has(page));
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-800">Completar el {tacoLabel(tacoNumber)}</h3>
          <p className="text-[12px] text-slate-500">
            Para una subida cortada, un fichero olvidado o una página que falló. Suelta otra vez todos los escaneos si
            quieres: los que ya están se reconocen y no se suben.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={uploading}
          aria-label="Cerrar"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!uploading) void addFiles(e.dataTransfer.files);
        }}
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-200 px-4 py-5 text-center text-[13px] text-slate-500 hover:border-blue-300 hover:bg-blue-50/40"
      >
        <Upload className="h-5 w-5 text-slate-400" />
        <span className="font-medium text-slate-700">Arrastra aquí los escaneos o selecciona archivos</span>
        <span className="text-[11px]">PDF, JPG, PNG, WEBP o HEIC · Máximo 20 MB por archivo</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"
          className="sr-only"
          disabled={uploading}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>

      {notices.map((notice) => (
        <p key={notice} className="text-[12px] text-amber-700">{notice}</p>
      ))}
      {hashing && (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Comprobando los ficheros…
        </p>
      )}

      {rows.length > 0 && (
        <>
          <p className="text-[12px] font-medium text-slate-700">{completionSummary(rows, fileCount)}</p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-700" title={row.name}>{row.name}</span>
                {row.alreadyAt != null ? (
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Ya está en la pág. {row.alreadyAt}
                  </span>
                ) : row.repeatOf != null ? (
                  <span className="text-slate-500">Es el mismo fichero que {row.repeatOf}</span>
                ) : (
                  <>
                    {row.status.state === "queued" || row.status.state === "error" ? (
                      <select
                        aria-label={`Página de ${row.name}`}
                        value={row.target === "end" ? "end" : String(row.target)}
                        disabled={uploading || (typeof row.target === "number" && row.target > fileCount)}
                        onChange={(e) => setTarget(row.id, e.target.value === "end" ? "end" : Number(e.target.value))}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700"
                      >
                        {typeof row.target === "number" && row.target > fileCount && (
                          <option value={String(row.target)}>Pág. {row.target}</option>
                        )}
                        {options(row).map((page) => (
                          <option key={page} value={String(page)}>Pág. {page} (vacía)</option>
                        ))}
                        <option value="end">Al final</option>
                      </select>
                    ) : (
                      <span className="text-slate-500">Pág. {row.target === "end" ? "—" : row.target}</span>
                    )}
                    {row.status.state !== "queued" && (
                      <span
                        title={row.status.message}
                        className={row.status.state === "error" ? "text-red-600" : row.status.state === "duplicate" ? "text-amber-700" : "text-emerald-700"}
                      >
                        {row.status.state === "uploading" && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />}
                        {STATUS_TEXT[row.status.state]}
                        {row.status.message && (row.status.state === "error" || row.status.state === "duplicate") ? `: ${row.status.message}` : ""}
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {uploading && <p className="text-[12px] font-medium text-amber-700">No cierres esta pestaña hasta que termine la subida.</p>}
      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={uploading}
          className="rounded-lg border border-slate-200 px-3.5 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Cerrar
        </button>
        <button
          type="button"
          onClick={() => void upload()}
          disabled={uploading || hashing || pending.length === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {pending.length === 1 ? "Subir 1 fichero" : `Subir ${pending.length} ficheros`}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addToUploadList,
  applyUploadResult,
  assignBatch,
  clearFinishedUploads,
  EMPTY_UPLOAD_LIST,
  markUploading,
  moveByOne,
  moveToPage,
  planNewBatches,
  removeFromUploadList,
  replaceFile,
  resortUploadList,
  uploadFileNotice,
  type UploadListMode,
  type UploadListState,
  type UploadSortBy,
} from "@/lib/uploadListState";
import { uploadFilesDirect, type UploadBatchRef } from "@/lib/uploadDirectClient";
import { startUploadBatch } from "./uploadBatchActions";

/** A dónde va la subida: lo elegido en «Configuración del lote». */
export type UploadTarget = {
  /** null = clasificar entre varios (candidateClientIds). */
  clientId: string | null;
  candidateClientIds: string[];
  periodType: "MONTHLY" | "QUARTERLY";
  periodMonth: number;
  periodYear: number;
  type: "PURCHASE" | "SALE" | "UNKNOWN";
};

/** Lo que ha pasado en cada tanda de una subida (para la tarjeta del taco y
 *  la línea «¿Era papel?»). */
export type BatchOutcome =
  | { kind: "digital"; batchId: string; fileCount: number; uploaded: number }
  | { kind: "perInvoice"; batchId: string; tacoNumber: number; pageCount: number; uploaded: number; duplicates: number }
  | { kind: "wholePdf"; batchId: string; tacoNumber: number; pageCount: number };

export type UploadOutcome =
  | { ok: number; duplicates: number; errors: number; batches: BatchOutcome[] }
  | { error: string };

/** Lo que se sube a la vez: 3 equilibra velocidad sin saturar ni el servidor
 *  ni la conexión del gestor. */
const UPLOAD_CONCURRENCY = 3;

let sequence = 0;
function newId(file: File): string {
  sequence += 1;
  return `${file.name}-${file.size}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * La lista de ficheros de la subida del gestor y su subida en tandas (5.2):
 * el estado es el de uploadListState (puro y con tests); aquí quedan los File
 * (un Map por id), las llamadas a startUploadBatch y a /api/uploads, y el
 * aviso al cerrar la pestaña mientras se sube.
 */
export function useUploadBatch() {
  const [list, setList] = useState<UploadListState>(EMPTY_UPLOAD_LIST);
  const [pending, setPending] = useState(false);
  // El estado va también en una ref: la subida lee lo último (las tandas
  // recién asignadas) sin esperar a que React vuelva a pintar.
  const listRef = useRef(list);
  const files = useRef(new Map<string, File>());
  const batches = useRef(new Map<string, { tacoNumber: number | null; fileCount: number }>());
  const busy = useRef(false);

  const commit = useCallback((change: (state: UploadListState) => UploadListState): UploadListState => {
    const next = change(listRef.current);
    if (next !== listRef.current) {
      listRef.current = next;
      setList(next);
    }
    return next;
  }, []);

  /** Olvida los File de las filas que ya no están en la lista. */
  const forgetMissing = useCallback((state: UploadListState) => {
    const ids = new Set(state.items.map((item) => item.id));
    for (const id of [...files.current.keys()]) if (!ids.has(id)) files.current.delete(id);
  }, []);

  /** Añade los ficheros que valen y devuelve los avisos de los que no. */
  const add = useCallback((incoming: readonly File[], mode: UploadListMode): string[] => {
    const fresh = incoming.map((file) => ({
      file,
      facts: { id: newId(file), name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type || undefined },
    }));
    const { state, notices } = addToUploadList(listRef.current, fresh.map((entry) => entry.facts), mode);
    const accepted = new Set(state.items.map((item) => item.id));
    for (const entry of fresh) if (accepted.has(entry.facts.id)) files.current.set(entry.facts.id, entry.file);
    commit(() => state);
    return notices;
  }, [commit]);

  const remove = useCallback((id: string) => {
    forgetMissing(commit((state) => removeFromUploadList(state, id)));
  }, [commit, forgetMissing]);

  /** «Limpiar lista»: quita lo que espera y lo que falló. */
  const clearWaiting = useCallback(() => {
    forgetMissing(commit((state) => state.items
      .filter((item) => item.status === "queued" || item.status === "error")
      .reduce((acc, item) => removeFromUploadList(acc, item.id), state)));
  }, [commit, forgetMissing]);

  /** Lo subido y lo duplicado se va de la lista (a los 1,5 s de terminar). */
  const clearFinished = useCallback(() => {
    forgetMissing(commit(clearFinishedUploads));
  }, [commit, forgetMissing]);

  const moveTo = useCallback((id: string, page: number) => {
    commit((state) => moveToPage(state, id, page));
  }, [commit]);

  const moveBy = useCallback((id: string, delta: -1 | 1) => {
    commit((state) => moveByOne(state, id, delta));
  }, [commit]);

  const resort = useCallback((sortBy: UploadSortBy) => {
    commit((state) => resortUploadList(state, sortBy));
  }, [commit]);

  /** «Cambiar el fichero» de una fila con error: misma tanda y página. Devuelve
   *  el aviso si el fichero nuevo no vale. */
  const replace = useCallback((id: string, file: File): string | null => {
    const item = listRef.current.items.find((row) => row.id === id);
    if (!item) return null;
    const facts = { name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type || undefined };
    const notice = uploadFileNotice(facts, item.tacoNumber != null ? "perInvoice" : "digital");
    if (notice) return notice;
    const before = listRef.current;
    if (commit((state) => replaceFile(state, id, facts)) !== before) files.current.set(id, file);
    return null;
  }, [commit]);

  /**
   * «Subir»: abre las tandas que hacen falta (una por bloque; si una falla,
   * no se sube nada), y sube cada fichero con su tanda y su página (el taco
   * entero, con wholeTaco). Las filas con error conservan tanda y página para
   * el reintento.
   */
  const upload = useCallback(async (target: UploadTarget, mode: UploadListMode): Promise<UploadOutcome> => {
    if (busy.current) return { error: "Ya se está subiendo: espera a que termine." };
    const plan = planNewBatches(listRef.current, mode);
    if ("error" in plan) return { error: plan.error };

    busy.current = true;
    setPending(true);
    try {
      for (const block of plan.blocks) {
        const started = await startUploadBatch({
          clientId: target.clientId,
          candidateClientIds: target.clientId ? [] : target.candidateClientIds,
          periodType: target.periodType,
          periodMonth: target.periodMonth,
          periodYear: target.periodYear,
          invoiceType: target.type,
          fileCount: block.length,
          kind: mode === "perInvoice" ? "PER_INVOICE" : "DIGITAL",
        });
        if ("error" in started) return { error: started.error };
        batches.current.set(started.batchId, { tacoNumber: started.tacoNumber, fileCount: block.length });
        commit((state) => assignBatch(state, block, { id: started.batchId, tacoNumber: started.tacoNumber }));
      }

      const rows = listRef.current.items.filter(
        (item) => (item.status === "queued" || item.status === "error") && files.current.has(item.id),
      );
      const counts = new Map<string, { uploaded: number; duplicates: number }>();
      const bump = (batchId: string | undefined, key: "uploaded" | "duplicates") => {
        if (!batchId) return;
        const count = counts.get(batchId) ?? { uploaded: 0, duplicates: 0 };
        count[key] += 1;
        counts.set(batchId, count);
      };
      const wholeTacos: BatchOutcome[] = [];
      const startedRows = new Set<string>();

      const results = await uploadFilesDirect(
        rows.map((row) => files.current.get(row.id) as File),
        target.clientId
          ? { clientId: target.clientId, periodType: target.periodType, periodMonth: target.periodMonth, periodYear: target.periodYear, type: target.type }
          : { candidateClientIds: target.candidateClientIds, periodType: target.periodType, periodMonth: target.periodMonth, periodYear: target.periodYear, type: target.type },
        UPLOAD_CONCURRENCY,
        (index) => {
          const id = rows[index]?.id;
          if (!id || startedRows.has(id)) return;
          startedRows.add(id);
          commit((state) => markUploading(state, id));
        },
        (index, result) => {
          const row = rows[index];
          if (!row) return;
          if (result.status === "taco-pdf") {
            wholeTacos.push({ kind: "wholePdf", batchId: result.batchId, tacoNumber: result.tacoNumber, pageCount: result.pageCount });
            commit((state) => applyUploadResult(state, row.id, { status: "ok" }));
          } else if (result.status === "ok") {
            bump(row.batchId, "uploaded");
            commit((state) => applyUploadResult(state, row.id, { status: "ok" }));
          } else if (result.status === "duplicate") {
            bump(row.batchId, "duplicates");
            commit((state) => applyUploadResult(state, row.id, { status: "duplicate", of: result.of }));
          } else {
            commit((state) => applyUploadResult(state, row.id, { status: "error", message: result.message, code: result.code }));
          }
        },
        (index): UploadBatchRef | undefined => {
          const row = rows[index];
          if (!row) return undefined;
          if (mode === "wholePdf" && !row.batchId) return { wholeTaco: true };
          return row.batchId && row.position ? { uploadBatchId: row.batchId, uploadPosition: row.position } : undefined;
        },
      );

      const outcomes: BatchOutcome[] = [];
      for (const batchId of new Set(rows.map((row) => row.batchId).filter((id): id is string => !!id))) {
        const info = batches.current.get(batchId);
        const count = counts.get(batchId) ?? { uploaded: 0, duplicates: 0 };
        if (!info) continue;
        outcomes.push(info.tacoNumber != null
          ? { kind: "perInvoice", batchId, tacoNumber: info.tacoNumber, pageCount: info.fileCount, ...count }
          : { kind: "digital", batchId, fileCount: info.fileCount, uploaded: count.uploaded });
      }
      return {
        ok: results.filter((result) => result.status === "ok" || result.status === "taco-pdf").length,
        duplicates: results.filter((result) => result.status === "duplicate").length,
        errors: results.filter((result) => result.status === "error").length,
        batches: [...outcomes, ...wholeTacos],
      };
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [commit]);

  // Cerrar o recargar la pestaña corta lo que se está subiendo. Cambiar de
  // página dentro de la app no: la cola de uploadFilesDirect sigue.
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  return { list, pending, add, remove, clearWaiting, clearFinished, moveTo, moveBy, resort, replace, upload };
}

"use client";

/**
 * Subida de facturas desde el navegador. El binario se envía a `/api/uploads`
 * (multipart) y la app lo sube a Garage por dentro (red interna). Antes la
 * subida iba directa navegador→Supabase con URL firmada; con Garage interno la
 * app hace de proxy. El servidor valida tenancy/periodo/magic-bytes, deduplica
 * por hash y crea Invoice + Document.
 *
 * Se mantiene el pool de concurrencia para lotes grandes.
 */

export type UploadStatus =
  | "queued"
  | "hashing"
  | "uploading"
  | "registering"
  | "ok"
  | "duplicate"
  | "error";

export type UploadMeta = {
  /** Modo un-cliente: id del cliente destino. */
  clientId?: string;
  /** Modo "clasificar entre varios": ids de empresas candidatas. El server
   *  sube al buzón "Sin clasificar" y rutea por CIF tras el OCR. */
  candidateClientIds?: string[];
  periodType: "MONTHLY" | "QUARTERLY";
  periodMonth: number;
  periodYear: number;
  /** "UNKNOWN" = subido como "Detectar automáticamente": el OCR detecta el tipo
   *  y el gestor lo confirma en la revisión. */
  type: "PURCHASE" | "SALE" | "UNKNOWN";
};

export type UploadResult =
  | { status: "ok"; invoiceId: string }
  | { status: "duplicate"; of: string }
  | { status: "error"; message: string };

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const err = body?.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  } catch {
    /* respuesta sin json */
  }
  return fallback;
}

export async function uploadFileDirect(
  file: File,
  meta: UploadMeta,
  onStatus: (s: UploadStatus) => void,
): Promise<UploadResult> {
  try {
    onStatus("uploading");

    const form = new FormData();
    form.set("file", file);
    if (meta.clientId) form.set("clientId", meta.clientId);
    if (meta.candidateClientIds && meta.candidateClientIds.length > 0) {
      form.set("candidateClientIds", JSON.stringify(meta.candidateClientIds));
    }
    form.set("periodType", meta.periodType);
    form.set("periodMonth", String(meta.periodMonth));
    form.set("periodYear", String(meta.periodYear));
    form.set("type", meta.type);

    const res = await fetch("/api/uploads", { method: "POST", body: form });
    if (!res.ok) {
      const msg = await readErrorMessage(res, `Error al subir (${res.status})`);
      return { status: "error", message: msg };
    }
    const data = await res.json();
    if (data.duplicate) {
      return { status: "duplicate", of: data.of };
    }
    return { status: "ok", invoiceId: data.invoiceId };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message ?? "Error desconocido" };
  }
}

/**
 * Procesa N archivos con concurrencia limitada (pool de workers).
 *  - 3 archivos a la vez balancea velocidad sin saturar al servidor ni el
 *    ancho de banda del cliente.
 */
export async function uploadFilesDirect(
  files: File[],
  meta: UploadMeta,
  concurrency: number,
  onItemStatus: (idx: number, status: UploadStatus) => void,
  onItemDone: (idx: number, result: UploadResult) => void,
): Promise<UploadResult[]> {
  const results: UploadResult[] = new Array(files.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= files.length) return;
      const r = await uploadFileDirect(files[i], meta, (s) => onItemStatus(i, s));
      results[i] = r;
      onItemDone(i, r);
    }
  }

  const pool = Array.from(
    { length: Math.max(1, Math.min(concurrency, files.length)) },
    worker,
  );
  await Promise.all(pool);
  return results;
}

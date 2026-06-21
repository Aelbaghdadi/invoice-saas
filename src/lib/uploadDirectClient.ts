"use client";

/**
 * Subida directa cliente → Supabase Storage en dos pasos:
 *  1. POST /api/uploads/sign con la metadata (incluye hash y primeros
 *     32B del archivo). El server valida tenancy/cierre/magic-bytes y
 *     devuelve una signed upload URL — o `{ duplicate: true }` si el
 *     hash ya existe (sin gastar storage).
 *  2. PUT al signedUrl con el binario.
 *  3. POST /api/uploads/register con storageKey + metadata. El server
 *     re-chequea duplicate (race) y crea Invoice + Document.
 *
 * Asi esquivamos el body limit de Server Actions de Next 16 (~1MB,
 * tope ~4MB en Vercel) y soportamos lotes grandes sin troceo en
 * cliente. El servidor nunca recibe el binario.
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
  /** "UNKNOWN" = subido como "No lo sé": el OCR detecta el tipo y el gestor
   *  lo confirma en la revisión. */
  type: "PURCHASE" | "SALE" | "UNKNOWN";
};

export type UploadResult =
  | { status: "ok"; invoiceId: string }
  | { status: "duplicate"; of: string }
  | { status: "error"; message: string };

function bufferToBase64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    onStatus("hashing");
    const buf = await file.arrayBuffer();
    const hashBytes = await crypto.subtle.digest("SHA-256", buf);
    const fileHash = bufferToHex(hashBytes);
    const headBase64 = bufferToBase64(buf.slice(0, 32));

    const signRes = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: meta.clientId,
        candidateClientIds: meta.candidateClientIds,
        periodType: meta.periodType,
        periodMonth: meta.periodMonth,
        periodYear: meta.periodYear,
        type: meta.type,
        filename: file.name,
        fileType: file.type,
        fileSize: file.size,
        fileHash,
        headBase64,
      }),
    });

    if (!signRes.ok) {
      const msg = await readErrorMessage(signRes, `Error de autorizacion (${signRes.status})`);
      return { status: "error", message: msg };
    }
    const signData = await signRes.json();
    if (signData.duplicate) {
      return { status: "duplicate", of: signData.of };
    }

    onStatus("uploading");
    const putRes = await fetch(signData.signedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": signData.realMime,
        "x-upsert": "false",
      },
      body: file,
    });
    if (!putRes.ok) {
      return { status: "error", message: `Storage rechazo el archivo (${putRes.status})` };
    }

    onStatus("registering");
    const regRes = await fetch("/api/uploads/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: meta.clientId,
        candidateClientIds: meta.candidateClientIds,
        periodType: meta.periodType,
        periodMonth: meta.periodMonth,
        periodYear: meta.periodYear,
        type: meta.type,
        filename: file.name,
        fileType: signData.realMime,
        fileSize: file.size,
        fileHash,
        storageKey: signData.storageKey,
      }),
    });
    if (!regRes.ok) {
      const msg = await readErrorMessage(regRes, `Error al registrar (${regRes.status})`);
      return { status: "error", message: msg };
    }
    const regData = await regRes.json();
    if (regData.duplicate) {
      return { status: "duplicate", of: regData.of };
    }
    return { status: "ok", invoiceId: regData.invoiceId };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message ?? "Error desconocido" };
  }
}

/**
 * Procesa N archivos con concurrencia limitada (pool de workers).
 *  - 3 archivos a la vez es un balance razonable: paraleliza la
 *    subida sin sobrecargar el rate limit de Storage ni el ancho de
 *    banda del cliente.
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

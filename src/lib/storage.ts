import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

/**
 * Capa de almacenamiento de ficheros sobre S3 (Garage), reemplaza a Supabase
 * Storage. Garage corre en la red INTERNA de Coolify, así que la app nunca
 * expone URLs directas del storage: sube (PutObject) y sirve (GetObject) ella
 * misma; el navegador habla solo con la app (proxy), nunca con Garage.
 *
 * `forcePathStyle: true` es OBLIGATORIO con Garage (no usa virtual-hosted style).
 * Toda la config se lee de entorno; nada hardcodeado.
 */
const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION || "garage";
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;
const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false";

export const STORAGE_BUCKET = process.env.S3_BUCKET || "facturas";

let _client: S3Client | null = null;

function getClient(): S3Client | null {
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!_client) {
    _client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
      // Garage (y otros S3-compatibles) suelen rechazar los checksums CRC32 que
      // el SDK v3 añade por defecto a cada PutObject ("WHEN_SUPPORTED"), lo que
      // hace fallar las subidas. Los limitamos a cuando son obligatorios.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _client;
}

/** ¿Hay credenciales de almacenamiento configuradas? */
export function isStorageConfigured(): boolean {
  return getClient() !== null;
}

/** Sube un objeto (sobrescribe si existe). */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType?: string,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Almacenamiento (S3) no configurado");
  await client.send(
    new PutObjectCommand({ Bucket: STORAGE_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Descarga un objeto completo como Buffer. `timeoutMs` corta esta llamada (la
 * respuesta y la lectura del cuerpo) sin tocar el cliente, igual que en
 * objectExists: con Garage colgado cada peticion dejaba un socket ocupado.
 */
export async function getObjectBytes(key: string, options: { timeoutMs?: number } = {}): Promise<Buffer> {
  const client = getClient();
  if (!client) throw new Error("Almacenamiento (S3) no configurado");
  const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }), signal ? { abortSignal: signal } : {});
    if (!res.Body) throw new Error(`Objeto sin contenido: ${key}`);
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    // Cortado a mitad del cuerpo, el SDK no da un AbortError sino un
    // «aborted» (ECONNRESET): sin esto no se reconocia como tope.
    if (signal?.aborted) {
      const timeout = new Error(`Almacenamiento: timeout (${options.timeoutMs! / 1000} s) descargando ${key}`, { cause: err });
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw err;
  }
}

/** El almacenamiento no ha mandado nada durante el tope de inactividad. */
export class StorageIdleError extends Error {
  constructor(key: string, idleMs: number) {
    super(`Almacenamiento: ${idleMs / 1000} s sin responder descargando ${key}`);
    this.name = "StorageIdleError";
  }
}

/**
 * El objeto por trozos, sin cargarlo entero en memoria (la exportacion de los
 * datos de un cliente, F-044). El tope es de inactividad: salta si Garage
 * pasa `idleMs` sin mandar nada mientras se le esta pidiendo. No corre
 * mientras el que lee no pide el trozo siguiente (con la contrapresion, un
 * navegador lento no corta el original; revision 1 del PR #15, punto 11).
 */
export async function getObjectChunks(key: string, options: { idleMs: number }): Promise<AsyncIterable<Uint8Array>> {
  const client = getClient();
  if (!client) throw new Error("Almacenamiento (S3) no configurado");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), options.idleMs);
  };
  const idle = (err: unknown) => (controller.signal.aborted ? new StorageIdleError(key, options.idleMs) : err);

  arm();
  let body: AsyncIterable<Uint8Array>;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }), { abortSignal: controller.signal });
    if (!res.Body) throw new Error(`Objeto sin contenido: ${key}`);
    body = res.Body as AsyncIterable<Uint8Array>;
  } catch (err) {
    throw idle(err);
  } finally {
    clearTimeout(timer);
  }
  return (async function* () {
    const it = body[Symbol.asyncIterator]();
    try {
      for (;;) {
        arm();
        const next = await it.next().catch((err) => {
          throw idle(err);
        });
        clearTimeout(timer);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      clearTimeout(timer);
      // Cortado a mitad (o por el que lee): la conexion se cierra.
      if (!controller.signal.aborted) controller.abort();
    }
  })();
}

/**
 * ¿El error del SDK dice que el objeto no existe? Garage y el SDK lo dan de
 * varias formas: NoSuchKey en un GET, NotFound (sin cuerpo) en un HEAD, o
 * solo el 404 en los metadatos. Cualquier otra cosa es un fallo de verdad.
 * NoSuchBucket tambien es un 404, pero es configuracion (bucket borrado o
 * S3_BUCKET mal puesto), no "este objeto no esta".
 */
export function isStorageNotFound(err: unknown): boolean {
  const e = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "NoSuchBucket" || e.Code === "NoSuchBucket") return false;
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey"
    || e.$metadata?.httpStatusCode === 404;
}

/** Borra un objeto (no falla si no existe). */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: STORAGE_BUCKET, Key: key })).catch(() => null);
}

/**
 * ¿Existe el objeto? (HeadObject)
 *
 * `timeoutMs` corta la espera de esta llamada sin tocar el cliente: el
 * S3Client no tiene timeout (uno global corto romperia las subidas de 25 MB)
 * y una pagina que espera a Garage colgado no llega a pintarse.
 * Un 404 es false sin mas; cualquier otro fallo, incluido el timeout, tambien
 * da false pero deja aviso en el log, para que "no existe" no tape una caida.
 */
export async function objectExists(key: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }),
      options.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : {},
    );
    return true;
  } catch (err) {
    if (!isStorageNotFound(err)) {
      // Un HEAD no trae cuerpo: sin el codigo HTTP, un 403 de credenciales y
      // un 503 salen los dos como "Unknown: UnknownError".
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[storage] HeadObject ${key} fallo: ${name}${status ? ` (HTTP ${status})` : ""}: ${message}`);
    }
    return false;
  }
}

/** ¿Responde el almacenamiento? HeadBucket con timeout, para /api/health.
 *  Sin credenciales, false. El detalle del fallo va al log, no a la respuesta. */
export async function storageReachable(timeoutMs: number): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: STORAGE_BUCKET }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    console.warn(`[health] almacenamiento no disponible: ${err instanceof Error ? err.name : "Error"}${status ? ` (HTTP ${status})` : ""}`);
    return false;
  }
}

/** Borra todos los objetos bajo un prefijo (p.ej. "<clientId>/"). Usado por el
 *  reset de demo. S3 no tiene carpetas: borramos por prefijo en lotes. */
export async function deletePrefix(prefix: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  let token: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({ Bucket: STORAGE_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => Boolean(k))
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: STORAGE_BUCKET, Delete: { Objects: objects } }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Sanitiza un nombre de archivo para usarlo como key de almacenamiento.
 * Quita tildes/ñ (NFKD + strip de diacríticos) y cualquier carácter que no sea
 * letra/número ASCII, punto, guion o guion bajo. El nombre original se conserva
 * intacto en `Invoice.filename`; aquí solo cambiamos el path de Storage.
 */
export function sanitizeFilenameForStorage(name: string): string {
  const stripped = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const safe = stripped
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return safe || "file";
}

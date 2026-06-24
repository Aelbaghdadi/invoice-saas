import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
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

/** Descarga un objeto completo como Buffer. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const client = getClient();
  if (!client) throw new Error("Almacenamiento (S3) no configurado");
  const res = await client.send(new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Objeto sin contenido: ${key}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/** Borra un objeto (no falla si no existe). */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: STORAGE_BUCKET, Key: key })).catch(() => null);
}

/** ¿Existe el objeto? (HeadObject) */
export async function objectExists(key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }));
    return true;
  } catch {
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

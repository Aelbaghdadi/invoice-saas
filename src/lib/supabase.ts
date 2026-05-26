import { createClient } from "@supabase/supabase-js";

export function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Sanitiza un nombre de archivo para usarlo como key de Supabase Storage.
 *
 * Supabase rechaza con "Invalid key" si la key contiene caracteres
 * no-ASCII (tildes, ñ, símbolos raros), espacios sin escapar o secuencias
 * que no encajan en su regex interno. Como el nombre que sube el cliente
 * puede ser cualquier cosa ("Factura Vallés.pdf", "Nº4-julio.pdf"...),
 * normalizamos antes de construir la key.
 *
 * El nombre original se conserva intacto en `Invoice.filename` para
 * mostrarlo en la UI; aquí solo cambiamos el path de Storage.
 */
export function sanitizeFilenameForStorage(name: string): string {
  // NFKD descompone "é" en "e" + diacrítico, y luego strip de diacríticos.
  const stripped = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // Reemplaza cualquier cosa que no sea letra/numero ASCII, punto, guion
  // o guion bajo. Colapsa secuencias y recorta extremos.
  const safe = stripped
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return safe || "file";
}

/** Palabras que la IA escribe a veces en vez de un campo vacío. */
const EMPTY_WORDS = new Set(["null", "undefined", "none", "n/a"]);

/**
 * Un texto leído por la IA (Gemini), limpio: sin espacios a los lados y null
 * si viene vacío. Gemini devuelve a veces la palabra «null» entre comillas en
 * vez de null, y se guardaba tal cual como nombre del proveedor.
 */
export function ocrText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text && !EMPTY_WORDS.has(text.toLowerCase()) ? text : null;
}

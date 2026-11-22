/**
 * La caja de un taco (B-R10) y la que se propone al guardarlo (B-R11). La
 * etiqueta es texto libre: lo propuesto solo rellena el campo. Módulo puro:
 * las etiquetas usadas las lee el servidor (tacos.ts) y aquí se elige.
 */
import type { PaperBoxMode } from "@prisma/client";
import { normalizeSearch } from "@/lib/listing";

export const BOX_LABEL_MIN = 2;
export const BOX_LABEL_MAX = 80;
/** El nombre del cliente se recorta para que la etiqueta propuesta quepa en 80. */
export const BOX_CLIENT_NAME_MAX = 50;
export const BOX_SUGGESTIONS_MAX = 50;
export const BOX_LABEL_LENGTH_ERROR = "La etiqueta de la caja tiene que tener entre 2 y 80 caracteres.";

// Caracteres de control y de formato (invisibles: saltos raros, anchura cero,
// cambios de sentido del texto). No se ven al escribir la etiqueta, así que se
// quitan en vez de dar un error que nadie entendería.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

const characterCount = (text: string) => [...text].length;

/** Etiqueta recortada, con los espacios juntados y sin caracteres de control. */
export function normalizeBoxLabel(raw: string): { ok: true; label: string } | { ok: false; error: string } {
  const label = raw
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const length = characterCount(label);
  if (length < BOX_LABEL_MIN || length > BOX_LABEL_MAX) return { ok: false, error: BOX_LABEL_LENGTH_ERROR };
  return { ok: true, label };
}

/** Para comparar etiquetas: sin tildes, en minúsculas y con los espacios juntados. */
export function boxLabelKey(label: string): string {
  return normalizeSearch(label);
}

/** hidden: de un taco que quien pregunta no ve (otro cliente). Cuenta para la
 *  propuesta y para «Caja nueva», pero no se sugiere: la etiqueta suele llevar
 *  el nombre del cliente. */
export type BoxUse = { label: string; filedAt: Date; hidden?: boolean };

export type BoxProposalInput = {
  mode: PaperBoxMode;
  /** null: taco de varios clientes. */
  clientName: string | null;
  /** «2026» o «2025-26»; sin cliente, el año natural del lote. */
  fiscalYearLabel: string;
  /** Las del ámbito (B-R11): las de los tacos del cliente y ejercicio, o las de la asesoría. */
  used: readonly BoxUse[];
  /** Las demás etiquetas de la asesoría: solo para las sugerencias. */
  others?: readonly BoxUse[];
};

function clientNameForBox(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  const characters = [...clean];
  if (characters.length <= BOX_CLIENT_NAME_MAX) return clean;
  return `${characters.slice(0, BOX_CLIENT_NAME_MAX - 1).join("").trimEnd()}…`;
}

/** «Panadería López · 2026 · Caja », «Varios clientes · 2026 · Caja » o, con todas juntas, «Caja ». */
export function boxLabelPrefix(input: Pick<BoxProposalInput, "mode" | "clientName" | "fiscalYearLabel">): string {
  if (input.mode === "SHARED") return "Caja ";
  const client = input.clientName?.trim() ? clientNameForBox(input.clientName) : "Varios clientes";
  return `${client} · ${input.fiscalYearLabel} · Caja `;
}

/** «nº», «n.º», «n°», «no.», «núm.» o «número» delante de un número, opcional. Sobre
 *  el texto sin tildes y en minúsculas (boxLabelKey, normalizeSearch). */
export const NUMBER_SIGN_PATTERN = String.raw`(?:n(?:\.?\s*[º°o]|um(?:ero)?)\.?\s*)?`;

// La forma de «Todas juntas» escrita a mano: «Caja 12», «caja nº 12».
const SHARED_FORM_RE = new RegExp(String.raw`^caja\s*-?\s*${NUMBER_SIGN_PATTERN}\d+$`);
// «… caja 12» al final, con «caja» como palabra suelta.
const BOX_NUMBER_RE = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])caja\s*-?\s*${NUMBER_SIGN_PATTERN}(\d+)$`, "u");

/** ¿Cuenta esta etiqueta en el modo? PER_CLIENT_YEAR: todas salvo la forma «Caja N» sin « · »; SHARED: sin « · ». */
export function countsForMode(mode: PaperBoxMode, label: string): boolean {
  const hasSeparator = label.includes("·");
  if (mode === "SHARED") return !hasSeparator;
  return hasSeparator || !SHARED_FORM_RE.test(boxLabelKey(label));
}

/**
 * El nº de caja del final de la etiqueta («… · Caja 12», «López 2026 caja nº 3»), o
 * null. Solo el que va detrás de «caja»: el número suelto del final de una
 * etiqueta escrita a mano suele ser el año («López 2026», «López 2025-26») y
 * «Caja nueva» acabaría en la «Caja 2027».
 */
export function boxNumberOf(label: string): number | null {
  const match = BOX_NUMBER_RE.exec(boxLabelKey(label));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** De la más reciente a la más antigua; con la misma fecha, la de número mayor. */
function byMostRecent(uses: readonly BoxUse[]): BoxUse[] {
  return [...uses].sort(
    (a, b) =>
      b.filedAt.getTime() - a.filedAt.getTime() ||
      (boxNumberOf(b.label) ?? -1) - (boxNumberOf(a.label) ?? -1) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

export function proposeBoxLabels(input: BoxProposalInput): {
  proposed: string;
  next: string;
  lastUsed: string | null;
  suggestions: string[];
} {
  const prefix = boxLabelPrefix(input);
  const counting = byMostRecent(input.used.filter((use) => countsForMode(input.mode, use.label)));
  const lastUsed = counting[0]?.label ?? null;

  let highest: number | null = null;
  for (const use of counting) {
    const number = boxNumberOf(use.label);
    if (number != null && (highest == null || number > highest)) highest = number;
  }
  // Sin ninguna, la propuesta ya es la 1 y la nueva, la 2. Con etiquetas
  // pero ninguna con «caja N», la nueva es la 1.
  const nextNumber = counting.length === 0 ? 2 : highest == null ? 1 : highest + 1;

  const rest = byMostRecent([
    ...input.used.filter((use) => !countsForMode(input.mode, use.label)),
    ...(input.others ?? []),
  ]);
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const use of [...counting, ...rest]) {
    if (use.hidden) continue;
    const key = boxLabelKey(use.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(use.label);
    if (suggestions.length === BOX_SUGGESTIONS_MAX) break;
  }

  return { proposed: lastUsed ?? `${prefix}1`, next: `${prefix}${nextNumber}`, lastUsed, suggestions };
}

/**
 * Los filtros de la pestaña Tacos del archivo tal como van en la URL (5.6).
 * Módulo puro: lo usan la página, sus filtros y los avisos que enlazan aquí.
 */
import { firstSearchParam, parseIntInRange, parsePage } from "@/lib/listing";

export type TacoListEstado = "todos" | "sin-guardar" | "guardados" | "devueltos" | "por-dividir" | "anulados" | "digitales";

export const TACO_LIST_ESTADOS: readonly TacoListEstado[] = [
  "todos", "sin-guardar", "guardados", "devueltos", "por-dividir", "anulados", "digitales",
];

export const TACOS_PATH = "/dashboard/archivo/tacos";

export type TacoListParams = {
  estado?: string | string[];
  cliente?: string | string[];
  year?: string | string[];
  caja?: string | string[];
  page?: string | string[];
};

export type TacoListQuery = {
  estado: TacoListEstado;
  /** Un cliente, «varios» (los de «Clasificar entre varios») o null (todos). */
  clientId: string | null;
  /** Año del lote. */
  year: number | null;
  /** Texto que contiene la caja. */
  caja: string;
  page: number;
};

/** Lo que piden los parámetros; lo que no se entiende es «todos». */
export function parseTacoListParams(params: TacoListParams): TacoListQuery {
  const estado = firstSearchParam(params.estado);
  const clientId = (firstSearchParam(params.cliente) ?? "").trim().slice(0, 64);
  return {
    estado: TACO_LIST_ESTADOS.includes(estado as TacoListEstado) ? (estado as TacoListEstado) : "todos",
    clientId: clientId || null,
    year: parseIntInRange(firstSearchParam(params.year), 2000, 2100) ?? null,
    caja: (firstSearchParam(params.caja) ?? "").trim().slice(0, 80),
    page: parsePage(firstSearchParam(params.page)),
  };
}

/** El enlace de la pestaña Tacos con esos filtros; los que valen por defecto no van en la URL. */
export function tacosHref(query: Partial<TacoListQuery>): string {
  const sp = new URLSearchParams();
  if (query.estado && query.estado !== "todos") sp.set("estado", query.estado);
  if (query.clientId) sp.set("cliente", query.clientId);
  if (query.year) sp.set("year", String(query.year));
  if (query.caja?.trim()) sp.set("caja", query.caja.trim());
  if (query.page && query.page > 1) sp.set("page", String(query.page));
  const qs = sp.toString();
  return qs ? `${TACOS_PATH}?${qs}` : TACOS_PATH;
}

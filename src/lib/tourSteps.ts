/**
 * Recorrido guiado por la app («Recorrido» en la barra de arriba): los pasos
 * y en qué pantalla va cada uno. Puro, sin React ni Next: lo pinta
 * `src/components/tour/TourProvider.tsx`.
 *
 * Cada paso resalta un bloque marcado con `data-tour="…"` en su pantalla. Si
 * el bloque no está (una lista vacía, un lote sin abrir), el paso sale en el
 * centro, sin resaltar nada: el recorrido no se rompe por los datos.
 */
import type { Role } from "@prisma/client";

export type TourPlacement = "right" | "left" | "bottom" | "top";

export type TourStep = {
  /** Agrupa los pasos en la cabecera del cuadro («Subir», «Revisión»…). */
  chapter: string;
  title: string;
  body: string;
  /** A dónde se navega para enseñar el paso. */
  path: string;
  /** Si la pantalla de verdad tiene otra ruta (una redirección, un id), el
   *  prefijo con el que se reconoce. Sin él, la ruta tiene que ser `path`. */
  matchPrefix?: string;
  /** `data-tour` del bloque a resaltar, por orden de preferencia. Sin él, el
   *  paso va en el centro. */
  targets?: string[];
  placement?: TourPlacement;
  /** Lo que se dice si se llega a otra pantalla (p. ej. no hay ninguna
   *  factura por revisar y la revisión no se puede abrir). */
  fallbackBody?: string;
  /** Botón final que lleva a una pantalla y cierra el recorrido. */
  finalAction?: { label: string; path: string };
  /** Solo para estos roles (sin él, para todos los del recorrido). */
  roles?: Role[];
};

/** La revisión no tiene ruta fija: esta página abre una factura por revisar. */
export const TOUR_REVIEW_PATH = "/dashboard/recorrido/revision";
const REVIEW_PREFIX = "/dashboard/worker/review/";
const NO_INVOICE =
  "Para enseñar la revisión hace falta alguna factura por revisar. Sube una y vuelve a empezar el recorrido desde aquí.";

const STEPS: TourStep[] = [
  {
    chapter: "Inicio",
    title: "Bienvenido a Faktury",
    body: "En unos minutos verás el camino de una factura: cómo llega, cómo se lee sola, cómo la revisa tu equipo, cómo sale a A3 y dónde queda archivada. Puedes salir cuando quieras.",
    path: "/dashboard/admin",
    roles: ["ADMIN"],
  },
  {
    chapter: "Inicio",
    title: "Bienvenido a Faktury",
    body: "En unos minutos verás el camino de una factura: cómo llega, cómo se lee sola, cómo la revisas y dónde queda archivada. Puedes salir cuando quieras.",
    path: "/dashboard/worker",
    roles: ["WORKER"],
  },
  {
    chapter: "Panel",
    title: "La asesoría, de un vistazo",
    body: "Cuántas facturas hay, cuántas faltan por validar, cuántas están listas para exportar y cuántas han salido ya a contabilidad. De todos tus clientes a la vez.",
    path: "/dashboard/admin",
    targets: ["panel-cifras"],
    placement: "bottom",
    roles: ["ADMIN"],
  },
  {
    chapter: "Panel",
    title: "Cómo va cada cliente",
    body: "Los clientes con más trabajo pendiente salen primero, con lo que lleva hecho cada uno.",
    path: "/dashboard/admin",
    targets: ["panel-progreso"],
    placement: "left",
    roles: ["ADMIN"],
  },
  {
    chapter: "Subir",
    title: "Así llegan las facturas",
    body: "Para un cliente o para varios a la vez: con «Clasificar entre varios» subes un montón mezclado y cada factura va a su empresa por el CIF. Tus clientes también pueden subirlas desde su móvil.",
    path: "/dashboard/worker/upload",
    targets: ["subir-modo"],
    placement: "right",
  },
  {
    chapter: "Subir",
    title: "El lote se propone solo",
    body: "Faktury propone el mes que toca (en noviembre, octubre) y avisa si ya hay un lote abierto o si el periodo está cerrado.",
    path: "/dashboard/worker/upload",
    targets: ["subir-lote", "subir-modo"],
    placement: "right",
  },
  {
    chapter: "Subir",
    title: "¿Es papel?",
    body: "Si escaneáis aquí el papel que trae el cliente, márcalo: forma un taco con su número, lo guardáis en una caja y después sabéis en qué página está cada factura.",
    path: "/dashboard/worker/upload",
    targets: ["subir-papel"],
    placement: "right",
  },
  {
    chapter: "Subir",
    title: "Arrastra y listo",
    body: "PDF, factura electrónica en XML y fotos del móvil, también del iPhone. Se leen solas en segundo plano: no hace falta esperar delante de la pantalla.",
    path: "/dashboard/worker/upload",
    targets: ["subir-zona"],
    placement: "right",
  },
  {
    chapter: "Revisión",
    title: "La factura, al lado de sus datos",
    body: "A la izquierda, el original. Al pulsar un dato de la derecha, se marca en la factura de dónde lo ha leído.",
    path: TOUR_REVIEW_PATH,
    matchPrefix: REVIEW_PREFIX,
    targets: ["revision-visor"],
    placement: "right",
    fallbackBody: NO_INVOICE,
  },
  {
    chapter: "Revisión",
    title: "Leído solo",
    body: "Proveedor, NIF, número y fecha salen de la lectura. Los datos de tu cliente no se leen: se ponen solos, para que no haya errores.",
    path: TOUR_REVIEW_PATH,
    matchPrefix: REVIEW_PREFIX,
    targets: ["revision-partes"],
    placement: "left",
    fallbackBody: NO_INVOICE,
  },
  {
    chapter: "Revisión",
    title: "Cada tipo de IVA, comprobado",
    body: "Una línea por tipo de IVA, con recargo de equivalencia y retención si los hay. Si una cuota no cuadra con su base, lo marca y propone el arreglo.",
    path: TOUR_REVIEW_PATH,
    matchPrefix: REVIEW_PREFIX,
    targets: ["revision-iva"],
    placement: "left",
    fallbackBody: NO_INVOICE,
  },
  {
    chapter: "Revisión",
    title: "Las cuentas contables",
    body: "Salen del plan de cuentas de cada cliente. Lo que corriges aquí se aprende: la próxima factura de ese proveedor llega ya con sus cuentas.",
    path: TOUR_REVIEW_PATH,
    matchPrefix: REVIEW_PREFIX,
    targets: ["revision-cuentas"],
    placement: "left",
    fallbackBody: NO_INVOICE,
  },
  {
    chapter: "Revisión",
    title: "Validar y a la siguiente",
    body: "Al validar, pasas directamente a la siguiente del lote. También puedes rechazarla con su motivo, dejarla para luego o dividir un PDF que trae varias facturas.",
    path: TOUR_REVIEW_PATH,
    matchPrefix: REVIEW_PREFIX,
    targets: ["revision-acciones"],
    placement: "top",
    fallbackBody: NO_INVOICE,
  },
  {
    chapter: "Lotes",
    title: "Cada cliente, cada mes",
    body: "Cada lote dice cuántas facturas faltan por revisar, cuántas tienen incidencias y cuántas están listas. Cuando está todo, se cierra el periodo y nadie lo cambia sin querer.",
    path: "/dashboard/admin/batch",
    targets: ["lotes-lote"],
    placement: "bottom",
    roles: ["ADMIN"],
  },
  {
    chapter: "Lotes",
    title: "Cada cliente, cada mes",
    body: "Cada lote dice cuántas facturas faltan por revisar, cuántas tienen incidencias y cuántas están listas.",
    path: "/dashboard/worker/batch",
    targets: ["lotes-lote"],
    placement: "bottom",
    roles: ["WORKER"],
  },
  {
    chapter: "A3",
    title: "Exportar a A3",
    body: "Eliges cliente, periodo y tipo de factura.",
    path: "/dashboard/admin/export",
    targets: ["exportar-filtros"],
    placement: "right",
    roles: ["ADMIN"],
  },
  {
    chapter: "A3",
    title: "El Excel, listo para importar",
    body: "Sale con las columnas de la plantilla de A3 Asesor, una línea por tipo de IVA. Al exportar, cada factura recibe su número de registro del libro.",
    path: "/dashboard/admin/export",
    targets: ["exportar-resumen"],
    placement: "left",
    roles: ["ADMIN"],
  },
  {
    chapter: "Archivo",
    title: "¿Dónde está?",
    body: "Cualquier factura por número, proveedor, NIF, importe o número de registro. Si el original es papel, te dice la caja, el taco y la página.",
    path: "/dashboard/archivo",
    targets: ["archivo-buscador"],
    placement: "bottom",
  },
  {
    chapter: "Archivo",
    title: "El archivo de cada cliente",
    body: "Por ejercicio: cuántas son electrónicas y cuántas papel, cuáles tienen número de registro y hasta cuándo hay que guardarlas.",
    path: "/dashboard/archivo",
    targets: ["archivo-resumen"],
    placement: "top",
  },
  {
    chapter: "Fin",
    title: "¿Lo probamos con una factura vuestra?",
    body: "Hazle una foto con la tablet o el móvil, súbela y mira cómo se lee sola.",
    path: "/dashboard/archivo",
    finalAction: { label: "Subir una factura", path: "/dashboard/worker/upload" },
  },
];

/** Los roles que tienen recorrido: el cliente tiene su propio portal. */
export function hasTour(role: Role): boolean {
  return role === "ADMIN" || role === "WORKER";
}

export function tourStepsFor(role: Role): TourStep[] {
  if (!hasTour(role)) return [];
  return STEPS.filter((s) => !s.roles || s.roles.includes(role));
}

/** ¿Esta ruta es la pantalla del paso? */
export function isOnStepPage(step: TourStep, pathname: string): boolean {
  if (step.matchPrefix) return pathname.startsWith(step.matchPrefix);
  return pathname === step.path;
}

/** Selector del primer bloque del paso, o null si va en el centro. */
export function tourSelectors(step: TourStep): string[] {
  return (step.targets ?? []).map((t) => `[data-tour="${t}"]`);
}

export type TourRect = { top: number; left: number; width: number; height: number };
export type TourBox = { top: number; left: number };

/**
 * Dónde va el cuadro del paso: al lado preferido si cabe, si no al lado con
 * más sitio, y siempre dentro de la ventana. `target` null = en el centro.
 */
export function placePopover(
  target: TourRect | null,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: TourPlacement = "bottom",
  gap = 14,
  margin = 12,
): TourBox & { placement: TourPlacement | "center" } {
  const clampLeft = (x: number) => Math.min(Math.max(x, margin), Math.max(margin, viewport.width - popover.width - margin));
  const clampTop = (y: number) => Math.min(Math.max(y, margin), Math.max(margin, viewport.height - popover.height - margin));
  if (!target) {
    return {
      top: clampTop((viewport.height - popover.height) / 2),
      left: clampLeft((viewport.width - popover.width) / 2),
      placement: "center",
    };
  }
  const space: Record<TourPlacement, number> = {
    right: viewport.width - (target.left + target.width) - gap - margin,
    left: target.left - gap - margin,
    bottom: viewport.height - (target.top + target.height) - gap - margin,
    top: target.top - gap - margin,
  };
  const fits: Record<TourPlacement, boolean> = {
    right: space.right >= popover.width,
    left: space.left >= popover.width,
    bottom: space.bottom >= popover.height,
    top: space.top >= popover.height,
  };
  const order: TourPlacement[] = [preferred, ...(["bottom", "right", "left", "top"] as const).filter((p) => p !== preferred)];
  const chosen = order.find((p) => fits[p]);
  const centerY = target.top + target.height / 2 - popover.height / 2;
  const centerX = target.left + target.width / 2 - popover.width / 2;
  switch (chosen) {
    case "right":
      return { top: clampTop(centerY), left: target.left + target.width + gap, placement: "right" };
    case "left":
      return { top: clampTop(centerY), left: target.left - gap - popover.width, placement: "left" };
    case "bottom":
      return { top: target.top + target.height + gap, left: clampLeft(centerX), placement: "bottom" };
    case "top":
      return { top: target.top - gap - popover.height, left: clampLeft(centerX), placement: "top" };
    default:
      // No cabe a ningún lado (un bloque que ocupa la pantalla): abajo a la
      // derecha, encima del bloque.
      return {
        top: clampTop(viewport.height - popover.height - margin),
        left: clampLeft(viewport.width - popover.width - margin),
        placement: "bottom",
      };
  }
}

/** El hueco resaltado: el bloque con un margen, recortado a la ventana. */
export function holeRect(target: TourRect, viewport: { width: number; height: number }, pad = 8): TourRect {
  const top = Math.max(target.top - pad, 4);
  const left = Math.max(target.left - pad, 4);
  const bottom = Math.min(target.top + target.height + pad, viewport.height - 4);
  const right = Math.min(target.left + target.width + pad, viewport.width - 4);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

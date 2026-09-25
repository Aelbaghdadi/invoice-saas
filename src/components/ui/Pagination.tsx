import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageWindow } from "@/lib/listing";

// Singular de los nombres que ya pasan los listados como texto, para no
// poner "de 1 registros" sin tener que cambiar cada llamada.
const SINGULAR: Record<string, string> = {
  facturas: "factura",
  registros: "registro",
  exportaciones: "exportación",
  cierres: "cierre",
  periodos: "periodo",
  incidencias: "incidencia",
  clientes: "cliente",
  cuentas: "cuenta",
};

/**
 * Pie de un listado paginado: "Mostrando 26–50 de 212" y los enlaces de
 * pagina. Son enlaces normales (la pagina va en la URL), asi que funciona sin
 * JavaScript y el boton atras del navegador vuelve a la pagina anterior.
 */
export function Pagination({
  window,
  hrefFor,
  noun = ["factura", "facturas"],
}: {
  window: PageWindow;
  /** URL de una pagina concreta, conservando los filtros actuales. */
  hrefFor: (page: number) => string;
  /** Plural ("facturas") o [singular, plural] (["factura", "facturas"]). */
  noun?: string | readonly [string, string];
}) {
  const { page, totalPages, from, to, total } = window;
  if (total === 0) return null;

  const [singular, plural] = typeof noun === "string" ? [SINGULAR[noun] ?? noun, noun] : noun;

  // Pocas paginas alrededor de la actual; las demas se saltan con "…".
  const pages: (number | "…")[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }

  const base = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[13px] font-medium transition-colors";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
      <p className="text-[12px] text-slate-500 tabular-nums">
        {total === 1 ? (
          <>
            <span className="font-semibold text-slate-700">1</span> {singular}
          </>
        ) : (
          <>
            Mostrando{" "}
            <span className="font-semibold text-slate-700">{from === to ? from : `${from}–${to}`}</span> de{" "}
            <span className="font-semibold text-slate-700">{total}</span> {plural}
          </>
        )}
      </p>
      {totalPages > 1 && (
        <nav className="flex items-center gap-1" aria-label="Paginación">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={`${base} text-slate-600 hover:bg-slate-100`} aria-label="Página anterior">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <span className={`${base} text-slate-300`} aria-hidden>
              <ChevronLeft className="h-4 w-4" />
            </span>
          )}
          {pages.map((p, i) =>
            p === "…" ? (
              <span key={`gap-${i}`} className="px-1 text-[13px] text-slate-400">…</span>
            ) : (
              <Link
                key={p}
                href={hrefFor(p)}
                aria-current={p === page ? "page" : undefined}
                className={`${base} tabular-nums ${p === page ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {p}
              </Link>
            ),
          )}
          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} className={`${base} text-slate-600 hover:bg-slate-100`} aria-label="Página siguiente">
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <span className={`${base} text-slate-300`} aria-hidden>
              <ChevronRight className="h-4 w-4" />
            </span>
          )}
        </nav>
      )}
    </div>
  );
}

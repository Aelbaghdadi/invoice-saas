"use client";

import { useState, useRef, useEffect, useId, useMemo } from "react";
import { ChevronDown, Check, Search } from "lucide-react";
import { normalizeSearch } from "@/lib/listing";

export type SelectOption = {
  value: string;
  label: string;
  /** Cabecera bajo la que se agrupa (p.ej. "Trimestre" / "Mes"). */
  group?: string;
  disabled?: boolean;
};

type Props = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Si se pasa, el valor viaja tambien en un input oculto (formularios). */
  name?: string;
  id?: string;
  "aria-label"?: string;
  disabled?: boolean;
  /** Buscador dentro de la lista. Por defecto, con mas de 15 opciones: los
   *  12 meses no lo necesitan; una lista de clientes, si. */
  searchable?: boolean;
  /** "md" en formularios; "sm" en barras de filtros; "xs" en la revision,
   *  a la altura de sus campos de texto. */
  size?: "md" | "sm" | "xs";
};

/** Por debajo de este hueco (px) la lista se abre hacia arriba si arriba
 *  cabe mas: como hace el nativo al final de la pantalla. */
const ALTO_LISTA = 280;
/** Ancho maximo de la lista abierta (32rem). */
const ANCHO_LISTA = 512;

/**
 * Desplegable de la app. Sustituye al <select> nativo, cuya lista abierta la
 * pinta el sistema operativo (fondo azul de Windows) y no casa con el resto.
 *
 * Se maneja igual que un select con teclado, que es como trabaja el gestor:
 *  - Cerrado: flechas, Enter o Espacio abren; escribir una letra salta a la
 *    primera opcion que empieza por ella sin abrir (como el nativo).
 *  - Abierto: flechas mueven, Inicio/Fin, escribir salta, Enter o Espacio
 *    eligen, Escape cierra y deja el foco en el boton, Tab cierra y sigue.
 * Las teclas que usa no se propagan: la revision tiene atajos globales (R
 * rechaza, D marca duplicado, Enter valida) y no pueden dispararse al elegir
 * una opcion. Ctrl/Cmd si pasan, para que Ctrl+Enter siga validando.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  className = "",
  name,
  id,
  "aria-label": ariaLabel,
  disabled = false,
  searchable,
  size = "md",
}: Props) {
  const [open, setOpen] = useState(false);
  const [haciaArriba, setHaciaArriba] = useState(false);
  const [alDerecha, setAlDerecha] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const autoId = useId();
  const listId = `${id ?? autoId}-lista`;

  const conBuscador = searchable ?? options.length > 15;
  const selected = options.find((o) => o.value === value);

  const visibles = useMemo(() => {
    const q = normalizeSearch(query);
    return q ? options.filter((o) => normalizeSearch(o.label).includes(q)) : options;
  }, [options, query]);

  // Cerrar al tocar fuera. pointerdown y no mousedown: en iOS el mousedown
  // no llega al tocar una zona no clicable y la lista no se cerraba.
  useEffect(() => {
    if (!open) return;
    function handle(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [open]);

  function abrir() {
    // Si no cabe por debajo (al final de un panel con scroll) y arriba hay
    // mas sitio, se abre hacia arriba.
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const abajo = window.innerHeight - r.bottom;
      setHaciaArriba(abajo < ALTO_LISTA && r.top > abajo);
      // Cerca del borde derecho (la columna de la revision) la lista, que
      // crece hasta su texto mas largo, se alinea por la derecha del boton
      // para no salirse de la pantalla.
      setAlDerecha(r.left + ANCHO_LISTA > window.innerWidth - 16);
    }
    setQuery("");
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : primeraHabilitada(options, 0, 1));
    setOpen(true);
    if (conBuscador) requestAnimationFrame(() => searchRef.current?.focus());
  }

  function cerrar(devolverFoco: boolean) {
    setOpen(false);
    if (devolverFoco) buttonRef.current?.focus();
  }

  // Al filtrar, resaltar la primera que casa.
  useEffect(() => {
    if (open && query) setActive(primeraHabilitada(visibles, 0, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // La resaltada siempre a la vista.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function elegir(opt: SelectOption | undefined) {
    if (!opt || opt.disabled) return;
    if (opt.value !== value) onChange(opt.value);
    cerrar(true);
  }

  function mover(delta: 1 | -1) {
    setActive((cur) => {
      const start = cur < 0 ? (delta > 0 ? 0 : visibles.length - 1) : cur + delta;
      const next = primeraHabilitada(visibles, start, delta);
      return next >= 0 ? next : cur;
    });
  }

  /** Indice de la opcion a la que lleva lo tecleado, o -1. Con una sola
   *  letra repetida se va rotando entre las que empiezan por ella; con varias
   *  letras seguidas ("ma") se busca desde la actual, para quedarse en Marzo
   *  y no saltar a Mayo. */
  function indicePorLetras(lista: SelectOption[], desde: number, tecla: string): number {
    const ahora = Date.now();
    const t = typeahead.current;
    t.text = ahora - t.at < 700 ? t.text + tecla : tecla;
    t.at = ahora;
    const q = normalizeSearch(t.text);
    const offset = t.text.length > 1 ? 0 : 1;
    for (let k = 0; k < lista.length; k++) {
      const i = (Math.max(desde, 0) + offset + k) % lista.length;
      const o = lista[i];
      if (!o.disabled && normalizeSearch(o.label).startsWith(q)) return i;
    }
    return -1;
  }

  function esLetra(e: React.KeyboardEvent) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  function onKeyDownBoton(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    // Ctrl/Cmd+Enter y demas combinaciones siguen su camino (validar...).
    if (e.ctrlKey || e.metaKey) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        abrir();
        return;
      }
      if (esLetra(e)) {
        // Como el nativo cerrado: la letra cambia el valor sin abrir.
        e.preventDefault();
        e.stopPropagation();
        const actual = options.findIndex((o) => o.value === value);
        const i = indicePorLetras(options, actual, e.key);
        if (i >= 0 && options[i].value !== value) onChange(options[i].value);
      }
      return;
    }
    onKeyDownLista(e);
  }

  function onKeyDownLista(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) return;
    const enBuscador = e.target === searchRef.current;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); e.stopPropagation(); mover(1); return;
      case "ArrowUp": e.preventDefault(); e.stopPropagation(); mover(-1); return;
      case "Home": e.preventDefault(); e.stopPropagation(); setActive(primeraHabilitada(visibles, 0, 1)); return;
      case "End": e.preventDefault(); e.stopPropagation(); setActive(primeraHabilitada(visibles, visibles.length - 1, -1)); return;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        elegir(visibles[active]);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        cerrar(true);
        return;
      case "Tab":
        setOpen(false);
        return;
      case " ":
        // En el buscador, un espacio es texto. Fuera, elige la resaltada:
        // antes el navegador "pulsaba" el boton y cerraba sin elegir.
        if (!enBuscador) {
          e.preventDefault();
          e.stopPropagation();
          elegir(visibles[active]);
        }
        return;
    }
    if (esLetra(e) && !enBuscador) {
      // Con la lista abierta, la letra mueve el resaltado (no elige) y no
      // puede escaparse a los atajos de la revision.
      e.preventDefault();
      e.stopPropagation();
      const i = indicePorLetras(visibles, active, e.key);
      if (i >= 0) setActive(i);
    }
  }

  const alto =
    size === "xs" ? "px-3 py-1.5 rounded-lg"
    : size === "sm" ? "px-3 py-2 rounded-lg"
    : "px-4 py-2.5 rounded-xl";

  // Cabecera de grupo: se pinta cuando cambia el grupo.
  let grupoAnterior: string | undefined;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? cerrar(false) : abrir())}
        onKeyDown={onKeyDownBoton}
        className={`flex w-full items-center justify-between gap-2 border border-slate-200 bg-white text-left text-[13px] text-slate-700 outline-none transition hover:border-slate-300 focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${alto} ${open ? "border-accent-500 ring-2 ring-accent-100" : ""}`}
      >
        <span className={`truncate ${selected ? "text-slate-700" : "text-slate-400"}`} title={selected?.label}>
          {selected?.label ?? placeholder ?? "Seleccionar…"}
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          // w-max: la lista crece hasta el texto mas largo aunque el boton sea
          // estrecho ("8 · Adquisición Intracomunitaria de Servicios"), con un
          // tope para no salirse de la pantalla.
          className={`animate-scale-in absolute z-50 w-max min-w-full max-w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg ${haciaArriba ? "bottom-full mb-1.5" : "mt-1.5"} ${alDerecha ? "right-0" : "left-0"}`}
          onKeyDown={onKeyDownLista}
        >
          {conBuscador && (
            <div className="border-b border-slate-100 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  aria-label="Buscar en la lista"
                  aria-controls={listId}
                  aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                  className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-[13px] outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
                />
              </div>
            </div>
          )}
          <ul ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {visibles.length === 0 && (
              <li className="px-4 py-2.5 text-[13px] text-slate-400">Sin resultados</li>
            )}
            {visibles.map((opt, i) => {
              const cabecera = opt.group && opt.group !== grupoAnterior ? opt.group : null;
              grupoAnterior = opt.group;
              const isSelected = opt.value === value;
              const isActive = i === active;
              return (
                <li key={`${opt.group ?? ""}-${opt.value}`} role="presentation">
                  {cabecera && (
                    <div className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      {cabecera}
                    </div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    onMouseEnter={() => !opt.disabled && setActive(i)}
                    // El mousedown no se deja al navegador: si el buscador
                    // pierde el foco, la lista se cierra antes del click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => elegir(opt)}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-[13px] transition ${
                      opt.disabled
                        ? "cursor-not-allowed text-slate-300"
                        : isActive
                          // El resaltado del teclado tiene que verse: el gris
                          // clarito de antes y el azul de la elegida eran casi
                          // el mismo color.
                          ? "bg-blue-100 text-blue-900"
                          : isSelected
                            ? "bg-blue-50 font-medium text-blue-700"
                            : "text-slate-600"
                    }`}
                  >
                    <span className="whitespace-normal break-words">{opt.label}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 flex-shrink-0 text-blue-600" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Primera opcion habilitada desde `start` en la direccion `step`, o -1. */
function primeraHabilitada(options: SelectOption[], start: number, step: 1 | -1): number {
  for (let i = start; i >= 0 && i < options.length; i += step) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

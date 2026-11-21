"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/** Cada cuánto se vuelve a mirar con la pestaña visible. */
const POLL_MS = 30_000;

/**
 * El contador de «Reparto» al día. Parte del que calcula el layout y se vuelve
 * a pedir al cambiar de página, al volver a la pestaña y cada 30 s: el layout
 * no se renderiza al navegar y el número se quedaba con el valor de la carga
 * (decía 12 con 14 por clasificar).
 */
export function useRoutingInboxCount(initial: number, enabled: boolean): number {
  const pathname = usePathname();
  const [count, setCount] = useState(initial);
  // Si el layout se vuelve a renderizar (una acción que revalida), su número
  // es el bueno.
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setCount(initial);
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/routing-inbox/count", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { count?: unknown } | null) => {
          if (!cancelled && typeof data?.count === "number") setCount(data.count);
        })
        // Sin red se queda el último número: es solo un contador.
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [enabled, pathname]);

  return count;
}

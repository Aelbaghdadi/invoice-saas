"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** Periodo de refresco en ms. Por defecto 5s. */
  intervalMs?: number;
};

/**
 * Componente "invisible" que llama a `router.refresh()` cada N ms. Se
 * monta condicionalmente en paginas que necesitan refrescar mientras
 * hay trabajo de fondo (p.ej. lotes con facturas analizandose en OCR).
 *
 * `router.refresh()` re-ejecuta el RSC sin perder estado cliente; en
 * cuanto la condicion deje de cumplirse (no quedan facturas en
 * procesamiento) la pagina padre dejara de montarlo y el ciclo para.
 */
export function AutoRefresh({ intervalMs = 5000 }: Props) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}

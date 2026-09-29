"use client";

import { useProgressiveRefresh } from "./useProgressiveRefresh";

type Props = {
  /** Lo que se ve y puede cambiar con el refresco (p. ej. cuántas facturas
   *  siguen en OCR por lote). Si cambia, se vuelve a refrescar a menudo. */
  signature: string;
};

/**
 * Componente "invisible" que refresca la página mientras hay trabajo de
 * fondo (p. ej. lotes con facturas analizándose en OCR). La página padre
 * deja de montarlo cuando ya no queda nada en proceso.
 *
 * Ritmo (F-081): de 5 s hasta 60 s mientras no cambie nada, en pausa con la
 * pestaña oculta y parado tras 10 minutos sin cambios (useProgressiveRefresh).
 */
export function AutoRefresh({ signature }: Props) {
  useProgressiveRefresh(signature);
  return null;
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { nextRefreshDelay, refreshIdleExpired } from "@/lib/refreshSchedule";

/**
 * router.refresh() con el ritmo de refreshSchedule (F-081): cada vez más
 * espaciado mientras `signature` no cambie, en pausa con la pestaña oculta
 * y parado tras 10 minutos sin cambios. `signature` es lo que se ve (p. ej.
 * cuántas facturas quedan en OCR): si cambia, se vuelve al ritmo inicial.
 */
export function useProgressiveRefresh(signature: string, enabled = true) {
  const router = useRouter();
  const lastChangeAt = useRef(0);
  const delay = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // Otra firma (o el primer montaje): ritmo inicial.
    lastChangeAt.current = Date.now();
    delay.current = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "hidden") return;
      if (refreshIdleExpired(lastChangeAt.current, Date.now())) return;
      delay.current = nextRefreshDelay(delay.current);
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, delay.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      // Al volver: lo que haya cambiado mientras tanto, ya, y otra vez al
      // ritmo inicial (también si se había parado por inactividad).
      lastChangeAt.current = Date.now();
      delay.current = null;
      router.refresh();
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, signature, enabled]);
}

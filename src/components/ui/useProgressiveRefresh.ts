"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { nextRefreshDelay, refreshIdleExpired } from "@/lib/refreshSchedule";

/**
 * router.refresh() con el ritmo de refreshSchedule (F-081): cada vez más
 * espaciado mientras `signature` no cambie, en pausa con la pestaña oculta
 * y parado tras 10 minutos sin cambios (focus, un clic o una tecla lo
 * reanudan). `signature` es lo que se ve (p. ej.
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

    // Parado por inactividad (10 minutos sin cambios).
    let idle = false;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "hidden") return;
      if (refreshIdleExpired(lastChangeAt.current, Date.now())) {
        idle = true;
        return;
      }
      delay.current = nextRefreshDelay(delay.current);
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, delay.current);
    };
    // Parado, cualquier señal de que alguien mira la pantalla lo reanuda: una
    // factura puede pasar mas de 10 minutos en la cola sin que cambie nada y,
    // al terminar, seguia saliendo «1 en análisis» hasta recargar (revision 1
    // del PR #14, punto 12).
    const onActivity = () => {
      if (!idle || document.visibilityState === "hidden") return;
      idle = false;
      lastChangeAt.current = Date.now();
      delay.current = null;
      router.refresh();
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      // Al volver: lo que haya cambiado mientras tanto, ya, y otra vez al
      // ritmo inicial (también si se había parado por inactividad).
      idle = false;
      lastChangeAt.current = Date.now();
      delay.current = null;
      router.refresh();
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [router, signature, enabled]);
}

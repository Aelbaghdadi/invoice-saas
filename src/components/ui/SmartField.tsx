"use client";

import { CheckCircle2, AlertTriangle } from "lucide-react";
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_REVIEW,
  levelOf,
  type ConfidenceLevel,
} from "@/lib/reviewConstants";
import { ConfidenceBadge } from "./ConfidenceBadge";

/**
 * Devuelve clases CSS + tabIndex para un input segun su nivel de
 * confianza OCR.
 *
 * Filosofia:
 *  - high: campo "seguro" — gris, borde suave, tabIndex={-1} para que
 *    Tab lo salte y el gestor no pierda tiempo releyendolo. Clicable si
 *    quiere editarlo.
 *  - review: campo dudoso — borde amarillo, destacado. Tab va a parar aqui.
 *  - critical / unknown: campo casi seguro basura — borde rojo, Tab primero.
 */
export function fieldPropsFromConfidence(score: number | null | undefined): {
  className: string;
  tabIndex: number;
  level: ConfidenceLevel;
} {
  const level = levelOf(score);
  const base = "w-full rounded-lg border bg-white px-3 py-1.5 text-[13px] outline-none focus:ring-2";
  switch (level) {
    case "high":
      return {
        level,
        tabIndex: -1,
        className: `${base} border-slate-100 text-slate-500 focus:border-blue-400 focus:ring-blue-100 focus:text-slate-800`,
      };
    case "critical":
      return {
        level,
        tabIndex: 0,
        className: `${base} border-red-300 bg-red-50/40 text-slate-800 focus:border-red-400 focus:ring-red-100`,
      };
    case "review":
    case "unknown":
    default:
      return {
        level,
        tabIndex: 0,
        className: `${base} border-amber-300 bg-amber-50/40 text-slate-800 focus:border-amber-400 focus:ring-amber-100`,
      };
  }
}

/**
 * Indicador compacto a la derecha del label.
 * - high: check verde discreto (el gestor no lee el %).
 * - review/critical: badge con % (para que sepa cuanto dudar).
 * - unknown: triangulo ambar "falta".
 */
export function ConfidenceHint({
  score,
}: {
  score: number | null | undefined;
}) {
  if (score == null) {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-600"
        title="OCR no encontro este campo"
      >
        <AlertTriangle className="h-3 w-3" />
        falta
      </span>
    );
  }
  if (score >= CONFIDENCE_HIGH) {
    return (
      <CheckCircle2
        className="h-3 w-3 text-green-500"
        aria-label={`OCR seguro: ${Math.round(score * 100)}%`}
      />
    );
  }
  if (score >= CONFIDENCE_REVIEW) {
    return <ConfidenceBadge score={score} />;
  }
  return <ConfidenceBadge score={score} />;
}

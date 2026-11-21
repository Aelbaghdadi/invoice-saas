"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { batchLabel, samePeriod, type BatchPeriod, type MoveTarget } from "@/lib/batchTarget";
import { MONTH_OPTIONS, periodLabel, QUARTER_OPTIONS, quarterFromMonth, quarterStartMonth, type PeriodTypeName } from "@/lib/period";
import { moveBatch } from "./actions";

type Props = {
  clientId: string;
  type: "PURCHASE" | "SALE";
  periodType: PeriodTypeName;
  month: number;
  year: number;
  /** Facturas que se moverían: las que nunca salieron en un Excel. */
  movableCount: number;
  /** Las que ya salieron en un Excel: se quedan en este lote. */
  exportedCount: number;
  /** Los demás lotes del mismo cliente y tipo (moveTargetsFor). */
  targets: MoveTarget[];
  onClose: () => void;
};

const OTHER = "otro";

const targetValue = (period: BatchPeriod) => `${period.periodType}-${period.periodYear}-${period.periodMonth}`;

/** El periodo de antes del lote: lo habitual es que se subieran con el mes siguiente. */
function periodBefore(periodType: PeriodTypeName, month: number, year: number): BatchPeriod {
  if (periodType === "QUARTERLY") {
    const quarter = quarterFromMonth(month);
    return quarter === 1
      ? { periodType, periodMonth: 10, periodYear: year - 1 }
      : { periodType, periodMonth: quarterStartMonth(quarter - 1), periodYear: year };
  }
  return month === 1 ? { periodType, periodMonth: 12, periodYear: year - 1 } : { periodType, periodMonth: month - 1, periodYear: year };
}

/**
 * «Mover a otro lote…»: lleva las facturas de este lote a otro lote del mismo
 * cliente y tipo, de sus lotes recientes o de otro periodo. La acción decide
 * qué se mueve (las ya exportadas se quedan) y lo dice al terminar.
 */
export function MoveBatchPanel({ clientId, type, periodType, month, year, movableCount, exportedCount, targets, onClose }: Props) {
  const { success, info, error: toastError } = useToast();
  const firstOpen = targets.find((t) => !t.closed);
  const [choice, setChoice] = useState(firstOpen ? targetValue(firstOpen) : OTHER);
  const [other, setOther] = useState(() => periodBefore(periodType, month, year));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMoving, startMove] = useTransition();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // El boton que lo abre desaparece: el foco pasa al panel y no se pierde.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const destination: BatchPeriod | null = choice === OTHER ? other : targets.find((t) => targetValue(t) === choice) ?? null;
  // Con «Otro periodo…» puede ser uno de la lista: entonces se sabe cuantas tiene.
  const knownDestination = destination ? targets.find((t) => samePeriod(t, destination)) : undefined;
  const source = { periodType, periodMonth: month, periodYear: year, type };
  const thisYear = new Date().getFullYear();
  const years = [...new Set([...Array.from({ length: 5 }, (_, i) => thisYear - i), year, other.periodYear])]
    .sort((a, b) => b - a)
    .map((y) => ({ value: String(y), label: String(y) }));

  const handleMove = () => {
    if (!destination) return;
    setErrorMessage(null);
    startMove(async () => {
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("type", type);
      fd.set("periodType", periodType);
      fd.set("month", String(month));
      fd.set("year", String(year));
      fd.set("toPeriodType", destination.periodType);
      fd.set("toMonth", String(destination.periodMonth));
      fd.set("toYear", String(destination.periodYear));
      const res = await moveBatch(fd);
      if ("error" in res) {
        setErrorMessage(res.error);
        toastError(res.error);
        return;
      }
      const label = batchLabel({ ...destination, type });
      success(`${res.movidas} factura${res.movidas !== 1 ? "s" : ""} movida${res.movidas !== 1 ? "s" : ""} a ${label}`);
      if (res.quedan > 0) {
        info(`${res.quedan} se ${res.quedan !== 1 ? "quedan" : "queda"} en este lote porque ya ${res.quedan !== 1 ? "salieron" : "salió"} en un Excel`);
      }
      onClose();
    });
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      className="rounded-lg border border-blue-200 bg-blue-50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
    >
      <p id={titleId} className="text-[12px] font-medium text-blue-900">
        Mover {movableCount === 1 ? "la factura" : `las ${movableCount} facturas`} de {batchLabel(source)} a otro lote de este cliente.
        {exportedCount > 0 && ` ${exportedCount === 1 ? "La que ya salió" : `Las ${exportedCount} que ya salieron`} en un Excel se ${exportedCount === 1 ? "queda" : "quedan"} aquí.`}
      </p>
      <p className="mt-0.5 text-[11px] text-blue-800/80">
        Solo cambia el lote. Las que ya se guardaron conservan su periodo contable, que es el que cuenta para los
        cierres: si también tiene que cambiar, cámbialo al revisarlas.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          className="min-w-[220px]"
          aria-label="Lote de destino"
          value={choice}
          onChange={setChoice}
          options={[
            ...targets.map((t) => ({
              value: targetValue(t),
              label: `${periodLabel(t.periodType, t.periodMonth, t.periodYear)} · ${t.closed ? "periodo cerrado" : `${t.total} factura${t.total !== 1 ? "s" : ""}`}`,
              disabled: t.closed,
            })),
            { value: OTHER, label: "Otro periodo…" },
          ]}
        />
        {choice === OTHER && (
          <>
            <Select
              size="sm"
              className="w-32"
              aria-label="Agrupación del periodo"
              value={other.periodType}
              onChange={(v) => {
                const nextType = v === "QUARTERLY" ? "QUARTERLY" : "MONTHLY";
                setOther((p) => ({ ...p, periodType: nextType, periodMonth: nextType === "QUARTERLY" ? quarterStartMonth(quarterFromMonth(p.periodMonth)) : p.periodMonth }));
              }}
              options={[{ value: "MONTHLY", label: "Mensual" }, { value: "QUARTERLY", label: "Trimestral" }]}
            />
            {other.periodType === "MONTHLY" ? (
              <Select
                size="sm"
                className="w-36"
                aria-label="Mes"
                value={String(other.periodMonth)}
                onChange={(v) => setOther((p) => ({ ...p, periodMonth: Number(v) }))}
                options={MONTH_OPTIONS}
              />
            ) : (
              <Select
                size="sm"
                className="w-56"
                aria-label="Trimestre"
                value={String(quarterFromMonth(other.periodMonth))}
                onChange={(v) => setOther((p) => ({ ...p, periodMonth: quarterStartMonth(Number(v)) }))}
                options={QUARTER_OPTIONS.map((q) => ({ value: String(q.value), label: q.label }))}
              />
            )}
            <Select
              size="sm"
              className="w-24"
              aria-label="Año"
              value={String(other.periodYear)}
              onChange={(v) => setOther((p) => ({ ...p, periodYear: Number(v) }))}
              options={years}
            />
          </>
        )}
        <button
          type="button"
          onClick={handleMove}
          disabled={isMoving || !destination}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isMoving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {destination ? `Mover a ${periodLabel(destination.periodType, destination.periodMonth, destination.periodYear)}` : "Mover"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={isMoving}
          className="text-[12px] font-medium text-slate-500 hover:text-slate-700"
        >
          Cancelar
        </button>
      </div>
      {/* Mover junta los dos lotes y no hay vuelta atras por factura: mover de
          nuevo se lleva el lote entero. Un cerrado lo rechaza la accion. */}
      {destination && !knownDestination?.closed && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          {knownDestination
            ? `Se juntarán con ${knownDestination.total === 1 ? "la factura" : `las ${knownDestination.total} facturas`} de ${periodLabel(knownDestination.periodType, knownDestination.periodMonth, knownDestination.periodYear)} y después no se podrán separar desde aquí.`
            : "Si ese lote ya tiene facturas, se juntarán con ellas y después no se podrán separar desde aquí."}
        </p>
      )}
      {errorMessage && <p className="mt-1.5 text-[11px] text-red-700">{errorMessage}</p>}
    </div>
  );
}

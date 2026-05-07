"use client";

import { useState, useTransition } from "react";
import { ShieldCheck, ShieldAlert, Loader2, Hash } from "lucide-react";

type Result =
  | {
      ok: true;
      totalInvoices: number;
      intactChains: number;
      brokenChains: number;
      breaks: Array<{
        recordId: string;
        invoiceId: string;
        expectedPrevHash: string;
        actualPrevHash: string;
        reason: string;
      }>;
    }
  | { ok: false; error: string };

/**
 * Boton "Verificar integridad" en el panel de auditoria.
 *
 * Llama a /api/admin/verify-audit que recorre la cadena de hash de
 * todos los registros y devuelve cuantos eslabones estan intactos vs
 * rotos. Si la cadena esta intacta, demuestra criptograficamente que
 * NADIE ha modificado el historial — ni siquiera nosotros.
 */
export function IntegrityCheck() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  const verify = () => {
    start(async () => {
      try {
        const res = await fetch("/api/admin/verify-audit");
        const data = await res.json();
        if (!res.ok) {
          setResult({ ok: false, error: data.error ?? "Error" });
        } else {
          setResult({ ok: true, ...data });
        }
      } catch (e) {
        setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  };

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-50">
            <Hash className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-slate-800">
              Cadena de integridad
            </h3>
            <p className="mt-0.5 text-[12px] text-slate-500 leading-relaxed">
              Cada registro de auditoría está firmado con un hash que depende del anterior.
              Si alguien borra o modifica un registro — incluso desde la consola de la BD —
              la cadena se rompe y esta verificación lo detecta.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={verify}
          disabled={pending}
          className="flex flex-shrink-0 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Verificar integridad
        </button>
      </div>

      {result && (
        <div className="mt-4">
          {!result.ok ? (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">
              <ShieldAlert className="h-4 w-4 flex-shrink-0" />
              {result.error}
            </div>
          ) : result.brokenChains === 0 ? (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">
              <ShieldCheck className="h-4 w-4 flex-shrink-0" />
              <div>
                <span className="font-semibold">Cadena intacta.</span>{" "}
                {result.totalInvoices} factura{result.totalInvoices !== 1 ? "s" : ""} con auditoría verificada.
                Ningún registro ha sido alterado.
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldAlert className="h-4 w-4 flex-shrink-0" />
                Cadena rota: {result.brokenChains} de {result.totalInvoices} facturas tienen registros alterados o borrados.
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] font-medium text-red-600 hover:text-red-800">
                  Ver eslabones afectados ({result.breaks.length})
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] font-mono">
                  {result.breaks.slice(0, 20).map((b, i) => (
                    <li key={i} className="rounded bg-white/60 px-2 py-1">
                      <span className="font-semibold">{b.reason}</span>
                      {" · factura "} {b.invoiceId.slice(0, 12)}…
                      {" · registro "} {b.recordId.slice(0, 12)}…
                    </li>
                  ))}
                  {result.breaks.length > 20 && (
                    <li className="text-slate-500">…y {result.breaks.length - 20} más</li>
                  )}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

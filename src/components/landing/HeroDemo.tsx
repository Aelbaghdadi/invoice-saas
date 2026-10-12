"use client";

import { useEffect, useState } from "react";
import { Check, CornerDownLeft, FileText, Sparkles } from "lucide-react";

// Duración de cada paso de la demo (ms). Los pasos 1-7 rellenan un campo
// cada uno; después cuadre, cuentas aprendidas y validación.
const STEP_MS = [500, 430, 430, 430, 430, 430, 430, 650, 750, 950, 2900];
const LAST_FIELD_STEP = 7;
const MATH_STEP = 8;
const ACCOUNTS_STEP = 9;
const VALIDATED_STEP = 10;

type Field = { label: string; value: string; wide?: boolean; mono?: boolean };

const FIELDS: Field[] = [
  { label: "Razón social", value: "Suministros Ebro, S.L.", wide: true },
  { label: "CIF / NIF", value: "B50123456", mono: true },
  { label: "Nº factura", value: "F-2026/0412", mono: true },
  { label: "Fecha", value: "03/10/2026", mono: true },
  { label: "Base imponible", value: "1.240,00 €", mono: true },
  { label: "Cuota IVA 21 %", value: "260,40 €", mono: true },
  { label: "Total factura", value: "1.500,40 €", mono: true },
];

export function HeroDemo() {
  const [step, setStep] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    // Con movimiento reducido se muestra directamente el estado final.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const timer = window.setTimeout(() => setStep(VALIDATED_STEP), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      if (step >= VALIDATED_STEP) {
        setStep(0);
        setCycle((value) => value + 1);
      } else {
        setStep(step + 1);
      }
    }, STEP_MS[step]);
    return () => window.clearTimeout(timer);
  }, [step]);

  // Paso en el que se detecta el campo i del papel (1-indexado).
  const seen = (i: number) => step >= i + 1;
  const current = (i: number) => step === i + 1;
  const validated = step >= VALIDATED_STEP;

  return (
    <div
      className="relative mx-auto w-full max-w-[1080px]"
      aria-label="Demostración: Faktury lee una factura y rellena el formulario de revisión"
    >
      <div className="grid items-start gap-5 md:grid-cols-[1fr_1.08fr] md:gap-0">
        {/* ── Papel ── */}
        <div className="relative z-10 md:mt-10 md:-mr-6 md:-rotate-[1.6deg]">
          <div className="relative overflow-hidden rounded-[6px] border border-[#e6e1d6] bg-white px-6 pt-6 pb-7 text-[#1f2937] shadow-[0_30px_60px_-30px_rgb(6_42_99/0.35),0_2px_6px_rgb(6_42_99/0.06)] sm:px-8">
            <div
              key={cycle}
              className="lp-scan"
              data-on={step >= 1 && step <= LAST_FIELD_STEP}
            />

            <div className="flex items-start justify-between gap-4">
              <div>
                <p
                  className="lp-hl -mx-1 px-1 text-[17px] font-bold tracking-tight text-[#14532d]"
                  data-on={seen(0)}
                  data-current={current(0)}
                >
                  Suministros Ebro, S.L.
                </p>
                <p className="mt-1 text-[11px] leading-[1.5] text-slate-500">
                  Pol. Ind. Malpica, calle E, nave 14
                  <br />
                  50016 Zaragoza
                </p>
                <p
                  className="lp-hl -mx-1 mt-0.5 inline-block px-1 text-[11px] text-slate-600"
                  data-on={seen(1)}
                  data-current={current(1)}
                >
                  CIF B50123456
                </p>
              </div>
              <div className="text-right">
                <p className="text-[15px] font-semibold tracking-[0.18em] text-[#14532d]">
                  FACTURA
                </p>
                <p
                  className="lp-hl -mx-1 mt-1 inline-block px-1 text-[11px] text-slate-600"
                  data-on={seen(2)}
                  data-current={current(2)}
                >
                  Nº F-2026/0412
                </p>
                <br />
                <p
                  className="lp-hl -mx-1 inline-block px-1 text-[11px] text-slate-600"
                  data-on={seen(3)}
                  data-current={current(3)}
                >
                  Fecha 03/10/2026
                </p>
              </div>
            </div>

            <div className="mt-5 rounded border border-slate-200 px-3 py-2 text-[11px] leading-[1.5] text-slate-600">
              <p className="text-[9px] font-semibold tracking-[0.14em] text-slate-400">
                CLIENTE
              </p>
              Talleres Moncayo, S.L. · B99887766
            </div>

            <table className="mt-5 w-full text-[11px]">
              <thead>
                <tr className="bg-[#14532d] text-left text-white">
                  <th className="px-2 py-1.5 font-medium">Concepto</th>
                  <th className="px-2 py-1.5 text-right font-medium">Uds.</th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    Importe
                  </th>
                </tr>
              </thead>
              <tbody className="text-slate-600">
                <tr className="border-b border-slate-100">
                  <td className="px-2 py-1.5">Rodamiento 6204-2RS</td>
                  <td className="px-2 py-1.5 text-right">40</td>
                  <td className="px-2 py-1.5 text-right">480,00</td>
                </tr>
                <tr className="border-b border-slate-100">
                  <td className="px-2 py-1.5">Correa trapezoidal SPA 1250</td>
                  <td className="px-2 py-1.5 text-right">24</td>
                  <td className="px-2 py-1.5 text-right">456,00</td>
                </tr>
                <tr>
                  <td className="px-2 py-1.5">Grasa litio EP2, 5 kg</td>
                  <td className="px-2 py-1.5 text-right">8</td>
                  <td className="px-2 py-1.5 text-right">304,00</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 ml-auto w-[62%] space-y-1 text-[11px] text-slate-600">
              <div
                className="lp-hl -mx-1 flex justify-between px-1"
                data-on={seen(4)}
                data-current={current(4)}
              >
                <span>Base imponible</span>
                <span>1.240,00</span>
              </div>
              <div
                className="lp-hl -mx-1 flex justify-between px-1"
                data-on={seen(5)}
                data-current={current(5)}
              >
                <span>IVA 21 %</span>
                <span>260,40</span>
              </div>
              <div
                className="lp-hl -mx-1 flex justify-between border-t border-slate-200 px-1 pt-1 text-[13px] font-bold text-slate-800"
                data-on={seen(6)}
                data-current={current(6)}
              >
                <span>TOTAL</span>
                <span>1.500,40 €</span>
              </div>
            </div>
          </div>
          <p className="mt-3 flex items-center gap-1.5 pl-1 font-mono text-[11px] text-[var(--ink-soft)] md:rotate-[1.6deg]">
            <FileText className="h-3.5 w-3.5" /> F-2026-0412.pdf · subida por el
            cliente desde su portal
          </p>
        </div>

        {/* ── Formulario de revisión ── */}
        {/* En escritorio el papel se monta encima del borde izquierdo: el
            padding extra evita que tape los campos. */}
        <div className="relative rounded-2xl border border-[#d9d3c6] bg-[#fbfaf7] shadow-[0_40px_80px_-40px_rgb(6_42_99/0.45)] md:[&>div]:pl-12">
          <div className="flex items-center justify-between gap-3 border-b border-[#e7e2d8] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="font-semibold text-[var(--ink)]">Revisión</span>
              <span className="truncate text-[var(--ink-soft)]">
                Talleres Moncayo · Octubre 2026
              </span>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors duration-500 ${
                validated
                  ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${validated ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {validated ? "Validada" : step === 0 ? "Subida" : "Por revisar"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-3 px-5 pt-4">
            {FIELDS.map((field, i) => (
              <div key={field.label} className={field.wide ? "col-span-2" : ""}>
                <p className="mb-1 flex items-center gap-1 text-[10.5px] font-medium tracking-wide text-[var(--ink-soft)]">
                  {field.label}
                  <Check
                    className="lp-check h-3 w-3 text-emerald-600"
                    data-on={seen(i)}
                    strokeWidth={3}
                  />
                </p>
                <div
                  className={`flex h-9 items-center rounded-lg border bg-white px-3 text-[13px] transition-colors duration-300 ${
                    current(i)
                      ? "border-[var(--teal-ink)] ring-2 ring-[rgb(34_214_208/0.25)]"
                      : "border-[#e2ddd2]"
                  } ${i === LAST_FIELD_STEP - 1 ? "font-semibold" : ""} ${field.mono ? "font-mono tabular-nums" : ""}`}
                >
                  <span key={cycle} className="lp-typed" data-on={seen(i)}>
                    {field.value}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="px-5 pt-4">
            <div
              className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px] transition-all duration-500 ${
                step >= MATH_STEP
                  ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
                  : "bg-[#f1eee7] text-[var(--ink-soft)]"
              }`}
            >
              <Check
                className={`h-4 w-4 shrink-0 transition-opacity ${step >= MATH_STEP ? "opacity-100" : "opacity-30"}`}
              />
              {step >= MATH_STEP ? (
                <span>
                  Cuadre exacto:{" "}
                  <span className="font-mono">
                    1.240,00 + 260,40 = 1.500,40
                  </span>
                </span>
              ) : (
                <span>Comprobando base + IVA = total…</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 px-5 pt-3">
            {[
              { label: "Cuenta proveedor", value: "400.0123" },
              { label: "Cuenta gasto", value: "602.0000" },
            ].map((account) => (
              <div key={account.label}>
                <p className="mb-1 text-[10.5px] font-medium tracking-wide text-[var(--ink-soft)]">
                  {account.label}
                </p>
                <div
                  className={`flex h-9 items-center justify-between rounded-lg border px-3 font-mono text-[13px] transition-all duration-500 ${
                    step >= ACCOUNTS_STEP
                      ? "border-[rgb(15_134_131/0.4)] bg-[#effcfb]"
                      : "border-[#e2ddd2] bg-white"
                  }`}
                >
                  <span
                    key={cycle}
                    className="lp-typed"
                    data-on={step >= ACCOUNTS_STEP}
                  >
                    {account.value}
                  </span>
                  <Sparkles
                    className={`h-3.5 w-3.5 text-[var(--teal-ink)] transition-opacity duration-500 ${step >= ACCOUNTS_STEP ? "opacity-100" : "opacity-0"}`}
                  />
                </div>
              </div>
            ))}
            <p
              className={`col-span-2 -mt-1 text-[11px] text-[var(--teal-ink)] transition-opacity duration-500 ${step >= ACCOUNTS_STEP ? "opacity-100" : "opacity-0"}`}
            >
              Cuentas recordadas de la última factura de este proveedor
            </p>
          </div>

          <div className="px-5 pt-3 pb-5">
            <div
              className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[13px] font-semibold text-white transition-all duration-500 ${
                validated
                  ? "bg-emerald-600"
                  : step >= ACCOUNTS_STEP
                    ? "bg-[var(--navy)] shadow-[0_0_0_4px_rgb(34_214_208/0.25)]"
                    : "bg-[#9aa6bb]"
              }`}
            >
              {validated ? (
                <>
                  <Check className="h-4 w-4" strokeWidth={3} /> Validada · lista
                  para A3
                </>
              ) : (
                <>
                  Validar
                  <kbd className="inline-flex items-center gap-0.5 rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] font-normal">
                    <CornerDownLeft className="h-3 w-3" /> Intro
                  </kbd>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

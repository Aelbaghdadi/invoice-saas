"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { AlertCircle, Bug, HelpCircle, Lightbulb, Loader2, MessageSquare, Paperclip } from "lucide-react";
import type { SupportTicketType } from "@prisma/client";
import { createSupportTicket, type TicketFormState } from "../actions";
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_BODY_MAX,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_TYPE_HINTS,
  SUPPORT_TYPE_LABELS,
  SUPPORT_TYPES,
} from "@/lib/support";

const TYPE_ICON: Record<SupportTicketType, typeof Bug> = {
  BUG: Bug,
  SUGGESTION: Lightbulb,
  QUESTION: HelpCircle,
  OTHER: MessageSquare,
};

const PLACEHOLDER: Record<SupportTicketType, string> = {
  BUG: "Qué estabas haciendo, qué esperabas que pasara y qué ha pasado. Si es con una factura concreta, di cuál.",
  SUGGESTION: "Qué os facilitaría el trabajo y en qué pantalla.",
  QUESTION: "Qué quieres hacer y dónde te has quedado.",
  OTHER: "Cuéntanos.",
};

export function NewTicketForm({ pageUrl }: { pageUrl: string }) {
  const [state, action, pending] = useActionState<TicketFormState, FormData>(createSupportTicket, undefined);
  const [type, setType] = useState<SupportTicketType>("BUG");
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="pageUrl" value={pageUrl} />

      {state?.error && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
          {state.error}
        </div>
      )}

      <fieldset>
        <legend className="mb-2 block text-[13px] font-medium text-slate-700">¿De qué se trata?</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SUPPORT_TYPES.map((t) => {
            const Icon = TYPE_ICON[t];
            const active = type === t;
            return (
              <label
                key={t}
                className={`flex cursor-pointer flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition ${
                  active ? "border-blue-300 bg-blue-50/70 ring-2 ring-blue-100" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <input
                  type="radio"
                  name="type"
                  value={t}
                  checked={active}
                  onChange={() => setType(t)}
                  className="sr-only"
                />
                <span className={`flex items-center gap-1.5 text-[13px] font-semibold ${active ? "text-blue-800" : "text-slate-700"}`}>
                  <Icon className={`h-4 w-4 ${active ? "text-blue-600" : "text-slate-400"}`} strokeWidth={1.9} />
                  {SUPPORT_TYPE_LABELS[t]}
                </span>
                <span className="text-[11px] leading-snug text-slate-500">{SUPPORT_TYPE_HINTS[t]}</span>
              </label>
            );
          })}
        </div>
        {state?.errors?.type && <p className="mt-1 text-[12px] text-red-500">{state.errors.type}</p>}
      </fieldset>

      <div>
        <label htmlFor="ticket-subject" className="block text-[13px] font-medium text-slate-700">Asunto</label>
        <input
          id="ticket-subject"
          name="subject"
          required
          maxLength={SUPPORT_SUBJECT_MAX}
          className="input mt-1.5 w-full"
          placeholder={type === "BUG" ? "Ej.: Al validar una factura de Meta se queda cargando" : "En una frase"}
        />
        {state?.errors?.subject && <p className="mt-1 text-[12px] text-red-500">{state.errors.subject}</p>}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="ticket-body" className="block text-[13px] font-medium text-slate-700">Descripción</label>
          <span className={`text-[11px] tabular-nums ${body.length > SUPPORT_BODY_MAX ? "text-red-500" : "text-slate-400"}`}>
            {body.length.toLocaleString("es-ES")} / {SUPPORT_BODY_MAX.toLocaleString("es-ES")}
          </span>
        </div>
        <textarea
          id="ticket-body"
          name="body"
          required
          rows={7}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="input mt-1.5 w-full resize-y"
          placeholder={PLACEHOLDER[type]}
        />
        {state?.errors?.body && <p className="mt-1 text-[12px] text-red-500">{state.errors.body}</p>}
      </div>

      <div>
        <label htmlFor="ticket-attachment" className="block text-[13px] font-medium text-slate-700">
          Captura o PDF <span className="font-normal text-slate-400">(opcional, hasta 5 MB)</span>
        </label>
        <label
          htmlFor="ticket-attachment"
          className="mt-1.5 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3.5 py-2.5 text-[13px] text-slate-600 hover:border-blue-300 hover:bg-blue-50/40"
        >
          <Paperclip className="h-4 w-4 text-slate-400" />
          {fileName ?? "Elegir archivo…"}
        </label>
        <input
          id="ticket-attachment"
          name="attachment"
          type="file"
          accept={SUPPORT_ATTACHMENT_ACCEPT}
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          className="sr-only"
        />
        {state?.errors?.attachment && <p className="mt-1 text-[12px] text-red-500">{state.errors.attachment}</p>}
      </div>

      {pageUrl && (
        <p className="text-[11px] text-slate-400">
          Se guardará que venías de <span className="font-mono text-slate-500">{pageUrl}</span>, para situar el fallo.
        </p>
      )}

      <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? "Enviando..." : "Enviar al equipo"}
        </button>
        <Link href="/dashboard/support" className="text-[13px] text-slate-500 hover:text-slate-700">
          Cancelar
        </Link>
      </div>
    </form>
  );
}

"use client";

import { useTransition } from "react";
import { CheckCheck, X, Loader2 } from "lucide-react";
import { resolveIssue, dismissIssue } from "./actions";
import { useToast } from "@/components/ui/Toast";

export function IssueActions({ issueId }: { issueId: string }) {
  const [isPending, startTransition] = useTransition();
  const { success, error } = useToast();

  const handle = (action: typeof resolveIssue, label: string) => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("issueId", issueId);
      const res = await action(null, fd);
      if (res?.error) error(res.error);
      else success(label);
    });
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handle(resolveIssue, "Incidencia resuelta")}
        disabled={isPending}
        className="flex items-center gap-1 rounded-md border border-green-200 px-2 py-1 text-[11px] font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
        Resolver
      </button>
      <button
        onClick={() => handle(dismissIssue, "Incidencia descartada")}
        disabled={isPending}
        className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        Descartar
      </button>
    </div>
  );
}

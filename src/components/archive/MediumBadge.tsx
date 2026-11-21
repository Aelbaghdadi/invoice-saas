import type { OriginalMedium } from "@prisma/client";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { mediumLabel } from "@/lib/originalMedium";

const VARIANTS: Record<OriginalMedium | "UNCONFIRMED", BadgeVariant> = {
  ELECTRONIC: "blue",
  PAPER: "orange",
  UNCONFIRMED: "yellow",
};

/** Electrónico, Papel o Por confirmar, con el motivo al pasar el ratón. */
export function MediumBadge({ medium, reason }: { medium: OriginalMedium | null; reason?: string | null }) {
  return (
    <span title={reason ?? undefined} className="inline-flex">
      <Badge variant={VARIANTS[medium ?? "UNCONFIRMED"]}>{mediumLabel(medium)}</Badge>
    </span>
  );
}

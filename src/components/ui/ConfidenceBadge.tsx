"use client";

type Props = {
  score: number;      // 0.0 – 1.0
  className?: string;
};

export function ConfidenceBadge({ score, className = "" }: Props) {
  const pct = Math.round(score * 100);

  let bg: string;
  let text: string;
  if (score >= 0.85) {
    bg = "bg-green-100";
    text = "text-green-700";
  } else if (score >= 0.6) {
    bg = "bg-amber-100";
    text = "text-amber-700";
  } else {
    bg = "bg-red-100";
    text = "text-red-700";
  }

  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${bg} ${text} ${className}`}
      title={`Confianza OCR: ${pct}%`}
    >
      {pct}%
    </span>
  );
}

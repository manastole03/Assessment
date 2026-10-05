import { percent, severityOf, type Severity } from "@/lib/evals";
import { cn } from "@/lib/utils";

// The fill carries severity; the track is a lighter step of the same hue, so state reads across the bar.
const SEVERITY: Record<Severity, { fill: string; track: string; label: string }> = {
  good: { fill: "bg-emerald-600 dark:bg-emerald-500", track: "bg-emerald-500/15", label: "meets the gate" },
  warning: { fill: "bg-amber-500", track: "bg-amber-500/15", label: "below the gate" },
  critical: { fill: "bg-red-600 dark:bg-red-500", track: "bg-red-500/15", label: "well below the gate" },
};

/** A pass rate against its gate, with the numbers in text so it never depends on colour. */
export function PassRateMeter({
  passed,
  total,
  threshold = 1,
  label,
  className,
}: {
  passed: number;
  total: number;
  threshold?: number;
  label?: string;
  className?: string;
}) {
  const rate = total ? passed / total : 0;
  const severity = SEVERITY[severityOf(rate, threshold)];
  const text = `${passed} of ${total} passed (${percent(rate)}), ${severity.label}`;
  return (
    <div className={cn("space-y-1", className)}>
      {label !== undefined && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate text-foreground">{label}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {passed}/{total} · {percent(rate)}
          </span>
        </div>
      )}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={passed}
        aria-valuetext={text}
        aria-label={label ?? "Pass rate"}
        title={text}
        className={cn("relative h-2 overflow-hidden rounded-full", severity.track)}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", severity.fill)}
          style={{ width: `${rate * 100}%` }}
        />
        {threshold < 1 && (
          <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${threshold * 100}%` }} aria-hidden />
        )}
      </div>
    </div>
  );
}

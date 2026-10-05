export type Severity = "good" | "warning" | "critical";

/** Where a pass rate sits against its gate: meets it, below it, or below half. */
export function severityOf(rate: number, threshold: number): Severity {
  if (rate >= threshold) return "good";
  return rate >= 0.5 ? "warning" : "critical";
}

export const percent = (rate: number) => `${Math.round(rate * 100)}%`;

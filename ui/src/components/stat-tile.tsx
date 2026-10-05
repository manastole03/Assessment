import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

/** A KPI: sentence-case label, a value in proportional figures, optional detail line. */
export function StatTile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </CardContent>
    </Card>
  );
}

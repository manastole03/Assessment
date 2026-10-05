import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RunEvent } from "@/lib/api";

const HIDE = new Set(["seq", "ts", "t_ms", "type"]);

export function EventsTable({ events }: { events: RunEvent[] }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(
    () =>
      events.filter((e) => !filter || e.type.includes(filter) || JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())),
    [events, filter],
  );
  return (
    <div className="space-y-2">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter events (e.g. handler, locator, policy)…"
        aria-label="Filter events"
      />
      <ScrollArea className="h-[28rem] rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted text-left">
            <tr>
              <th className="px-2 py-1.5 font-medium">t</th>
              <th className="px-2 py-1.5 font-medium">type</th>
              <th className="px-2 py-1.5 font-medium">details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.seq} className="border-t align-top">
                <td className="px-2 py-1 whitespace-nowrap text-muted-foreground tabular-nums">{(e.t_ms / 1000).toFixed(1)}s</td>
                <td className="px-2 py-1 font-mono whitespace-nowrap">{e.type}</td>
                <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                  {JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !HIDE.has(k)))).slice(0, 400)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      <p className="text-xs text-muted-foreground">
        {rows.length} of {events.length} events · every value is redacted before it is written or streamed.
      </p>
    </div>
  );
}

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Link } from "react-router";

import { EmptyState, PageHeader } from "@/components/page-header";
import { KindBadge, RunStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiPage, type RunSummary } from "@/lib/api";
import { formatDuration, formatWhen } from "@/lib/format";

const ALL = "all";
const PAGE_SIZE = 25;

/** Filtering, search and paging happen on the server (GET /api/v1/runs), so this scales with history. */
export default function RunsPage() {
  const [kind, setKind] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [origin, setOrigin] = useState(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const term = useDeferredValue(search.trim());

  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (kind !== ALL) params.set("kind", kind);
  if (status !== ALL) params.set("status", status);
  if (origin !== ALL) params.set("origin", origin);
  if (term) params.set("search", term);

  const { data, isLoading } = useQuery({
    queryKey: ["runs", params.toString()],
    queryFn: () => apiPage<RunSummary>(`/runs?${params.toString()}`),
    refetchInterval: 4000,
    placeholderData: keepPreviousData,
  });
  const rows = data?.items ?? [];
  const meta = data?.meta;
  const changed = (set: (v: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const filter = (value: string, set: (v: string) => void, label: string, options: [string, string][]) => (
    <Select value={value} onValueChange={changed(set)}>
      <SelectTrigger size="sm" className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label}</SelectItem>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description="Every discovery, probe and replay, with its full evidence trail. Live runs update in place."
      />
      <div className="flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(e) => changed(setSearch)(e.target.value)}
          placeholder="Search runs…"
          className="h-7 w-56"
          aria-label="Search runs"
        />
        {filter(kind, setKind, "kinds", [
          ["replay", "Replay"],
          ["discovery", "Discovery"],
          ["probe", "Probe"],
        ])}
        {filter(status, setStatus, "statuses", [
          ["running", "Running"],
          ["succeeded", "Succeeded"],
          ["business_outcome", "Business outcome"],
          ["failed", "Failed"],
          ["error", "Error"],
        ])}
        {filter(origin, setOrigin, "sources", [
          ["control_plane", "Started here"],
          ["engine", "CLI and stdio MCP"],
          ["evidence", "Evidence folder"],
        ])}
      </div>
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !rows.length ? (
        <EmptyState icon={<History />} title="No runs match">
          Start one from “Run a capability”.
        </EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Tenant</TableHead>
                <TableHead className="hidden md:table-cell">Started</TableHead>
                <TableHead className="hidden text-right md:table-cell">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-96">
                    <Link to={`/runs/${encodeURIComponent(r.id)}`} className="block truncate font-medium hover:underline">
                      {r.subject}
                    </Link>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <KindBadge kind={r.kind} />
                      {r.origin === "evidence" && (
                        <Badge variant="outline" className="text-[10px] font-normal">
                          evidence
                        </Badge>
                      )}
                      {r.requestedBy && <span className="truncate">by {r.requestedBy.name}</span>}
                      <span className="truncate font-mono">{r.id}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={r.active ? "running" : r.status} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{r.tenant ?? "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatWhen(r.startedAt)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatDuration(r.durationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
              </span>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={meta.page <= 1} onClick={() => setPage(meta.page - 1)}>
                  <ChevronLeft /> Newer
                </Button>
                <Button variant="ghost" size="sm" disabled={meta.page >= meta.totalPages} onClick={() => setPage(meta.page + 1)}>
                  Older <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

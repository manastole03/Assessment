import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Boxes, Play } from "lucide-react";
import { Link } from "react-router";

import { EmptyState, PageHeader } from "@/components/page-header";
import { CapabilityStatusBadge, RiskBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiAll, type CapabilitySummary } from "@/lib/api";

export default function CapabilitiesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiAll<CapabilitySummary>("/capabilities"),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Capabilities"
        description="The library: typed, versioned artifacts recorded from discovery runs. Approved ones are what calling agents can invoke."
      />
      <div data-tour="capabilities">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.length ? (
          <EmptyState icon={<Boxes />} title="No capabilities yet">
            Record one on the Discover page (or run <code>make evidence-offline</code>).
          </EmptyState>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Contract</TableHead>
                  <TableHead className="hidden lg:table-cell">Business outcomes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="max-w-80">
                      <Link to={`/capabilities/${c.id}`} className="font-medium hover:underline">
                        {c.title}
                      </Link>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {c.id}@{c.version}
                        {c.versions.length > 1 && ` · ${c.versions.length} versions`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <CapabilityStatusBadge status={c.status} />
                        <RiskBadge risk={c.side_effects} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {c.kind === "session" ? (
                        <span className="text-muted-foreground">Session (sign-on) — secrets only</span>
                      ) : (
                        <>
                          <span className="font-mono">{Object.keys(c.inputs).join(", ") || "—"}</span>
                          <span className="text-muted-foreground"> → </span>
                          <span className="font-mono">{Object.keys(c.outputs).join(", ") || "—"}</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {c.outcomes.length ? (
                          c.outcomes.map((o) => (
                            <Badge key={o} variant="outline" className="font-mono text-[10px] font-normal">
                              {o}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {c.kind === "task" && (
                          <Button asChild size="sm" variant="outline">
                            <Link to={`/run?capability=${c.id}`}>
                              <Play /> Run
                            </Link>
                          </Button>
                        )}
                        <Button asChild size="sm" variant="ghost">
                          <Link to={`/capabilities/${c.id}`}>
                            Review <ArrowRight />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

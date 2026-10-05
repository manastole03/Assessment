import { useMemo } from "react";

import { contours } from "./geometry";
import { cn } from "@/lib/utils";

/** Faint topographic contour lines, computed (not an image): the ground the drawings sit on. */
export function Topo({ seed = 7, className }: { seed?: number; className?: string }) {
  const paths = useMemo(() => contours({ width: 1600, height: 1000, seed, cell: 9, levels: 18 }), [seed]);
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      className={cn("pointer-events-none absolute inset-0 size-full", className)}
      aria-hidden
    >
      <g fill="none" stroke="currentColor" strokeWidth={0.9} vectorEffect="non-scaling-stroke">
        {paths.map((d, i) => (
          <path key={i} d={d} opacity={i % 4 === 3 ? 0.9 : 0.5} />
        ))}
      </g>
    </svg>
  );
}

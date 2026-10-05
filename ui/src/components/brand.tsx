import { Link } from "react-router";

import { cn } from "@/lib/utils";

/** The mark: a route of three waypoints — rote replays the same route every time. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="4" className="fill-ink dark:fill-[#e6ecf5]" />
      <g className="stroke-white dark:stroke-[#172036]" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M8.5 23 L15 15.5 L23.5 9" />
      </g>
      <circle cx="8.5" cy="23" r="2.4" className="fill-white dark:fill-[#172036]" />
      <circle cx="15" cy="15.5" r="2.4" className="fill-white dark:fill-[#172036]" />
      <circle cx="23.5" cy="9" r="3.4" className="fill-sky stroke-white dark:stroke-[#172036]" strokeWidth="1.6" />
    </svg>
  );
}

/** The product mark; links home to the landing page. */
export function Brand({ subtitle = "capability studio" }: { subtitle?: string }) {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <BrandMark />
      <div className="leading-none">
        <div className="font-heading text-[1.35rem] leading-none text-foreground">rote</div>
        <div className="mt-1 text-[0.55rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">{subtitle}</div>
      </div>
    </Link>
  );
}

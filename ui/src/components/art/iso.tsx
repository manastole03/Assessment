/**
 * A tiny isometric drawing kit. Everything on the landing page is drawn from geometry with it, in the
 * line-art style of an engineering illustration: white faces, ink outlines, sky-blue accents.
 *
 * Axes: +x runs down-right, +y runs down-left, +z is up. One unit is one SVG unit.
 */
import { motion } from "motion/react";
import type { ReactNode, SVGProps } from "react";

import { arcThrough, iso, pathThrough, planeTransform, pts, type Point3 } from "./geometry";

/** Draw flat content (rects, text, paths in plane coordinates) lying on the plane z = `z`. */
export function Plane({ z = 0, x = 0, y = 0, children }: { z?: number; x?: number; y?: number; children: ReactNode }) {
  return <g transform={planeTransform(z, x, y)}>{children}</g>;
}

export interface BoxProps {
  at: Point3;
  size: Point3;
  /** Face fills: top, right (+x), left (+y). */
  tone?: "paper" | "ink" | "sky";
  className?: string;
  strokeWidth?: number;
}

const TONES = {
  paper: ["fill-white dark:fill-[#2a3757]", "fill-[#eef0f3] dark:fill-[#223050]", "fill-[#dfe3ea] dark:fill-[#1c2844]"],
  ink: ["fill-[#3a4e74]", "fill-[#2b3c5b]", "fill-[#22314d]"],
  sky: ["fill-[#9cc8ec]", "fill-[#6aaee3]", "fill-[#4095d6]"],
} as const;

/** A shaded cuboid: the three faces a viewer sees, outlined. */
export function Box({ at: [x, y, z], size: [w, d, h], tone = "paper", className, strokeWidth = 1.1 }: BoxProps) {
  const [top, right, left] = TONES[tone];
  const stroke = "stroke-ink dark:stroke-[#c9d6ea]";
  const common = { strokeWidth, strokeLinejoin: "round" as const, vectorEffect: "non-scaling-stroke" as const };
  return (
    <g className={className}>
      <polygon
        className={`${left} ${stroke}`}
        points={pts([
          [x, y + d, z],
          [x + w, y + d, z],
          [x + w, y + d, z + h],
          [x, y + d, z + h],
        ])}
        {...common}
      />
      <polygon
        className={`${right} ${stroke}`}
        points={pts([
          [x + w, y, z],
          [x + w, y + d, z],
          [x + w, y + d, z + h],
          [x + w, y, z + h],
        ])}
        {...common}
      />
      <polygon
        className={`${top} ${stroke}`}
        points={pts([
          [x, y, z + h],
          [x + w, y, z + h],
          [x + w, y + d, z + h],
          [x, y + d, z + h],
        ])}
        {...common}
      />
    </g>
  );
}

/** A polyline through 3D points that draws itself in (stroke animation via pathLength). */
export function Route({
  points,
  delay = 0,
  duration = 1.6,
  className = "stroke-sky",
  dashed = false,
  curve,
  ...rest
}: {
  points: Point3[];
  delay?: number;
  duration?: number;
  className?: string;
  dashed?: boolean;
  /** Lift each leg into an arc this many units high (a flight path), instead of straight segments. */
  curve?: number;
} & Omit<SVGProps<SVGPathElement>, "points" | "ref" | "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd">) {
  const d = curve ? arcThrough(points, curve) : pathThrough(points);
  return (
    <motion.path
      d={d}
      fill="none"
      className={className}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed ? "4 5" : undefined}
      initial={{ pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ pathLength: { duration, delay, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.2, delay } }}
      {...(rest as object)}
    />
  );
}

/** An ellipse lying on the plane z (a circle in plan view), drawn with a stroke. */
export function Ring({
  at: [x, y, z],
  r,
  className = "stroke-sky fill-none",
  strokeWidth = 1.4,
}: {
  at: Point3;
  r: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <g transform={planeTransform(z, x, y)}>
      <circle r={r} className={className} strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** A callout: a leader line from a point in the drawing to a label set in screen space. */
export function Callout({
  from,
  dx,
  dy,
  children,
  align = "start",
  delay = 0,
}: {
  from: Point3;
  dx: number;
  dy: number;
  children: ReactNode;
  align?: "start" | "end";
  delay?: number;
}) {
  const [x, y] = iso(...from);
  const tx = x + dx;
  const ty = y + dy;
  return (
    <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}>
      <circle cx={x} cy={y} r={2.2} className="fill-ink dark:fill-[#c9d6ea]" />
      <path
        d={`M${x} ${y} L${tx} ${ty} L${tx + (align === "start" ? 18 : -18)} ${ty}`}
        className="fill-none stroke-ink/55 dark:stroke-[#c9d6ea]/60"
        strokeWidth={0.8}
      />
      <text
        x={tx + (align === "start" ? 22 : -22)}
        y={ty + 3.5}
        textAnchor={align}
        className="fill-ink font-mono text-[10px] tracking-[0.02em] dark:fill-[#c9d6ea]"
      >
        {children}
      </text>
    </motion.g>
  );
}

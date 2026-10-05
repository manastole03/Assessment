/**
 * The landing page's illustrations, drawn from geometry (see iso.tsx). Each one depicts the real system:
 * the LegacyCore frameset, the recorded steps and their locators, the handlers that fired, the operator's
 * lease, the files in a run's evidence folder.
 */
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { arcThrough, iso, planeTransform, type Point3, wallYTransform } from "./geometry";
import { Box, Callout, Ring, Route } from "./iso";

const EASE = [0.16, 1, 0.3, 1] as const;
const TOP = 12; // the screen slab's thickness: its top face is the plane z = 12

function Figure({ label, children, viewBox }: { label: string; children: ReactNode; viewBox: string }) {
  return (
    <motion.svg
      viewBox={viewBox}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label={label}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      {children}
    </motion.svg>
  );
}

function FigureLabel({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <text x={x} y={y} className="fill-sky-ink font-mono text-[10px] tracking-[0.08em] uppercase">
      {children}
    </text>
  );
}

// ------------------------------------------------------------------------------------------------ the screen

/** Plane coordinates of the elements the recorded capability touches, on the 440 × 300 screen. */
const UI = {
  menu: [45, 72],
  input: [250, 86],
  search: [342, 86],
  member: [146, 140],
  name: [206, 214],
  balance: [372, 250],
} as const;

const WAYPOINTS: [number, number][] = [UI.menu, UI.input, UI.search, UI.member, UI.name, UI.balance] as [number, number][];

export const ROUTE_ALTITUDE = 30;
const HOP = 46; // each leg arcs this high above the straight line between waypoints

function onScreen([x, y]: readonly [number, number], z = TOP): Point3 {
  return [x, y, z];
}

/** The LegacyCore frameset (banner, menu, inquiry form, results, member detail) on an isometric screen. */
function Screen({ at = [0, 0], highlight = true }: { at?: [number, number]; highlight?: boolean }) {
  const [ox, oy] = at;
  const ink = "fill-ink dark:fill-[#c9d6ea]";
  const soft = "fill-[#eef1f5] dark:fill-[#25324f]";
  const rule = "stroke-ink/40 dark:stroke-[#c9d6ea]/40";
  return (
    <g>
      <Box at={[ox, oy, 0]} size={[440, 300, TOP]} strokeWidth={1.2} />
      <g transform={planeTransform(TOP, ox, oy)}>
        <rect x={0} y={0} width={440} height={30} className="fill-ink dark:fill-[#3a4e74]" />
        <text x={12} y={19} className="fill-white font-sans text-[9px] font-medium tracking-[0.12em]">
          ACME FEDERAL CREDIT UNION
        </text>
        <rect x={0} y={30} width={88} height={270} className={soft} />
        {["Home", "Member Inquiry", "Transaction Posting", "Reports", "Sign Off"].map((item, i) => (
          <text
            key={item}
            x={10}
            y={56 + i * 16}
            className={`${i === 1 ? "fill-sky-ink" : ink} font-sans text-[7.5px] ${i === 1 ? "font-semibold" : ""}`}
          >
            {item}
          </text>
        ))}
        <text x={106} y={56} className={`${ink} font-sans text-[9px] font-semibold tracking-[0.08em]`}>
          MEMBER INQUIRY
        </text>
        <text x={106} y={89} className={`${ink} font-sans text-[7.5px]`}>
          Member Number
        </text>
        <rect x={186} y={78} width={130} height={15} className="fill-white stroke-ink/50 dark:fill-[#1d2840]" strokeWidth={0.8} />
        <rect x={322} y={78} width={42} height={15} rx={2} className={soft + " " + rule} strokeWidth={0.8} />
        <text x={332} y={88.5} className={`${ink} font-sans text-[7px]`}>
          Search
        </text>
        {/* results */}
        <g className={rule} strokeWidth={0.6}>
          <rect x={106} y={110} width={310} height={44} fill="none" />
          <line x1={106} y1={124} x2={416} y2={124} />
          <line x1={200} y1={110} x2={200} y2={154} />
        </g>
        <text x={112} y={120} className={`${ink} font-sans text-[6.5px] tracking-[0.08em]`}>
          MBR #
        </text>
        <text x={206} y={120} className={`${ink} font-sans text-[6.5px] tracking-[0.08em]`}>
          NAME
        </text>
        <text x={112} y={143} className="fill-sky-ink font-mono text-[7px] underline">
          {"{{member_id}}"}
        </text>
        {/* member detail */}
        <text x={106} y={182} className={`${ink} font-sans text-[9px] font-semibold tracking-[0.08em]`}>
          MEMBER DETAIL
        </text>
        <g className={rule} strokeWidth={0.6}>
          <rect x={106} y={192} width={310} height={92} fill="none" />
          <line x1={106} y1={224} x2={416} y2={224} />
          <line x1={106} y1={240} x2={416} y2={240} />
          <line x1={106} y1={258} x2={416} y2={258} />
          <line x1={300} y1={224} x2={300} y2={284} />
        </g>
        <text x={112} y={210} className={`${ink} font-sans text-[6.5px] tracking-[0.06em]`}>
          NAME
        </text>
        <rect x={160} y={202} width={92} height={12} className="fill-ink/15 dark:fill-[#c9d6ea]/20" />
        <text x={112} y={235} className={`${ink} font-sans text-[6.5px] tracking-[0.06em]`}>
          SHARE / LOAN
        </text>
        <text x={306} y={235} className={`${ink} font-sans text-[6.5px] tracking-[0.06em]`}>
          CURRENT BALANCE
        </text>
        <text x={112} y={252} className={`${ink} font-sans text-[6.5px]`}>
          SHARE SAVINGS
        </text>
        <text x={112} y={270} className={`${ink} font-sans text-[6.5px]`}>
          SHARE DRAFT
        </text>
        <rect
          x={302}
          y={242}
          width={110}
          height={14}
          className={highlight ? "fill-sky/15 stroke-sky" : "fill-transparent"}
          strokeWidth={1}
        />
        <text x={360} y={252} className={`${ink} font-mono text-[7px]`} textAnchor="middle">
          2,418.07
        </text>
        <text x={360} y={270} className={`${ink} font-mono text-[7px] opacity-60`} textAnchor="middle">
          812.44
        </text>
      </g>
    </g>
  );
}

/** The recorded route: waypoints on the screen, flown at altitude, with drop lines to each element. */
function FlightPath({ at = [0, 0], delay = 0.3, markers = true }: { at?: [number, number]; delay?: number; markers?: boolean }) {
  const [ox, oy] = at;
  const air = WAYPOINTS.map(([x, y]) => [x + ox, y + oy, TOP + ROUTE_ALTITUDE] as Point3);
  const ground = WAYPOINTS.map(([x, y]) => [x + ox, y + oy, TOP] as Point3);
  return (
    <g>
      {ground.map((g, i) => (
        <g key={i}>
          <Route
            points={[g, air[i] ?? g]}
            className="stroke-ink/40 dark:stroke-[#c9d6ea]/50"
            dashed
            duration={0.4}
            delay={delay + 0.2 * i}
            strokeWidth={0.9}
          />
          {markers && <Ring at={g} r={7} className="fill-sky/20 stroke-sky" />}
        </g>
      ))}
      <Route points={air} curve={HOP} delay={delay} duration={2.4} className="stroke-sky" strokeWidth={2} />
      {air.map((p, i) => {
        const [x, y] = iso(...p);
        return (
          <motion.circle
            key={i}
            cx={x}
            cy={y}
            r={3.4}
            className="fill-white stroke-sky dark:fill-[#172036]"
            strokeWidth={1.6}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: delay + 0.35 * i, duration: 0.4, ease: EASE }}
          />
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ chapters

export function SurveyScene() {
  const [mx, my] = UI.menu;
  const [ix, iy] = UI.input;
  const [bx, by] = UI.balance;
  return (
    <Figure label="The discovery agent's route across the legacy screen" viewBox="-300 -110 720 500">
      <FigureLabel x={-290} y={-92}>
        Fig. 01 — survey flight · model at the controls
      </FigureLabel>
      <Screen />
      <FlightPath />
      <Callout from={[mx, my, TOP + ROUTE_ALTITUDE]} dx={-90} dy={-70} align="end" delay={0.8}>
        e12 · link “Member Inquiry”
      </Callout>
      <Callout from={[ix, iy, TOP + ROUTE_ALTITUDE]} dx={70} dy={-80} delay={1.2}>
        e18 · fill input=member_id
      </Callout>
      <Callout from={[bx, by, TOP + ROUTE_ALTITUDE]} dx={150} dy={74} delay={2}>
        e31 · extract savings_balance
      </Callout>
    </Figure>
  );
}

function Sheet({ z, offset, children, faded }: { z: number; offset: number; children?: ReactNode; faded?: boolean }) {
  return (
    <g opacity={faded ? 0.55 : 1}>
      <Box at={[offset, offset, z]} size={[360, 250, 3]} strokeWidth={1} />
      {children && <g transform={planeTransform(z + 3, offset, offset)}>{children}</g>}
    </g>
  );
}

export function BlueprintScene() {
  const ink = "fill-ink dark:fill-[#c9d6ea]";
  const ladder: [string, string][] = [
    ["attribute", "input[name=MBRNO]"],
    ["role", "link “{{member_id}}”"],
    ["table_cell", "SHARE SAVINGS × CURRENT BALANCE"],
    ["label", "cell labelled “NAME”"],
    ["css", "fallback · clicks only"],
  ];
  return (
    <Figure label="The run as a reviewed, versioned flight plan" viewBox="-330 -150 770 520">
      <FigureLabel x={-250} y={-132}>
        Fig. 02 — flight plan · reviewed before it flies
      </FigureLabel>
      <Sheet z={0} offset={40} faded />
      <Sheet z={22} offset={20} faded />
      <Sheet z={44} offset={0}>
        <text x={18} y={26} className={`${ink} font-mono text-[9px]`}>
          legacycore.member.get_savings_balance@1.0.3
        </text>
        <line x1={18} y1={36} x2={342} y2={36} className="stroke-ink/30 dark:stroke-[#c9d6ea]/30" strokeWidth={0.6} />
        {ladder.map(([by, text], i) => (
          <g key={by} transform={`translate(18 ${54 + i * 24})`}>
            <rect
              width={70}
              height={15}
              rx={2}
              className={i < 4 ? "fill-sky/15 stroke-sky" : "fill-transparent stroke-ink/40"}
              strokeWidth={0.7}
            />
            <text x={6} y={10.5} className={`${ink} font-mono text-[7.5px]`}>
              {by}
            </text>
            <text x={80} y={10.5} className={`${ink} font-mono text-[7.5px] opacity-80`}>
              {text}
            </text>
          </g>
        ))}
        <g transform="translate(286 196)">
          <circle r={32} className="fill-none stroke-sky" strokeWidth={1.6} />
          <circle r={26} className="fill-none stroke-sky" strokeWidth={0.6} />
          <text y={-2} textAnchor="middle" className="fill-sky-ink font-sans text-[8.5px] font-semibold tracking-[0.14em]">
            APPROVED
          </text>
          <text y={10} textAnchor="middle" className="fill-sky-ink font-mono text-[6px]">
            reviewer
          </text>
        </g>
      </Sheet>
      <Callout from={[0, 0, 47]} dx={-60} dy={-50} align="end" delay={0.5}>
        1.0.3 · approved
      </Callout>
      <Callout from={[20, 270, 25]} dx={-36} dy={6} align="end" delay={0.7}>
        1.0.2 · +ACCESS_RESTRICTED
      </Callout>
      <Callout from={[40, 290, 3]} dx={-36} dy={30} align="end" delay={0.9}>
        1.0.0 · as discovered
      </Callout>
      <Callout from={[360, 120, 47]} dx={36} dy={84} delay={1.1}>
        locators ranked by meaning
      </Callout>
    </Figure>
  );
}

// Where each recovery happened on the route, and where its label sits (clear of the screen).
const RECOVERIES: { at: number; label: string; dx: number; dy: number; align: "start" | "end" }[] = [
  { at: 1, label: "HTTP 503 · retried", dx: 70, dy: -120, align: "start" },
  { at: 2, label: "confirm() · accepted", dx: 90, dy: -60, align: "start" },
  { at: 4, label: "session expired · signed on again", dx: -150, dy: -118, align: "end" },
];

export function AutopilotScene() {
  const air = WAYPOINTS.map(([x, y]) => [x, y, TOP + ROUTE_ALTITUDE] as Point3);
  return (
    <Figure label="Deterministic replay of the recorded route, with recoveries marked" viewBox="-300 -110 720 500">
      <FigureLabel x={-290} y={-92}>
        Fig. 03 — autopilot · no model aboard
      </FigureLabel>
      {[120, 190, 260].map((r, i) => (
        <motion.g
          key={r}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.7, 0] }}
          transition={{ duration: 4, delay: i * 1.3, repeat: Infinity, ease: "easeOut" }}
        >
          <Ring at={[220, 150, 0]} r={r} className="fill-none stroke-sky/50" strokeWidth={1} />
        </motion.g>
      ))}
      <Screen />
      <FlightPath delay={0} />
      <circle r={6} className="fill-sky stroke-white dark:stroke-[#172036]" strokeWidth={2}>
        <animateMotion
          dur="6s"
          repeatCount="indefinite"
          path={arcThrough(air, HOP)}
          keyTimes="0;1"
          keySplines="0.45 0 0.55 1"
          calcMode="spline"
        />
      </circle>
      {RECOVERIES.map(({ at, label, dx, dy, align }, i) => {
        const p = air.at(at);
        return p ? (
          <Callout key={label} from={p} dx={dx} dy={dy} align={align} delay={0.8 + i * 0.3}>
            {label}
          </Callout>
        ) : null;
      })}
      <Callout from={air[5] ?? [0, 0, 0]} dx={150} dy={74} delay={1.8}>
        checkpoint · MEMBER DETAIL ✓
      </Callout>
    </Figure>
  );
}

export function OperatorScene() {
  const ink = "fill-ink dark:fill-[#c9d6ea]";
  return (
    <Figure label="An operator takes the same live session at a desk" viewBox="-300 -240 740 500">
      <FigureLabel x={-280} y={-212}>
        Fig. 04 — remotely piloted · same live session
      </FigureLabel>
      <Ring at={[150, 210, 0]} r={46} className="fill-none stroke-ink/40 dark:stroke-[#c9d6ea]/40" />
      {/* desk */}
      {(
        [
          [0, 0],
          [252, 0],
          [0, 122],
          [252, 122],
        ] as const
      ).map(([x, y]) => (
        <Box key={`${x}-${y}`} at={[x, y, 0]} size={[8, 8, 88]} />
      ))}
      <Box at={[-6, -6, 88]} size={[272, 142, 7]} />
      {/* monitors */}
      <Box at={[60, 46, 95]} size={[8, 8, 26]} />
      <Box at={[24, 40, 121]} size={[84, 6, 58]} />
      <g transform={wallYTransform(46, 24, 179)}>
        <rect x={5} y={5} width={74} height={48} className="fill-[#eef1f5] dark:fill-[#25324f]" />
        <rect x={16} y={16} width={52} height={26} className="fill-white stroke-ink/60 dark:fill-[#1d2840]" strokeWidth={0.5} />
        <text x={20} y={24} className={`${ink} font-sans text-[3.6px] font-semibold`}>
          ANNUAL COMPLIANCE ATTESTATION
        </text>
        <rect x={20} y={30} width={3.5} height={3.5} className="fill-sky" />
        <text x={26} y={33.2} className={`${ink} font-sans text-[3.2px]`}>
          I confirm the annual BSA/AML training
        </text>
      </g>
      <Box at={[150, 46, 95]} size={[8, 8, 26]} />
      <Box at={[118, 40, 121]} size={[84, 6, 58]} />
      <g transform={wallYTransform(46, 118, 179)}>
        <rect x={5} y={5} width={74} height={48} className="fill-[#eef1f5] dark:fill-[#25324f]" />
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={10}
            y={12 + i * 9}
            width={40 + (i % 2) * 18}
            height={3}
            className="fill-ink/30 dark:fill-[#c9d6ea]/30"
          />
        ))}
        <circle cx={66} cy={14} r={3} className="fill-sky" />
      </g>
      <Box at={[80, 82, 95]} size={[96, 30, 3]} />
      {/* chair */}
      <Box at={[146, 196, 0]} size={[8, 8, 46]} />
      <Box at={[118, 172, 46]} size={[64, 60, 8]} />
      <Box at={[118, 226, 54]} size={[64, 6, 62]} />
      <Callout from={[60, 46, 170]} dx={-60} dy={-50} align="end" delay={0.6}>
        unknown screen · attestation
      </Callout>
      <Callout from={[200, 46, 175]} dx={44} dy={-60} delay={0.9}>
        lease → dana.ops · epoch 2
      </Callout>
      <Callout from={[176, 112, 98]} dx={56} dy={84} delay={1.2}>
        hand back · postconditions re-verified
      </Callout>
    </Figure>
  );
}

const FILES = ["events.jsonl", "screens/ · masked", "dom/ · redacted", "report.html"];

export function RecorderScene() {
  const ink = "fill-ink dark:fill-[#c9d6ea]";
  return (
    <Figure label="The flight recorder: every run's evidence" viewBox="-330 -420 700 600">
      <FigureLabel x={-320} y={-400}>
        Fig. 05 — flight recorder · every run
      </FigureLabel>
      <Box at={[0, 0, 0]} size={[150, 100, 70]} tone="ink" />
      <g transform={wallYTransform(100, 0, 70)}>
        <rect x={0} y={22} width={150} height={8} className="fill-sky" />
        <text x={10} y={50} className="fill-white font-sans text-[9px] font-semibold tracking-[0.18em]">
          FLIGHT RECORDER
        </text>
      </g>
      {FILES.map((file, i) => {
        const z = 130 + i * 62;
        const off = 4 + i * 10;
        return (
          <motion.g
            key={file}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.18, duration: 0.7, ease: EASE }}
          >
            <Route
              points={[
                [75, 50, 70],
                [off + 70, off + 40, z],
              ]}
              className="stroke-ink/30 dark:stroke-[#c9d6ea]/40"
              dashed
              duration={0.6}
              delay={0.3 + i * 0.18}
              strokeWidth={0.8}
            />
            <Box at={[off, off, z]} size={[140, 80, 2]} strokeWidth={1} />
            <g transform={planeTransform(z + 2, off, off)}>
              {/* set near the front edge, the band the sheet above leaves visible */}
              <text x={22} y={58} className={`${ink} font-mono text-[9px]`}>
                {file}
              </text>
              <rect x={22} y={64} width={60 + i * 10} height={2.5} className="fill-ink/25 dark:fill-[#c9d6ea]/25" />
              <rect x={22} y={70} width={44 + i * 6} height={2.5} className="fill-ink/25 dark:fill-[#c9d6ea]/25" />
            </g>
          </motion.g>
        );
      })}
      <Callout from={[150, 70, 26]} dx={40} dy={56} delay={1}>
        PII returned to the caller, never stored
      </Callout>
      <Callout from={[off(3) + 140, off(3) + 40, 130 + 3 * 62 + 2]} dx={40} dy={-24} delay={1.2}>
        one run id across every file
      </Callout>
    </Figure>
  );
}

function off(i: number): number {
  return 4 + i * 10;
}

const BAYVIEW: [number, number] = [60, 380];

export function TenantsScene() {
  const [bx, by] = UI.balance;
  const [vx, vy] = BAYVIEW;
  return (
    <Figure label="One flight plan replayed on two institutions" viewBox="-640 -110 1120 820">
      <FigureLabel x={-630} y={-90}>
        Fig. 06 — one plan, two airfields
      </FigureLabel>
      <Screen />
      <FlightPath markers={false} />
      <Screen at={BAYVIEW} highlight={false} />
      <FlightPath at={BAYVIEW} markers={false} delay={0.8} />
      <Ring at={onScreen([bx + vx, by + vy])} r={18} className="fill-alert/10 stroke-alert" strokeWidth={1.6} />
      <Callout from={[0, 0, TOP]} dx={-40} dy={-40} align="end" delay={0.6}>
        acme · LegacyCore 4.2.1
      </Callout>
      <Callout from={[vx, vy + 300, TOP]} dx={-30} dy={36} align="end" delay={0.9}>
        bayview · 4.3.0 · relabelled
      </Callout>
      <Callout from={[bx + vx, by + vy, TOP]} dx={70} dy={56} delay={1.3}>
        override s06 · “REGULAR SAVINGS” × “Ledger Balance”
      </Callout>
    </Figure>
  );
}

/** Hero backdrop: a runway in plan view, threshold bars and taxi circles, drawn in hairlines. */
export function RunwayArt({ className }: { className?: string }) {
  const stroke = "stroke-ink/30 dark:stroke-[#c9d6ea]/25";
  return (
    <svg viewBox="-700 -500 1400 1000" className={className} aria-hidden>
      <g
        transform={planeTransform(0, -900, -300)}
        className={`fill-none ${stroke}`}
        strokeWidth={0.9}
        vectorEffect="non-scaling-stroke"
      >
        <rect x={0} y={0} width={1500} height={150} />
        {Array.from({ length: 9 }, (_, i) => (
          <rect key={i} x={30} y={12 + i * 14} width={90} height={8} />
        ))}
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} x1={200 + i * 100} y1={75} x2={260 + i * 100} y2={75} strokeDasharray="0" />
        ))}
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M${140 + i * 26} 20 L${170 + i * 26} 75 L${140 + i * 26} 130`} />
        ))}
        <circle cx={900} cy={520} r={330} />
        <circle cx={-100} cy={640} r={260} />
      </g>
    </svg>
  );
}

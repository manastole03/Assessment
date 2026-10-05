import { useQuery } from "@tanstack/react-query";
import { ReactLenis, useLenis } from "lenis/react";
import { ArrowDown, ArrowUpRight, ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { type ComponentType, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import {
  AutopilotScene,
  BlueprintScene,
  OperatorScene,
  RecorderScene,
  RunwayArt,
  SurveyScene,
  TenantsScene,
} from "@/components/art/scenes";
import { Topo } from "@/components/art/topo";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useTour } from "@/features/tour/tour-context";
import { useStatus } from "@/hooks/use-status";
import { useAuth } from "@/features/auth/auth-context";
import { useRunCount } from "@/hooks/use-runs";
import { apiAll, type CapabilitySummary, type EvalDatasetSummary } from "@/lib/api";
import { percent } from "@/lib/evals";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

// ------------------------------------------------------------------------------------------------ helpers

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Lines that slide up out of a mask, one after another. */
function RevealLines({ lines, delay = 0 }: { lines: string[]; delay?: number }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={line} className="block overflow-hidden pb-[0.08em]">
          <motion.span
            className="block"
            initial={{ y: "105%" }}
            animate={{ y: 0 }}
            transition={{ duration: 1.1, ease: EASE, delay: delay + i * 0.12 }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("label-caps text-sky-ink", className)}>{children}</div>;
}

// ------------------------------------------------------------------------------------------------ header

const SECTIONS: [string, string][] = [
  ["#story", "How it flies"],
  ["#tenants", "Tenants"],
  ["#instruments", "Evals"],
  ["#agents", "Agents"],
];

function SiteHeader() {
  const tour = useTour();
  const { scrollY } = useScroll();
  const [solid, setSolid] = useState(false);
  const [night, setNight] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => {
    setSolid(y > 24);
    // Match whatever is under the header: a night section turns the header night too. Checked on the next
    // frame, after the pinned story has re-rendered for the chapter this scroll moved it to.
    requestAnimationFrame(() => {
      const below = document.elementFromPoint(window.innerWidth / 2, 80);
      setNight(!!below?.closest(".dark") && !document.documentElement.classList.contains("dark"));
    });
  });
  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 bg-transparent text-foreground transition-[background-color,border-color,color] duration-500",
        night && "dark",
        solid ? "border-b bg-background/90 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-[4.5rem] max-w-[88rem] items-center justify-between gap-6 px-5 sm:px-10">
        <Brand subtitle="record once · replay by rote" />
        <nav aria-label="Sections" className="hidden items-center gap-8 lg:flex">
          {SECTIONS.map(([href, label]) => (
            <a key={href} href={href} className="link-rule label-caps text-[0.75rem] text-foreground hover:text-sky-ink">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={tour.start} className="hidden sm:inline-flex">
            Take the tour
          </Button>
          <Button asChild size="sm">
            <Link to="/overview">
              Open the studio <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------------------------------------ hero

function InstrumentStrip() {
  const status = useStatus();
  // Live readings need a session; signed-out visitors see dashes.
  const signedIn = useAuth().status === "authenticated";
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiAll<CapabilitySummary>("/capabilities"),
    enabled: signedIn,
  });
  const runs = useRunCount();
  const evals = useQuery({
    queryKey: ["eval-datasets"],
    queryFn: () => apiAll<EvalDatasetSummary>("/evals/datasets"),
    enabled: signedIn,
  });
  const replay = evals.data?.find((d) => d.kind === "replay")?.latest?.summary;
  const tenants = status.data?.tenants ?? [];
  const readings: [string, string][] = [
    ["Approved", capabilities.data ? String(capabilities.data.filter((c) => c.status === "approved").length) : "—"],
    ["Runs", signedIn && runs.data !== undefined ? String(runs.data) : "—"],
    ["Replay eval", replay ? percent(replay.pass_rate) : "—"],
    ["Tenants up", status.data ? `${tenants.filter((t) => t.reachable).length}/${tenants.length}` : "—"],
  ];
  return (
    <dl aria-label="From this workspace" className="flex flex-wrap gap-x-7 gap-y-2">
      {readings.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="label-caps text-[0.62rem] text-muted-foreground">{label}</dt>
          <dd className="font-mono text-sm text-foreground tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScrollCue({ href }: { href: string }) {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const offset = useTransform(progress, [0, 1], [1, 0]);
  return (
    <a href={href} className="group flex items-center gap-3" aria-label="Scroll to how rote flies a task">
      <span className="label-caps text-[0.68rem] text-foreground">Scroll</span>
      <span className="relative grid size-14 place-items-center">
        <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="28" cy="28" r="26" className="fill-card/70 stroke-border" strokeWidth="1" />
          <motion.circle
            cx="28"
            cy="28"
            r="26"
            className="fill-none stroke-sky"
            strokeWidth="1.6"
            pathLength={1}
            strokeDasharray="1"
            style={{ strokeDashoffset: offset }}
          />
        </svg>
        <ArrowDown className="relative size-5 text-foreground transition-transform duration-500 ease-out-expo group-hover:translate-y-0.5" />
      </span>
    </a>
  );
}

function Hero() {
  const tour = useTour();
  return (
    <section className="relative flex min-h-svh flex-col overflow-hidden">
      <Topo className="text-ink/[0.13] dark:text-[#c9d6ea]/10" />
      <RunwayArt className="pointer-events-none absolute -top-[18%] -left-[22%] w-[78rem] max-w-none" />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute top-[58%] -right-[10%] h-px w-[70%] origin-right -rotate-[18deg] bg-gradient-to-l from-sky/70 to-transparent"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 1.8, ease: EASE, delay: 0.6 }}
      />
      <div className="relative mx-auto flex w-full max-w-[88rem] flex-1 flex-col items-center justify-center px-5 pt-28 pb-10 text-center sm:px-10">
        <div data-tour="hero" className="flex max-w-4xl flex-col items-center">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.1 }}>
            <Eyebrow>Computer use for back-office software</Eyebrow>
          </motion.div>
          <h1 className="mt-6 text-[clamp(2.6rem,6.4vw,5.6rem)] leading-[1.02] tracking-[-0.015em] text-foreground">
            <RevealLines lines={["Autopilot for software", "that has no API."]} delay={0.15} />
          </h1>
          <motion.p
            className="mt-7 max-w-2xl text-lg leading-relaxed font-light text-muted-foreground sm:text-xl"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: EASE, delay: 0.55 }}
          >
            An AI agent flies a back-office task once, on the real legacy screen. The flight becomes a reviewed plan that replays
            deterministically, with no model aboard, and hands the controls to a person when the screen is unknown.
          </motion.p>
          <motion.div
            className="mt-10 flex flex-wrap justify-center gap-3"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: EASE, delay: 0.7 }}
          >
            <Button size="lg" onClick={tour.start}>
              Start the tour
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/overview">
                Open the studio <ArrowUpRight />
              </Link>
            </Button>
          </motion.div>
        </div>
      </div>
      <div className="relative mx-auto flex w-full max-w-[88rem] items-end justify-between gap-6 px-5 pb-8 sm:px-10">
        <InstrumentStrip />
        <div className="hidden sm:block">
          <ScrollCue href="#story" />
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the story

interface Chapter {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  facts: [string, string][];
  Scene: ComponentType;
  night?: boolean;
}

const CHAPTERS: Chapter[] = [
  {
    id: "survey",
    eyebrow: "Discover",
    title: "The model flies it once.",
    body: "Describe the goal in plain language. An AI agent drives the real legacy UI, acting on elements it can name rather than raw pixels, and every action is recorded as it happens.",
    facts: [
      ["Pilot", "Claude, at authoring time only"],
      ["Sees", "named elements + a screenshot"],
      ["Records", "steps, locators, waypoints"],
    ],
    Scene: SurveyScene,
  },
  {
    id: "plan",
    eyebrow: "Review",
    title: "The flight becomes a plan.",
    body: "The run is written down as a typed, versioned artifact: its contract, every step with ranked locators, and handlers for the screens it knows. Nothing flies unattended until a person approves it.",
    facts: [
      ["Format", "YAML in git · JSON Schema"],
      ["Versions", "semver · draft → approved"],
      ["Locators", "attribute › role › cell › label"],
    ],
    Scene: BlueprintScene,
  },
  {
    id: "autopilot",
    eyebrow: "Replay",
    title: "Autopilot. No model aboard.",
    body: "Production replays the plan deterministically: waits on conditions, finds elements by meaning, types every output. Known turbulence such as a 503, a native dialog or an expired session is recognised and recovered.",
    facts: [
      ["Result", "succeeded · outcome · failed"],
      ["Recoveries", "listed on every result"],
      ["Drift", "reported before it breaks"],
    ],
    Scene: AutopilotScene,
    night: true,
  },
  {
    id: "handoff",
    eyebrow: "Hand off",
    title: "Unknown screen? A pilot takes over.",
    body: "When replay meets a screen no handler knows, it stops and pages a person. They take the same live session in the browser, finish the step and hand back. Every action is recorded; a late click from a stale tab is refused.",
    facts: [
      ["Control", "one lease, fenced by epoch"],
      ["Audit", "each human action recorded"],
      ["Resume", "postconditions re-verified"],
    ],
    Scene: OperatorScene,
  },
  {
    id: "recorder",
    eyebrow: "Evidence",
    title: "Every run leaves a flight recorder.",
    body: "Each run writes a structured event log, masked screenshots, redacted DOM and a readable report. Personal data goes back to the caller and is never stored.",
    facts: [
      ["Log", "events.jsonl"],
      ["Screens", "masked before capture"],
      ["Report", "report.html for every run"],
    ],
    Scene: RecorderScene,
  },
];

function ChapterText({ chapter, index }: { chapter: Chapter; index: number }) {
  return (
    <div>
      <Eyebrow>
        {String(index + 1).padStart(2, "0")} — {chapter.eyebrow}
      </Eyebrow>
      <h2 className="mt-5 text-[clamp(2rem,3.4vw,3.2rem)] leading-[1.06] text-foreground">{chapter.title}</h2>
      <p className="mt-5 max-w-md leading-relaxed font-light text-muted-foreground">{chapter.body}</p>
      <dl className="mt-8 max-w-md divide-y border-y">
        {chapter.facts.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="label-caps text-[0.62rem] text-muted-foreground">{k}</dt>
            <dd className="text-right font-mono text-[0.78rem] text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Rail({ active, onSelect }: { active: number; onSelect: (i: number) => void }) {
  return (
    <div className="flex flex-col items-center rounded-full border bg-card/70 px-2 py-3 backdrop-blur">
      {CHAPTERS.map((chapter, i) => (
        <div key={chapter.id} className="flex flex-col items-center">
          {i > 0 && (
            <span className="relative h-9 w-px bg-border">
              <motion.span
                className="absolute inset-x-0 top-0 bg-sky"
                animate={{ height: i <= active ? "100%" : "0%" }}
                transition={{ duration: 0.5, ease: EASE }}
              />
            </span>
          )}
          <button
            type="button"
            onClick={() => onSelect(i)}
            aria-label={`${String(i + 1).padStart(2, "0")} ${chapter.eyebrow}`}
            aria-current={i === active ? "step" : undefined}
            className="grid size-5 place-items-center rounded-full"
          >
            {i === active ? (
              <span className="grid size-4 place-items-center rounded-full border-[1.5px] border-sky bg-card">
                <span className="size-1.5 rounded-full bg-sky" />
              </span>
            ) : (
              <span className={cn("size-1.5 rounded-full", i < active ? "bg-sky" : "bg-foreground/25")} />
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

function PinnedStory() {
  const section = useRef<HTMLElement>(null);
  const lenis = useLenis();
  const { scrollYProgress } = useScroll({ target: section, offset: ["start start", "end end"] });
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (p) => {
    setActive(Math.min(CHAPTERS.length - 1, Math.max(0, Math.floor(p * CHAPTERS.length * 0.999))));
  });
  const chapter = CHAPTERS.at(active) ?? CHAPTERS.at(0);
  const scrollTo = (top: number, duration: number) => {
    if (lenis) lenis.scrollTo(top, { duration });
    else window.scrollTo({ top, behavior: "smooth" });
  };
  // The pinned section scrolls (height − one screen); chapter i owns the i-th slice of that distance.
  const go = (i: number) => {
    const el = section.current;
    if (!el) return;
    const travel = el.offsetHeight - window.innerHeight;
    scrollTo(el.getBoundingClientRect().top + window.scrollY + ((i + 0.5) / CHAPTERS.length) * travel, 1.4);
  };
  const skip = () => {
    const el = section.current;
    if (el) scrollTo(el.getBoundingClientRect().top + window.scrollY + el.offsetHeight, 1.6);
  };
  if (!chapter) return null;
  const { Scene } = chapter;
  return (
    <section ref={section} id="story" style={{ height: `${CHAPTERS.length * 100}vh` }} className="relative">
      <div
        data-tour="how-it-works"
        className={cn(
          "sticky top-0 h-svh overflow-hidden bg-background text-foreground transition-colors duration-700",
          chapter.night && "dark",
        )}
      >
        <Topo seed={31} className="text-ink/[0.08] dark:text-[#c9d6ea]/[0.07]" />
        <div className="relative mx-auto grid h-full max-w-[88rem] grid-cols-[minmax(0,25rem)_minmax(0,1fr)] items-center gap-10 px-10 pt-16">
          <AnimatePresence mode="wait">
            <motion.div
              key={chapter.id}
              initial={{ opacity: 0, y: 26 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -18 }}
              transition={{ duration: 0.6, ease: EASE }}
            >
              <ChapterText chapter={chapter} index={active} />
            </motion.div>
          </AnimatePresence>
          <div className="relative pr-24">
            <AnimatePresence mode="wait">
              <motion.div key={chapter.id} className="mx-auto w-full max-w-[52rem]">
                <Scene />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className="absolute top-1/2 right-8 -translate-y-1/2">
          <Rail active={active} onSelect={go} />
        </div>
        <button
          type="button"
          onClick={skip}
          className="absolute right-10 bottom-8 flex items-center gap-1 label-caps text-[0.68rem] text-foreground hover:text-sky-ink"
        >
          Skip <ChevronRight className="size-3.5" />
        </button>
        <div className="absolute bottom-8 left-10 label-caps text-[0.62rem] text-muted-foreground">
          Scroll to advance · {String(active + 1).padStart(2, "0")} / {String(CHAPTERS.length).padStart(2, "0")}
        </div>
      </div>
    </section>
  );
}

function StackedStory() {
  return (
    <section id="story" data-tour="how-it-works">
      {CHAPTERS.map((chapter, i) => (
        <div
          key={chapter.id}
          className={cn("border-t bg-background px-5 py-20 text-foreground sm:px-10", chapter.night && "dark")}
        >
          <div className="mx-auto max-w-2xl">
            <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true, margin: "-80px" }}>
              <chapter.Scene />
            </motion.div>
            <div className="mt-10">
              <ChapterText chapter={chapter} index={i} />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ tenants

function Tenants() {
  return (
    <section id="tenants" className="relative scroll-mt-16 overflow-hidden border-t bg-background">
      <div className="mx-auto grid max-w-[88rem] items-center gap-14 px-5 py-28 sm:px-10 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.9, ease: EASE }}
        >
          <Eyebrow>06 — Multi-tenant</Eyebrow>
          <h2 className="mt-5 text-[clamp(2rem,3.4vw,3.2rem)] leading-[1.06]">One flight plan, many airfields.</h2>
          <p className="mt-5 leading-relaxed font-light text-muted-foreground">
            Institutions run the same vendor product, configured differently. The plan is resolved per run as base ⊕ vendor
            profile ⊕ a small, reviewed tenant override, and the result records exactly which layers flew.
          </p>
          <pre className="mt-8 overflow-x-auto rounded-md border bg-card p-4 font-mono text-[0.72rem] leading-relaxed text-foreground">
            <span className="text-muted-foreground">{"# config/tenants/bayview.yaml\n"}</span>
            {"s06_read_savings_balance:\n  prepend_locators:\n"}
            <span className="text-sky-ink">{"  - row: REGULAR SAVINGS\n    column: Ledger Balance"}</span>
          </pre>
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: "-120px" }}
          transition={{ duration: 0.8 }}
        >
          <TenantsScene />
        </motion.div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ instruments

const START = 135; // degrees; a 270° dial from lower-left, over the top, to lower-right
const SWEEP = 270;

function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [100 + r * Math.cos(rad), 100 + r * Math.sin(rad)];
}

/** An aircraft-style dial: numerals outside the face, ticks every 10%, a needle and an arc at the pass rate. */
function Gauge({ value, label, sublabel, href }: { value: number | null; label: string; sublabel: string; href: string }) {
  const v = value ?? 0;
  const [ax, ay] = polar(START, 70);
  const [bx, by] = polar(START + SWEEP * v, 70);
  return (
    <Link to={href} className="group flex flex-col items-center gap-4 rounded-md p-4 transition-colors hover:bg-card/60">
      <svg
        viewBox="0 0 200 200"
        className="w-full max-w-[15rem]"
        role="img"
        aria-label={`${label}: ${value === null ? "not run" : percent(value)}`}
      >
        <circle cx="100" cy="100" r="82" className="fill-card stroke-foreground/70" strokeWidth="1.2" />
        <circle cx="100" cy="100" r="76" className="fill-none stroke-border" strokeWidth="0.6" />
        {Array.from({ length: 11 }, (_, t) => {
          const deg = START + (SWEEP * t) / 10;
          const [x1, y1] = polar(deg, t % 5 === 0 ? 62 : 67);
          const [x2, y2] = polar(deg, 74);
          const [lx, ly] = polar(deg, 93);
          return (
            <g key={t}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-foreground" strokeWidth={t % 5 === 0 ? 1.6 : 0.8} />
              {t % 5 === 0 && (
                <text x={lx} y={ly + 3} textAnchor="middle" className="fill-muted-foreground font-mono text-[8px]">
                  {t * 10}
                </text>
              )}
            </g>
          );
        })}
        {v > 0 && (
          <motion.path
            d={`M${ax} ${ay} A70 70 0 ${SWEEP * v > 180 ? 1 : 0} 1 ${bx} ${by}`}
            className="fill-none stroke-sky"
            strokeWidth="3"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.6, ease: EASE }}
          />
        )}
        <motion.line
          x1="100"
          y1="100"
          x2="156"
          y2="100"
          className="stroke-foreground"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ transformOrigin: "100px 100px", transformBox: "view-box" }}
          initial={{ rotate: START }}
          whileInView={{ rotate: START + SWEEP * v }}
          viewport={{ once: true }}
          transition={{ duration: 1.8, ease: EASE, delay: 0.1 }}
        />
        <circle cx="100" cy="100" r="5" className="fill-foreground" />
        <text x="100" y="150" textAnchor="middle" className="fill-foreground font-heading text-[19px]">
          {value === null ? "—" : percent(value)}
        </text>
        <text
          x="100"
          y="163"
          textAnchor="middle"
          className="fill-muted-foreground font-mono text-[6.5px] tracking-[0.12em] uppercase"
        >
          pass rate
        </text>
      </svg>
      <div className="text-center">
        <div className="font-heading text-xl text-foreground group-hover:text-sky-ink">{label}</div>
        <div className="mt-1 label-caps text-[0.6rem] text-muted-foreground">{sublabel}</div>
      </div>
    </Link>
  );
}

function Instruments() {
  const signedIn = useAuth().status === "authenticated";
  const { data } = useQuery({
    queryKey: ["eval-datasets"],
    queryFn: () => apiAll<EvalDatasetSummary>("/evals/datasets"),
    enabled: signedIn,
  });
  const order = ["replay", "probe", "discovery"];
  const datasets = [...(data ?? [])].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <section id="instruments" className="relative scroll-mt-16 overflow-hidden border-t bg-background">
      <Topo seed={57} className="text-ink/[0.07] dark:text-[#c9d6ea]/[0.06]" />
      <div className="relative mx-auto max-w-[88rem] px-5 py-28 sm:px-10">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-end">
          <div>
            <Eyebrow>07 — Evals</Eyebrow>
            <h2 className="mt-5 text-[clamp(2rem,3.4vw,3.2rem)] leading-[1.06]">Instrument check before every release.</h2>
          </div>
          <p className="leading-relaxed font-light text-muted-foreground">
            Versioned datasets grade the replay engine, screen classification and the discovery agent, each case in its own
            sandbox. These dials read this workspace's latest full runs.
          </p>
        </div>
        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          {datasets.map((d) => (
            <Gauge
              key={d.id}
              value={d.latest?.summary ? d.latest.summary.pass_rate : null}
              label={d.title}
              sublabel={`${d.cases} cases · ${d.uses_model ? "model or stand-in" : "no model"}`}
              href={d.latest ? `/evals/${encodeURIComponent(d.latest.id)}` : "/evals"}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ agents + footer

const FOOTER_LINKS: [string, string][] = [
  ["/overview", "Studio"],
  ["/capabilities", "Capabilities"],
  ["/runs", "Runs"],
  ["/evals", "Evals"],
  ["/agents", "Agents & MCP"],
  ["/policy", "Policy"],
];

function Agents() {
  const origin = window.location.origin;
  return (
    <section id="agents" className="dark scroll-mt-16 bg-background text-foreground">
      <div className="relative overflow-hidden">
        <Topo seed={91} className="text-[#c9d6ea]/[0.07]" />
        <div className="relative mx-auto grid max-w-[88rem] gap-14 px-5 py-28 sm:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-center">
          <div>
            <Eyebrow>08 — Agents</Eyebrow>
            <h2 className="mt-5 text-[clamp(2.2rem,4.6vw,4.4rem)] leading-[1.04]">Cleared for any agent.</h2>
            <p className="mt-6 max-w-xl leading-relaxed font-light text-muted-foreground">
              Every approved capability is a tool. An MCP client lists them and calls one; the call is checked against the
              contract before anything starts, replayed, and appears live in the studio with its evidence.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/agents">
                  Agents & MCP <ArrowUpRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="/api/docs">API reference</a>
              </Button>
            </div>
          </div>
          <div className="rounded-md border bg-card/60 p-6">
            <div className="flex items-center justify-between">
              <span className="label-caps text-[0.62rem] text-muted-foreground">MCP · streamable HTTP</span>
              <span className="flex items-center gap-2 label-caps text-[0.62rem] text-sky-ink">
                <span className="size-1.5 animate-pulse rounded-full bg-sky" /> listening
              </span>
            </div>
            <div className="mt-5 font-mono text-[clamp(1.1rem,2.2vw,1.6rem)] break-all text-foreground">{origin}/api/v1/mcp</div>
            <div className="mt-6 border-t pt-5 font-mono text-[0.72rem] leading-relaxed break-all text-muted-foreground">
              <span className="text-foreground">$</span> claude mcp add --transport http rote {origin}/api/v1/mcp --header
              &quot;Authorization: Bearer $ROTE_API_KEY&quot;
              <br />
              <span className="text-foreground">$</span> uv run rote mcp <span className="opacity-70"># stdio</span>
            </div>
          </div>
        </div>
      </div>
      <footer className="border-t">
        <div className="mx-auto max-w-[88rem] px-5 pt-16 pb-10 sm:px-10">
          <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
            <div className="font-heading text-[clamp(5rem,16vw,13rem)] leading-[0.8] tracking-[-0.03em] text-foreground">
              rote
            </div>
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-14 gap-y-3 sm:grid-cols-3">
              {FOOTER_LINKS.map(([to, label]) => (
                <Link
                  key={to}
                  to={to}
                  className="link-rule w-fit label-caps text-[0.68rem] text-muted-foreground hover:text-foreground"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="mt-14 flex flex-col justify-between gap-3 border-t pt-6 sm:flex-row">
            <span className="annotation text-muted-foreground">A local workstation tool · binds to 127.0.0.1 · no login</span>
            <span className="annotation text-muted-foreground">Record once. Replay by rote.</span>
          </div>
        </div>
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ page

export default function LandingPage() {
  const reduced = useReducedMotion() ?? false;
  const wide = useMediaQuery("(min-width: 1024px)");
  const page = (
    <div className="min-h-svh bg-background text-foreground">
      <SiteHeader />
      <main>
        <Hero />
        {wide ? <PinnedStory /> : <StackedStory />}
        <Tenants />
        <Instruments />
        <Agents />
      </main>
    </div>
  );
  return reduced ? (
    page
  ) : (
    <ReactLenis root options={{ lerp: 0.11, anchors: true }}>
      {page}
    </ReactLenis>
  );
}

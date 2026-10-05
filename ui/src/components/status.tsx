import {
  Archive,
  BadgeInfo,
  Bot,
  CheckCircle2,
  CircleDashed,
  CircleMinus,
  Eye,
  Hand,
  KeyRound,
  Loader2,
  Lock,
  OctagonX,
  PencilLine,
  Repeat,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Undo2,
  UserRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Tone {
  label: string;
  icon: LucideIcon;
  className: string;
  spin?: boolean;
}

// Status colour always travels with an icon and a text label — never colour alone.
const TONES = {
  green: "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  blue: "border-sky/30 bg-sky/10 text-sky-ink",
  violet: "border-violet-600/25 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  amber: "border-amber-600/30 bg-amber-500/15 text-amber-900 dark:text-amber-300",
  red: "border-red-600/25 bg-red-500/10 text-red-800 dark:text-red-300",
  muted: "border-border bg-muted text-muted-foreground",
};

function ToneBadge({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone.className, className)}>
      <Icon className={cn("size-3", tone.spin && "animate-spin")} aria-hidden />
      {tone.label}
    </Badge>
  );
}

const RUN: Record<string, Tone> = {
  running: { label: "Running", icon: Loader2, className: TONES.blue, spin: true },
  succeeded: { label: "Succeeded", icon: CheckCircle2, className: TONES.green },
  business_outcome: { label: "Business outcome", icon: BadgeInfo, className: TONES.violet },
  failed: { label: "Failed", icon: XCircle, className: TONES.red },
  error: { label: "Error", icon: OctagonX, className: TONES.red },
  interrupted: { label: "Interrupted", icon: CircleDashed, className: TONES.muted },
};

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  return <ToneBadge tone={RUN[status] ?? { label: status, icon: CircleDashed, className: TONES.muted }} className={className} />;
}

const CAPABILITY: Record<string, Tone> = {
  approved: { label: "Approved", icon: ShieldCheck, className: TONES.green },
  draft: { label: "Draft", icon: PencilLine, className: TONES.amber },
  deprecated: { label: "Deprecated", icon: Archive, className: TONES.muted },
};

export function CapabilityStatusBadge({ status }: { status: string }) {
  return <ToneBadge tone={CAPABILITY[status] ?? CAPABILITY.draft} />;
}

const RISK: Record<string, Tone> = {
  read_only: { label: "Read only", icon: Eye, className: TONES.muted },
  reversible: { label: "Reversible", icon: Undo2, className: TONES.blue },
  irreversible: { label: "Irreversible", icon: TriangleAlert, className: TONES.red },
};

export function RiskBadge({ risk }: { risk: string }) {
  return <ToneBadge tone={RISK[risk] ?? RISK.reversible} />;
}

const SENSITIVITY: Record<string, Tone> = {
  public: { label: "public", icon: Eye, className: TONES.muted },
  internal: { label: "internal", icon: Eye, className: TONES.muted },
  pii: { label: "PII", icon: Lock, className: TONES.amber },
  secret: { label: "secret", icon: KeyRound, className: TONES.red },
};

export function SensitivityBadge({ sensitivity }: { sensitivity: string }) {
  return <ToneBadge tone={SENSITIVITY[sensitivity] ?? SENSITIVITY.internal} />;
}

const LEASE: Record<string, Tone> = {
  automated: { label: "Automation in control", icon: Bot, className: TONES.green },
  awaiting_human: { label: "Waiting for an operator", icon: Hand, className: TONES.amber },
  human: { label: "Operator in control", icon: UserRound, className: TONES.blue },
};

export function LeaseBadge({ state, holder, epoch }: { state: string; holder?: string; epoch?: number }) {
  const tone = LEASE[state] ?? LEASE.automated;
  const label = state === "human" && holder ? `${holder} in control · epoch ${epoch}` : tone.label;
  return <ToneBadge tone={{ ...tone, label }} className={cn(state === "awaiting_human" && "animate-pulse")} />;
}

const KIND: Record<string, Tone> = {
  replay: { label: "Replay", icon: Repeat, className: TONES.muted },
  discovery: { label: "Discovery", icon: Sparkles, className: TONES.muted },
  probe: { label: "Probe", icon: ScanSearch, className: TONES.muted },
};

export function KindBadge({ kind }: { kind: string }) {
  return <ToneBadge tone={KIND[kind] ?? KIND.replay} />;
}

const HANDLER: Record<string, Tone> = {
  business_outcome: { label: "Business outcome", icon: BadgeInfo, className: TONES.violet },
  recoverable: { label: "Recoverable", icon: Repeat, className: TONES.blue },
  failure: { label: "Known failure", icon: XCircle, className: TONES.red },
};

export function HandlerKindBadge({ kind }: { kind: string }) {
  return <ToneBadge tone={HANDLER[kind] ?? HANDLER.recoverable} />;
}

export function SourceBadge({ source }: { source: string }) {
  const className =
    source === "tenant" ? TONES.amber : source === "capability" ? TONES.blue : source === "human" ? TONES.violet : TONES.muted;
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px] font-normal", className)}>
      {source}
    </Badge>
  );
}

const EVAL: Record<string, Tone> = {
  running: { label: "Running", icon: Loader2, className: TONES.blue, spin: true },
  completed: { label: "Completed", icon: CheckCircle2, className: TONES.muted },
  error: { label: "Error", icon: OctagonX, className: TONES.red },
};

export function EvalStatusBadge({ status }: { status: string }) {
  return <ToneBadge tone={EVAL[status] ?? EVAL.completed} />;
}

const VERDICT: Record<"pass" | "fail" | "skip", Tone> = {
  pass: { label: "Pass", icon: CheckCircle2, className: TONES.green },
  fail: { label: "Fail", icon: XCircle, className: TONES.red },
  skip: { label: "Not graded", icon: CircleMinus, className: TONES.muted },
};

/** Pass / fail / not graded — always icon + label, never colour alone. */
export function VerdictBadge({ passed, className }: { passed: boolean | null; className?: string }) {
  return <ToneBadge tone={VERDICT[passed === null ? "skip" : passed ? "pass" : "fail"]} className={className} />;
}

const MODE: Record<string, Tone> = {
  deterministic: { label: "No model", icon: Repeat, className: TONES.muted },
  offline: { label: "Offline stand-in", icon: Bot, className: TONES.muted },
  live: { label: "Live model", icon: Sparkles, className: TONES.violet },
};

export function EvalModeBadge({ mode }: { mode: string }) {
  return <ToneBadge tone={MODE[mode] ?? MODE.offline} />;
}

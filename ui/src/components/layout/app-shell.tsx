import { Compass, KeyRound, LogOut, Menu, Server } from "lucide-react";
import { Suspense, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { toast } from "sonner";

import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/auth-context";
import { useTour } from "@/features/tour/tour-context";
import { useStatus } from "@/hooks/use-status";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/overview", label: "Overview" },
  { to: "/capabilities", label: "Capabilities" },
  { to: "/run", label: "Run a capability" },
  { to: "/discover", label: "Discover" },
  { to: "/runs", label: "Runs" },
  { to: "/evidence", label: "Evidence" },
  { to: "/evals", label: "Evals" },
  { to: "/agents", label: "Agents & MCP" },
  { to: "/policy", label: "Policy & tenants" },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col" aria-label="Main" data-tour="nav">
      {NAV.map(({ to, label }, i) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group relative flex items-center gap-3 py-2 pr-2 pl-4 text-muted-foreground transition-colors duration-300 hover:text-foreground",
              "before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:origin-top before:scale-y-0 before:bg-sky before:transition-transform before:duration-500 before:ease-out-expo",
              isActive && "text-foreground before:scale-y-100",
            )
          }
        >
          <span className="w-5 annotation text-[0.62rem] text-muted-foreground/70 tabular-nums">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="label-caps">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function Health() {
  const { data } = useStatus();
  if (!data) return null;
  return (
    <div className="space-y-1.5 rounded-md border bg-card p-3 text-xs">
      <div className="label-caps text-muted-foreground">Environment</div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <KeyRound className={cn("size-3.5", data.has_api_key ? "text-emerald-600" : "text-amber-600")} aria-hidden />
            <span>{data.has_api_key ? "API key set" : "No API key"}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-60">
          {data.has_api_key
            ? `Discovery and probe use ${data.model} (effort ${data.effort}).`
            : "Discovery and probe need ANTHROPIC_API_KEY in .env. Replay never calls a model."}
        </TooltipContent>
      </Tooltip>
      {data.tenants.map((t) => (
        <Tooltip key={t.id}>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Server className={cn("size-3.5", t.reachable ? "text-emerald-600" : "text-red-600")} aria-hidden />
              <span className="truncate">
                {t.id} <span className="text-muted-foreground">{t.reachable ? "reachable" : "offline"}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {t.name} · {t.base_url}
            {!t.reachable && " — the target app is not answering"}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** Who is signed in, with what role, and the way out. */
function UserCard() {
  const { user, role, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const signOut = async () => {
    try {
      await logout();
    } catch {
      toast.error("Signed out locally; the server could not be reached");
    }
    void navigate("/login", { replace: true });
  };
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card p-2.5 text-xs" data-testid="user-card">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{user.name}</div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="truncate">{user.email}</span>
        </div>
        <div className="mt-1 label-caps text-[0.6rem] text-sky-ink">{role?.toLowerCase()}</div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Sign out</TooltipContent>
      </Tooltip>
    </div>
  );
}

function TourButton({ onClick }: { onClick?: () => void }) {
  const tour = useTour();
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start"
      data-tour="tour-relaunch"
      onClick={() => {
        onClick?.();
        tour.start();
      }}
    >
      <Compass /> Take the tour
    </Button>
  );
}

function MobileTourButton() {
  const tour = useTour();
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Take the tour" data-tour="tour-relaunch" onClick={tour.start}>
      <Compass />
    </Button>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col gap-7 border-r bg-sidebar px-3 py-4 lg:flex">
        <div className="flex items-center justify-between pt-1">
          <Brand />
          <ThemeToggle />
        </div>
        <Nav />
        <div className="mt-auto space-y-2">
          <TourButton />
          <Health />
          <UserCard />
        </div>
      </aside>
      <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b bg-background/90 px-4 backdrop-blur lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Open navigation" data-tour="nav">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col gap-6 p-3">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Brand />
            <Nav onNavigate={() => setOpen(false)} />
            <div className="mt-auto space-y-2">
              <TourButton onClick={() => setOpen(false)} />
              <Health />
              <UserCard />
            </div>
          </SheetContent>
        </Sheet>
        <Brand />
        <div className="flex items-center gap-1">
          <MobileTourButton />
          <ThemeToggle />
        </div>
      </header>
      <main className="lg:pl-60">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

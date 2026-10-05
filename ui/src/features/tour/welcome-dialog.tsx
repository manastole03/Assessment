import { useRef } from "react";

import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const STAGES: [string, string][] = [
  ["Discover", "the model flies the task once, on the real screen"],
  ["Review", "the flight becomes a typed plan you approve"],
  ["Replay", "deterministic, with no model aboard"],
  ["Hand off", "a person takes the same live session when needed"],
];

export function WelcomeDialog({ open, onStart, onDismiss }: { open: boolean; onStart: () => void; onDismiss: () => void }) {
  const startButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Focus the primary action rather than the first button in DOM order.
          event.preventDefault();
          startButton.current?.focus();
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between pr-8">
            <BrandMark />
            <span className="label-caps text-[0.6rem] text-sky-ink">First flight</span>
          </div>
          <DialogTitle className="mt-3 font-heading text-[1.7rem] leading-tight font-normal">Welcome to rote</DialogTitle>
          <DialogDescription className="font-light">
            Teach automation a back-office task once, then run it reliably. A one-minute tour shows you around the studio.
          </DialogDescription>
        </DialogHeader>
        {/* The four stages as a route: waypoints on one line. */}
        <ol className="relative my-1 space-y-4 pl-7">
          <span aria-hidden className="absolute top-2 bottom-2 left-[6px] w-px bg-border" />
          {STAGES.map(([title, text], i) => (
            <li key={title} className="relative">
              <span
                aria-hidden
                className="absolute top-1 -left-7 grid size-[13px] place-items-center rounded-full border-[1.5px] border-sky bg-popover"
              >
                <span className="size-[4px] rounded-full bg-sky" />
              </span>
              <div className="flex items-baseline gap-2">
                <span className="annotation text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-heading text-base text-foreground">{title}</span>
              </div>
              <p className="text-sm font-light text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Skip for now
          </Button>
          <Button ref={startButton} onClick={onStart}>
            Start the tour
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

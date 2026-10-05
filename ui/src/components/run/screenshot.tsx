import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A masked evidence screenshot; click to enlarge. */
export function ScreenshotThumb({ src, label, className }: { src: string; label: string; className?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "group overflow-hidden rounded-md border bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`Enlarge screenshot: ${label}`}
        >
          <img src={src} alt={label} loading="lazy" className="w-full transition-opacity group-hover:opacity-90" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(1100px,95vw)] sm:max-w-[min(1100px,95vw)]">
        <DialogTitle className="font-mono text-sm">{label}</DialogTitle>
        <img src={src} alt={label} className="w-full rounded-md border" />
      </DialogContent>
    </Dialog>
  );
}

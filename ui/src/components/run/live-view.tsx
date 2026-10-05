import { MonitorPlay, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { operatorUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The live browser session. Observers get a masked view; whoever holds the lease gets the real
 * screen and can click it (clicks are forwarded with their lease epoch).
 */
export function LiveView({
  runId,
  interactive,
  onClickAt,
}: {
  runId: string;
  interactive: boolean;
  onClickAt?: (x: number, y: number) => void;
}) {
  const [src, setSrc] = useState<string>();
  const [closed, setClosed] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let stop = false;
    let current: string | undefined;
    const tick = async () => {
      try {
        const response = await fetch(`${operatorUrl(runId, "live.jpg")}?mask=${interactive ? 0 : 1}&t=${Date.now()}`);
        if (response.status === 409) {
          setClosed(true);
          return;
        }
        if (response.status === 200) {
          const url = URL.createObjectURL(await response.blob());
          setSrc(url);
          if (current) URL.revokeObjectURL(current);
          current = url;
        }
      } catch {
        /* transient */
      }
      if (!stop) setTimeout(() => void tick(), interactive ? 700 : 1500);
    };
    void tick();
    return () => {
      stop = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [runId, interactive]);

  if (closed) return null;
  const click = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!interactive || !onClickAt || !img.current) return;
    const rect = img.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * img.current.naturalWidth) / rect.width;
    const y = ((event.clientY - rect.top) * img.current.naturalHeight) / rect.height;
    onClickAt(x, y);
  };
  return (
    <figure className="space-y-1.5">
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-muted",
          interactive && "ring-2 ring-sky-500 ring-offset-2 ring-offset-background",
        )}
      >
        {src ? (
          // Forwarding a click at screen coordinates is inherently pointer-based. Keyboard operators use the
          // intervention panel's key and text input (or `rote operator`), which drive the same session.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
          <img
            ref={img}
            src={src}
            alt="Live view of the automated browser session"
            onClick={click}
            className={cn("w-full select-none", interactive && "cursor-crosshair")}
            draggable={false}
          />
        ) : (
          <div className="grid aspect-[16/10] place-items-center text-sm text-muted-foreground">Connecting to the session…</div>
        )}
      </div>
      <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {interactive ? (
          <>
            <MousePointerClick className="size-3.5" aria-hidden /> You are in control — click the screen to interact.
          </>
        ) : (
          <>
            <MonitorPlay className="size-3.5" aria-hidden /> Live session (sensitive fields masked for observers).
          </>
        )}
      </figcaption>
    </figure>
  );
}

import { useEffect, useState } from "react";

import { type RunEvent, runStreamUrl } from "@/lib/api";

interface StreamState {
  runId: string | undefined;
  events: RunEvent[];
  ended: boolean;
}

const EMPTY: RunEvent[] = [];

/** Follow a run's events over Server-Sent Events: buffered history first, then live. */
export function useRunStream(runId: string | undefined) {
  const [state, setState] = useState<StreamState>({ runId: undefined, events: EMPTY, ended: false });

  useEffect(() => {
    if (!runId) return;
    const seen = new Set<number>();
    const source = new EventSource(runStreamUrl(runId));
    let buffer: RunEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setState((prev) =>
        prev.runId === runId ? { ...prev, events: [...prev.events, ...batch] } : { runId, events: batch, ended: false },
      );
    };
    source.addEventListener("run", (message) => {
      const event = JSON.parse(message.data as string) as RunEvent;
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      buffer.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    source.addEventListener("end", () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      setState((prev) => ({ ...prev, ended: true }));
      source.close();
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      source.close();
    };
  }, [runId]);

  // State left over from a previous run id is never shown for the new one.
  return state.runId === runId ? { events: state.events, ended: state.ended } : { events: EMPTY, ended: false };
}

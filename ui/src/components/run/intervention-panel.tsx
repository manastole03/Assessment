import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CornerDownLeft, Hand, Keyboard, LogOut, MessageSquareWarning } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import { LeaseBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import { sendInput, type Lease } from "@/hooks/use-operator";
import { api, operatorUrl, type OperatorState } from "@/lib/api";
import { humanize } from "@/lib/format";

import { ScreenshotThumb } from "./screenshot";

const RESOLUTION_HELP: Record<string, string> = {
  retry_step: "Automation runs the stopped step again from the start.",
  step_completed: "You finished the step by hand. Automation re-checks its postconditions, then continues.",
  continue: "Give control back to the discovery agent; your actions are recorded as steps.",
  approve: "Allow the irreversible action to go ahead.",
  reject: "Refuse the irreversible action.",
  abort: "Stop the run. It fails with ESCALATION_ABORTED and your note.",
};

export function InterventionPanel({
  runId,
  state,
  lease,
  setLease,
  liveView,
}: {
  runId: string;
  state: OperatorState;
  lease: Lease | undefined;
  setLease: (lease: Lease | undefined) => void;
  /** Rendered beside the controls while you hold the lease, so screen and controls stay together. */
  liveView?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const mayAct = auth.can("OPERATOR");
  const [resolution, setResolution] = useState<string>("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const active = state.active;
  const mine =
    !!lease && state.control.state === "human" && state.control.holder === lease.operator && state.control.epoch === lease.epoch;

  // Drop a lease the server no longer honours (handed back elsewhere, expired, …). Compare epochs:
  // right after claiming, the cached state still predates our lease and must not cancel it.
  useEffect(() => {
    if (
      lease &&
      state.control.epoch >= lease.epoch &&
      !(state.control.state === "human" && state.control.holder === lease.operator)
    ) {
      setLease(undefined);
    }
  }, [lease, state.control.epoch, state.control.state, state.control.holder, setLease]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operator", runId] });

  const claim = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error("There is no open intervention to claim.");
      // The server takes the operator identity from the session; the lease is held in your name.
      return api<{ epoch: number; operator: string }>(operatorUrl(runId, `interventions/${active.id}/claim`), {
        method: "POST",
        json: {},
      });
    },
    onSuccess: (data) => {
      setLease({ operator: data.operator, epoch: data.epoch });
      toast.success("You have the live session", { description: "Automation is paused until you hand control back." });
      void refresh();
    },
    onError: (error) => toast.error("Could not take control", { description: String(error) }),
  });

  const input = useMutation({
    mutationFn: (command: Record<string, unknown>) => {
      if (!lease) throw new Error("Take control before sending input.");
      return sendInput(runId, lease, command);
    },
    onSuccess: refresh,
    onError: (error) => toast.error("Input rejected", { description: String(error) }),
  });

  const resolve = useMutation({
    mutationFn: () => {
      if (!active || !lease) throw new Error("You no longer hold this intervention.");
      return api(operatorUrl(runId, `interventions/${active.id}/resolve`), {
        method: "POST",
        json: { epoch: lease.epoch, resolution, note },
      });
    },
    onSuccess: () => {
      setLease(undefined);
      setResolution("");
      setNote("");
      toast.success("Control handed back to automation");
      void refresh();
    },
    onError: (error) => toast.error("Could not hand back", { description: String(error) }),
  });

  if (!active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <LeaseBadge state={state.control.state} holder={state.control.holder} epoch={state.control.epoch} />
        <span>If the run reaches a screen it doesn't recognise, it pauses here for a person.</span>
      </div>
    );
  }

  return (
    <Card className="border-amber-500/50 bg-amber-500/[0.04]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hand className="size-4 text-amber-600" aria-hidden />
          {active.reason_code === "APPROVAL_REQUIRED" ? "An operator must approve this step" : "A human is needed"}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-[11px]">
            {active.reason_code}
          </Badge>
          {active.step_id && (
            <span>
              at <code className="font-mono text-xs">{active.step_id}</code>
            </span>
          )}
        </CardDescription>
        <CardAction>
          <LeaseBadge state={state.control.state} holder={state.control.holder} epoch={state.control.epoch} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[1fr_220px]">
          <div className="space-y-2 text-sm">
            <p>{active.reason}</p>
            {active.step_intent && <p className="text-muted-foreground">Step: {active.step_intent}</p>}
            {active.observation && (
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronDown className="size-3.5" aria-hidden /> Screen text at escalation (redacted)
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
                    {active.observation}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
          <ScreenshotThumb
            src={operatorUrl(runId, `interventions/${active.id}/screenshot`)}
            label="Screen when the run escalated (masked)"
          />
        </div>

        {active.status === "open" &&
          (mayAct ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                You take the lease as <span className="font-medium text-foreground">{auth.user?.email}</span>; your actions are
                recorded in the audit trail.
              </p>
              <Button onClick={() => claim.mutate()} disabled={claim.isPending}>
                <Hand /> Take control
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              An operator needs to take over. Your role ({auth.role?.toLowerCase()}) can watch but not act.
            </p>
          ))}

        {active.status === "claimed" && !mine && (
          <p className="text-sm text-muted-foreground">Claimed by {active.claimed_by}. Only they can act on the session.</p>
        )}

        {mine && (
          <div className="space-y-4">
            <Separator />
            <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {liveView}
              <div className="space-y-4">
                {state.dialog && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 p-2 text-sm">
                    <MessageSquareWarning className="size-4 text-amber-600" aria-hidden />
                    <span className="flex-1">
                      Native {state.dialog.kind}: “{state.dialog.message}”
                    </span>
                    <Button size="sm" variant="outline" onClick={() => input.mutate({ kind: "dialog", accept: true })}>
                      Accept
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => input.mutate({ kind: "dialog", accept: false })}>
                      Dismiss
                    </Button>
                  </div>
                )}
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (text) input.mutate({ kind: "type", text });
                    setText("");
                  }}
                >
                  <Input
                    className="min-w-48 flex-1"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Type into the focused field"
                    aria-label="Text to type"
                  />
                  <Button type="submit" variant="outline" size="sm" disabled={!text}>
                    <Keyboard /> Type
                  </Button>
                  {["Tab", "Enter", "Escape"].map((key) => (
                    <Button
                      key={key}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => input.mutate({ kind: "press", key })}
                    >
                      {key === "Enter" && <CornerDownLeft />}
                      {key}
                    </Button>
                  ))}
                </form>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Your actions (recorded)</div>
                  {active.human_actions.length ? (
                    <ol className="list-decimal space-y-0.5 pl-5 text-sm">
                      {active.human_actions.map((a, i) => (
                        <li key={i}>{a.description}</li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">None yet — click on the live screen to act.</p>
                  )}
                </div>

                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    resolve.mutate();
                  }}
                >
                  <RadioGroup value={resolution} onValueChange={setResolution} className="gap-2">
                    {active.allowed_resolutions.map((r) => (
                      <Label
                        key={r}
                        htmlFor={`res-${r}`}
                        className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 font-normal has-[[data-state=checked]]:border-primary"
                      >
                        <RadioGroupItem id={`res-${r}`} value={r} className="mt-0.5" />
                        <span>
                          <span className="font-medium">{humanize(r)}</span>
                          <span className="block text-xs text-muted-foreground">{RESOLUTION_HELP[r]}</span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Note for the audit trail (what you did and why)"
                    rows={2}
                  />
                  <Button type="submit" disabled={!resolution || resolve.isPending}>
                    <LogOut /> Hand control back
                  </Button>
                </form>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

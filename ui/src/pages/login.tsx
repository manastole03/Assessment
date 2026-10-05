import { useQuery } from "@tanstack/react-query";
import { LogIn, UserPlus } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { Topo } from "@/components/art/topo";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-context";
import { safeNext } from "@/features/auth/next";
import { api, ApiError, type AuthOptions } from "@/lib/api";

const DEMO_ACCOUNTS = [
  ["admin@rote.local", "everything, including users and API keys"],
  ["reviewer@rote.local", "approve drafts, run discovery, probes and evals"],
  ["operator@rote.local", "run capabilities and take over handoffs"],
  ["viewer@rote.local", "read-only"],
] as const;

function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") return "Too many attempts. Wait a minute and try again.";
    return error.message;
  }
  return "Could not reach the server. Is the control plane running?";
}

export default function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const options = useQuery({ queryKey: ["auth-options"], queryFn: () => api<AuthOptions>("/auth/options"), staleTime: Infinity });
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (auth.status === "authenticated") return <Navigate to={next} replace />;

  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "login") await auth.login(email, password);
      else await auth.register(email, name, password);
      void navigate(next, { replace: true });
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };

  const registering = mode === "register";
  return (
    <div className="relative grid min-h-svh place-items-center overflow-hidden bg-background px-4 py-10">
      <Topo className="pointer-events-none absolute inset-0 opacity-40" />
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Brand />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{registering ? "Create an account" : "Sign in"}</CardTitle>
            <CardDescription>
              {registering
                ? "New accounts can read everything; an administrator grants more."
                : "Review capabilities, run them, and take over handoffs."}
            </CardDescription>
          </CardHeader>
          <form onSubmit={(e) => void submit(e)}>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {registering && (
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={registering ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={registering ? 12 : 1}
                  required
                />
                {registering && <p className="text-xs text-muted-foreground">At least 12 characters.</p>}
              </div>
            </CardContent>
            <CardFooter className="mt-4 flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={pending}>
                {registering ? <UserPlus /> : <LogIn />} {registering ? "Create account" : "Sign in"}
              </Button>
              {options.data?.signupEnabled && (
                <Button type="button" variant="link" size="sm" onClick={() => setMode(registering ? "login" : "register")}>
                  {registering ? "I already have an account" : "Create an account"}
                </Button>
              )}
            </CardFooter>
          </form>
        </Card>
        {options.data?.demoEnabled && !registering && (
          <div className="space-y-2 rounded-md border bg-card/80 p-3 text-xs text-muted-foreground backdrop-blur">
            <div className="label-caps">Demo accounts</div>
            <ul className="space-y-1">
              {DEMO_ACCOUNTS.map(([account, can]) => (
                <li key={account}>
                  <button type="button" className="font-mono text-foreground hover:underline" onClick={() => setEmail(account)}>
                    {account}
                  </button>{" "}
                  — {can}
                </li>
              ))}
            </ul>
            <p>
              Passwords are <code className="font-mono">SEED_ADMIN_PASSWORD</code> and{" "}
              <code className="font-mono">SEED_DEMO_PASSWORD</code> in your <code className="font-mono">.env</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

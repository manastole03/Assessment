import { Navigate, Outlet, useLocation } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";

import { useAuth } from "./auth-context";

/** Routes behind sign-in. Anonymous visitors go to /login and come back where they were going. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (status === "anonymous") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

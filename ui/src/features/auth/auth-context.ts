import { createContext, useContext } from "react";

import type { AuthSession, Identity, Role, User } from "@/lib/api";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthApi {
  status: AuthStatus;
  identity: Identity | null;
  user: User | null;
  /** The role this session acts with (an API key's cap never applies in the browser). */
  role: Role | undefined;
  /** True when the signed-in role is `required` or above. The server enforces this too. */
  can: (required: Role) => boolean;
  login: (email: string, password: string) => Promise<AuthSession>;
  register: (email: string, name: string, password: string) => Promise<AuthSession>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used inside <AuthProvider>");
  return auth;
}

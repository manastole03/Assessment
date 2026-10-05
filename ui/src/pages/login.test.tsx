import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { AuthContext } from "@/features/auth/auth-context";
import { safeNext } from "@/features/auth/next";
import { RequireAuth } from "@/features/auth/require-auth";
import { ApiError } from "@/lib/api";
import { fakeAuth, ok, pathOf } from "@/test/render";

import LoginPage from "./login";

function renderLogin(login = vi.fn(() => Promise.resolve({} as never)), route = "/login?next=%2Fruns") {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(pathOf(url) === "/api/v1/auth/options" ? ok({ signupEnabled: false, demoEnabled: true }) : ok(null)),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={{ ...fakeAuth(null), login }}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/runs" element={<p>runs page</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return login;
}

describe("LoginPage", () => {
  it("signs in and goes where the user was headed", async () => {
    const user = userEvent.setup();
    const login = renderLogin();
    await user.type(screen.getByLabelText("Email"), "dana@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery 9");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(login).toHaveBeenCalledWith("dana@example.com", "correct horse battery 9");
    expect(await screen.findByText("runs page")).toBeInTheDocument();
  });

  it("shows the server's reason when sign-in fails", async () => {
    const user = userEvent.setup();
    renderLogin(vi.fn(() => Promise.reject(new ApiError(401, "Invalid email or password", "INVALID_CREDENTIALS"))));
    await user.type(screen.getByLabelText("Email"), "dana@example.com");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
  });

  it("offers the demo accounts on demo deployments", async () => {
    renderLogin();
    expect(await screen.findByText("reviewer@rote.local")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create an account" })).not.toBeInTheDocument();
  });

  it("only returns to internal paths", () => {
    expect(safeNext("/runs/abc?x=1")).toBe("/runs/abc?x=1");
    expect(safeNext("https://evil.example")).toBe("/overview");
    expect(safeNext("//evil.example")).toBe("/overview");
    expect(safeNext(null)).toBe("/overview");
  });
});

describe("RequireAuth", () => {
  it("sends signed-out visitors to the login page, remembering where they were going", () => {
    render(
      <AuthContext.Provider value={fakeAuth(null)}>
        <MemoryRouter initialEntries={["/runs/abc"]}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="/runs/:id" element={<p>secret</p>} />
            </Route>
            <Route path="/login" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login?next=%2Fruns%2Fabc");
  });
});

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

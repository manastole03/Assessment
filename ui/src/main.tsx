import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import App from "@/App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/auth-provider";
import { TourProvider } from "@/features/tour/tour-provider";

import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing the #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="rote.theme" disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <MotionConfig reducedMotion="user">
            <BrowserRouter>
              <AuthProvider>
                <TourProvider>
                  <App />
                </TourProvider>
              </AuthProvider>
            </BrowserRouter>
          </MotionConfig>
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

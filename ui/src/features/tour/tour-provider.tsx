import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { TOUR_STEPS } from "./steps";
import { findTourTarget, readTourStatus, safeStorage, shouldOfferTour, waitForTourTarget, writeTourStatus } from "./state";
import { TourContext, type TourApi } from "./tour-context";
import { WelcomeDialog } from "./welcome-dialog";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A guided tour across the app's routes (driver.js for highlighting, React Router for navigation).
 * Steps on another route navigate first and wait for their target to render before highlighting.
 * First visits to the landing page are offered the tour once; finishing or dismissing it is remembered.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [active, setActive] = useState(false);
  const [offered, setOffered] = useState(() => shouldOfferTour(pathname, readTourStatus(safeStorage())));
  const tour = useRef<Driver | null>(null);
  const changingRoute = useRef(false);

  // Highlight step `index`, navigating to its route first if needed.
  const show = useCallback(
    async (index: number) => {
      const current = tour.current;
      if (!current || index < 0 || index >= TOUR_STEPS.length) return;
      const step = TOUR_STEPS[index];
      if (window.location.pathname !== step.route) {
        // Take the popover down while the next page renders, so it never points at the old one.
        changingRoute.current = true;
        current.destroy();
        changingRoute.current = false;
        await navigate(step.route);
      }
      await waitForTourTarget(step.target, 2500);
      if (tour.current === current) current.drive(index);
    },
    [navigate],
  );

  const start = useCallback(() => {
    setOffered(false);
    tour.current?.destroy();
    const reduced = prefersReducedMotion();
    const instance = driver({
      steps: TOUR_STEPS.map(({ target, ...step }) => ({
        // Resolved lazily, after navigation. driver.js centres the popover when this yields null
        // (its typings say Element, its runtime accepts null), e.g. the sidebar on a phone.
        element: target ? ((() => findTourTarget(target)) as () => Element) : undefined,
        popover: { title: step.title, description: step.description, side: step.side, align: "start" },
      })),
      animate: !reduced,
      smoothScroll: !reduced,
      allowKeyboardControl: true,
      disableActiveInteraction: true,
      showProgress: true,
      progressText: "{{current}} of {{total}}",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Finish",
      popoverClass: "rote-tour",
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 10,
      onNextClick: () => {
        const index = instance.getActiveIndex() ?? 0;
        if (instance.isLastStep()) instance.destroy();
        else void show(index + 1);
      },
      onPrevClick: () => void show(Math.max(0, (instance.getActiveIndex() ?? 0) - 1)),
      onDestroyed: () => {
        if (changingRoute.current) return;
        writeTourStatus(safeStorage(), "completed");
        if (tour.current === instance) tour.current = null;
        setActive(false);
      },
    });
    tour.current = instance;
    setActive(true);
    void show(0);
  }, [show]);

  const dismiss = useCallback(() => {
    setOffered(false);
    writeTourStatus(safeStorage(), "dismissed");
  }, []);

  useEffect(() => () => tour.current?.destroy(), []);

  const api = useMemo<TourApi>(() => ({ start, active }), [start, active]);
  return (
    <TourContext value={api}>
      {children}
      <WelcomeDialog open={offered} onStart={start} onDismiss={dismiss} />
    </TourContext>
  );
}

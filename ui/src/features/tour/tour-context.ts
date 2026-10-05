import { createContext, useContext } from "react";

export interface TourApi {
  /** Start (or restart) the guided tour from the first step. */
  start: () => void;
  active: boolean;
}

export const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi {
  const tour = useContext(TourContext);
  if (!tour) throw new Error("useTour must be used inside <TourProvider>");
  return tour;
}

import { useEffect, useState } from "react";

function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

// The calendar and the summary are both anchored to "today". A window left open
// across midnight has to slide forward on its own, otherwise the 30-day average
// keeps counting the day that just aged out and never picks up the new one.
export function useToday(): Date {
  const [today, setToday] = useState<Date>(startOfToday);

  useEffect(() => {
    const tick = () => {
      const next = startOfToday();
      setToday((previous) => (previous.getTime() === next.getTime() ? previous : next));
    };
    const timer = window.setInterval(tick, 60_000);
    const handleVisibility = () => {
      if (!document.hidden) {
        tick();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return today;
}

"use client";

// Test-only screen for the app error screen (tests/e2e/analytics-home.spec.ts). The
// `.e2e.tsx` name keeps it out of production builds (next.config.ts), so production has no
// such route. It fails while the test sets `window.e2eCrash`, with a new error each time
// or, for "same", one error thrown again.
const SAME = new Error("e2e crash");

export default function CrashPage() {
  // The server render has no window; the browser render decides.
  if (typeof window === "undefined") return null;
  const crash = (window as unknown as { e2eCrash?: boolean | "same" }).e2eCrash;
  if (crash === "same") throw SAME;
  if (crash) throw new Error("e2e crash");
  return <main id="main">recovered</main>;
}

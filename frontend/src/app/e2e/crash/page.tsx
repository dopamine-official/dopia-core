"use client";
import { notFound } from "next/navigation";

// Test-only screen for the app error screen (tests/e2e/analytics-home.spec.ts): it fails
// while the test sets `window.e2eCrash`, with a new error each time or, for "same", one
// error thrown again. Production builds answer 404.
const SAME = new Error("e2e crash");

export default function CrashPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // The server render has no window; the browser render decides.
  if (typeof window === "undefined") return null;
  const crash = (window as unknown as { e2eCrash?: boolean | "same" }).e2eCrash;
  if (crash === "same") throw SAME;
  if (crash) throw new Error("e2e crash");
  return <main id="main">recovered</main>;
}

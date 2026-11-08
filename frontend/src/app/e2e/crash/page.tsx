"use client";
import { notFound } from "next/navigation";

// Test-only screen for the app error screen (tests/e2e/analytics-home.spec.ts): it fails
// while the test sets `window.e2eCrash`. Production builds answer 404.
export default function CrashPage() {
  if (process.env.NODE_ENV === "production") notFound();
  if ((window as unknown as { e2eCrash?: boolean }).e2eCrash)
    throw new Error("e2e crash");
  return <main id="main">recovered</main>;
}

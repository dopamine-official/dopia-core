"use client";
import { useEffect } from "react";
import { useSession } from "@/components/providers";
import { errorCode, track } from "@/lib/analytics";

// Kept outside the component: a retry that fails again shows this screen anew, and its
// result is only known once that happens or the screen goes away.
let retrying = false;
let mounted = 0;
const shown = new WeakSet<object>();

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const { t } = useSession();
  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      // React's dev double mount puts the screen straight back; a real recovery does not.
      setTimeout(() => {
        if (mounted > 0 || !retrying) return;
        retrying = false;
        track("retry_finished", "error", { target: "app", result: "loaded" });
      }, 0);
    };
  }, []);
  useEffect(() => {
    // Once per error shown, as the session failure screen does (TRACKING-PLAN 7-3).
    if (shown.has(error)) return;
    shown.add(error);
    if (retrying) {
      retrying = false;
      track("retry_finished", "error", { target: "app", result: "failed" });
    }
    track("error_screen_viewed", "error", {
      target: "app",
      code: errorCode(error),
    });
  }, [error]);
  return (
    <main id="main" className="bootstrap_state">
      <p role="alert">{t("common.action_failed")}</p>
      <button
        className="button"
        onClick={() => {
          // A click while the retry is still running would count one retry twice.
          if (retrying) return;
          retrying = true;
          track("retry_clicked", "error", { target: "app" });
          reset();
        }}
      >
        {t("common.retry")}
      </button>
    </main>
  );
}

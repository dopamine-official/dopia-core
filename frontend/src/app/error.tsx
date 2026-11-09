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
  // No dependency list: a retry that fails puts this screen back even when the same error
  // is thrown again, and that commit is the only sign of it.
  useEffect(() => {
    if (retrying) {
      retrying = false;
      track("retry_finished", "error", { target: "app", result: "failed" });
    } else if (shown.has(error)) {
      return;
    }
    // Once per notice shown, as the session failure screen does (TRACKING-PLAN 7-3).
    shown.add(error);
    track("error_screen_viewed", "error", {
      target: "app",
      code: errorCode(error),
    });
  });
  return (
    <main id="main" className="bootstrap_state">
      <p role="alert">{t("common.action_failed")}</p>
      <button
        className="button"
        onClick={() => {
          // The retry always runs; only a click before the last one settles goes unrecorded.
          if (!retrying) {
            retrying = true;
            track("retry_clicked", "error", { target: "app" });
          }
          reset();
        }}
      >
        {t("common.retry")}
      </button>
    </main>
  );
}

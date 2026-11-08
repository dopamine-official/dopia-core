"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { useSession } from "@/components/providers";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useSession();

  useEffect(() => {
    posthog.captureException(error);
  }, [error]);
  return (
    <main id="main" className="bootstrap_state">
      <p role="alert">{t("common.action_failed")}</p>
      <button className="button" onClick={reset}>
        {t("common.retry")}
      </button>
    </main>
  );
}

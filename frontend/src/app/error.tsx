"use client";
import { useSession } from "@/components/providers";
export default function ErrorPage({ reset }: { reset: () => void }) {
  const { t } = useSession();
  return (
    <main id="main" className="bootstrap_state">
      <p role="alert">{t("common.action_failed")}</p>
      <button className="button" onClick={reset}>
        {t("common.retry")}
      </button>
    </main>
  );
}

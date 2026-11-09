"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSession } from "@/components/providers";
import { Screen, useTrack } from "@/components/page";
import { SiteHeader } from "@/components/ui";
export default function NotFound() {
  return (
    <Screen page="not_found">
      <NotFoundScreen />
    </Screen>
  );
}
function NotFoundScreen() {
  const { t } = useSession();
  const send = useTrack();
  const viewed = useRef(false);
  useEffect(() => {
    // Once per showing; React's dev double mount must not count it twice (TRACKING-PLAN 7-1).
    if (viewed.current) return;
    viewed.current = true;
    send("not_found_viewed");
  }, [send]);
  return (
    <>
      <SiteHeader />
      <main id="main" className="bootstrap_state">
        <h1>404</h1>
        <p>{t("chat.not_found")}</p>
        <Link
          className="button primary"
          href="/"
          onClick={() => send("home_button_clicked")}
        >
          {t("common.back_home")}
        </Link>
      </main>
    </>
  );
}

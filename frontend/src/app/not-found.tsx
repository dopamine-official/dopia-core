"use client";
import Link from "next/link";
import { useSession } from "@/components/providers";
import { Screen } from "@/components/page";
import { SiteHeader } from "@/components/ui";
export default function NotFound() {
  const { t } = useSession();
  return (
    <Screen page="not_found">
      <SiteHeader />
      <main id="main" className="bootstrap_state">
        <h1>404</h1>
        <p>{t("chat.not_found")}</p>
        <Link className="button primary" href="/">
          {t("common.back_home")}
        </Link>
      </main>
    </Screen>
  );
}

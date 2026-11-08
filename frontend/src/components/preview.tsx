"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { errorMessageKey } from "@/lib/errors";
import {
  accountSchema,
  eventsSchema,
  scenarioSchema,
  type Scenario,
} from "@/lib/contracts";
import { useSession } from "./providers";
import { ErrorState, Footer, Loading, Modal, SiteHeader } from "./ui";
export function Preview() {
  const { t, locale, account, changeAccount, notice } = useSession();
  const query = useQueryClient();
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const scenario = useQuery({
    queryKey: ["scenario", account.account_id],
    queryFn: ({ signal }) => api("/mock/scenario", scenarioSchema, { signal }),
    staleTime: 0,
  });
  const events = useQuery({
    queryKey: ["events", account.account_id],
    queryFn: ({ signal }) => api("/mock/events", eventsSchema, { signal }),
    staleTime: 0,
  });
  async function update(next: Scenario) {
    setBusy(true);
    try {
      query.setQueryData(
        ["scenario", account.account_id],
        await api("/mock/scenario", scenarioSchema, {
          method: "PUT",
          body: JSON.stringify(next),
        }),
      );
      await query.invalidateQueries({ queryKey: ["home"] });
      notice(t("preview.saved"));
    } catch (error) {
      notice(t(errorMessageKey(error)));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    try {
      const next = await api("/mock/reset", accountSchema, { method: "POST" });
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("dopia:")) sessionStorage.removeItem(key);
      changeAccount(next, "/");
      notice(t("preview.reset_done"));
    } catch (error) {
      notice(t(errorMessageKey(error)));
      setBusy(false);
    }
  }
  return (
    <>
      <SiteHeader />
      <main id="main" className="account_main preview_main">
        <span className="pill">{t("common.preview")}</span>
        <h1>{t("preview.title")}</h1>
        <p className="muted">{t("preview.description")}</p>
        <section className="box">
          <h2>{t("preview.state")}</h2>
          <p className="muted">
            {t("preview.region")} ·{" "}
            {t(account.is_guest ? "preview.guest" : "preview.member")}
          </p>
        </section>
        <section className="box">
          {scenario.isPending ? (
            <Loading />
          ) : scenario.isError ? (
            <ErrorState error={scenario.error} retry={() => void scenario.refetch()} />
          ) : (
            <>
              <label className="field">
                {t("preview.response")}
                <select
                  value={scenario.data.response}
                  disabled={busy}
                  onChange={(e) =>
                    void update({
                      ...scenario.data,
                      response: e.target.value as Scenario["response"],
                    })
                  }
                >
                  {(["normal", "slow", "fail", "disconnect"] as const).map(
                    (value) => (
                      <option key={value} value={value}>
                        {t(`preview.${value}`)}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p className="field_help">{t("preview.response_help")}</p>
              <label className="field">
                {t("preview.home")}
                <select
                  value={scenario.data.home}
                  disabled={busy}
                  onChange={(e) =>
                    void update({
                      ...scenario.data,
                      home: e.target.value as Scenario["home"],
                    })
                  }
                >
                  {(["normal", "empty", "error"] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`preview.home_${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </section>
        <section className="box">
          <h2>{t("preview.events")}</h2>
          <p className="muted">{t("preview.events_help")}</p>
          {events.isError ? (
            <ErrorState error={events.error} retry={() => void events.refetch()} />
          ) : events.isPending ? (
            <Loading />
          ) : events.data.length ? (
            <ol className="event_list">
              {events.data.slice(0, 12).map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <code>{event.name}</code>
                  <time dateTime={event.at}>
                    {new Intl.DateTimeFormat(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    }).format(new Date(event.at))}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">{t("preview.events_empty")}</p>
          )}
        </section>
        <button className="button danger" onClick={() => setReset(true)}>
          {t("preview.reset")}
        </button>
        <Footer />
      </main>
      {reset && (
        <Modal title={t("preview.reset_title")} onClose={() => setReset(false)}>
          <p className="muted">{t("preview.reset_body")}</p>
          <div className="modal_actions">
            <button className="button" onClick={() => setReset(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void clear()}
            >
              {t("preview.reset")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

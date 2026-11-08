"use client";
import { createContext, useCallback, useContext, useRef } from "react";
import { track, type EventProperties, type Page } from "@/lib/analytics";

// The screen a shared part (header, sidebar, footer, modals) sits on, for the `page`
// property. Each screen sets it once; parts outside any screen record nothing.
export const PageContext = createContext<Page | null>(null);

/** `track` bound to the current screen. */
export function useTrack() {
  const page = useContext(PageContext);
  return useCallback(
    (event: string, properties?: EventProperties) => {
      if (page) track(event, page, properties);
    },
    [page],
  );
}

export type RetryTarget = "home_list" | "recent_chats";

/**
 * Wraps a failure notice's retry: records the click and, once the new read settles, whether
 * it loaded. A click while the retry is still running is ignored so one retry counts once.
 */
export function useRetry(
  target: RetryTarget,
  refetch: () => Promise<{ isError: boolean }>,
) {
  const send = useTrack();
  const running = useRef(false);
  return () => {
    if (running.current) return;
    running.current = true;
    send("retry_clicked", { target });
    void refetch()
      .then((result) =>
        send("retry_finished", {
          target,
          result: result.isError ? "failed" : "loaded",
        }),
      )
      .finally(() => {
        running.current = false;
      });
  };
}

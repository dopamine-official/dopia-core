"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { track, type EventProperties, type Page } from "@/lib/analytics";

// The screen a shared part (header, sidebar, footer, modals) sits on, for the `page`
// property. Each screen sets it once; parts outside any screen record nothing.
type ScreenValue = { page: Page; once: Set<string> };
const ScreenContext = createContext<ScreenValue | null>(null);

export function Screen({
  page,
  children,
}: {
  page: Page;
  children: ReactNode;
}) {
  // Lives as long as this showing of the screen, shared by every part on it.
  const [once] = useState(() => new Set<string>());
  const value = useMemo(() => ({ page, once }), [page, once]);
  return <ScreenContext value={value}>{children}</ScreenContext>;
}

/**
 * Marks for events sent once per showing of the current screen, shared by its parts: the
 * sidebar list and the drawer list on one screen count as one. Null outside any screen.
 */
export function useScreenOnce() {
  return useContext(ScreenContext)?.once ?? null;
}

/** `track` bound to the current screen. */
export function useTrack() {
  const page = useContext(ScreenContext)?.page;
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

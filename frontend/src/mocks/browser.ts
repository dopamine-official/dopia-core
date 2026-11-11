import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
export const worker = setupWorker(...handlers);
let start: Promise<unknown> | undefined;
let restart: Promise<unknown> | undefined;
export function startMockApi() {
  start ??= worker
    .start({
      quiet: true,
      onUnhandledRequest(request, print) {
        if (new URL(request.url).pathname.startsWith("/api/")) print.error();
      },
    })
    .catch((error) => {
      start = undefined;
      throw error;
    });
  return start;
}
// Chrome stops an idle service worker, and the restarted worker forgets which tabs it
// mocks, so requests fall through to the Next route. Re-activating this tab fixes it.
export function restartMockApi() {
  restart ??= (async () => {
    await start?.catch(() => undefined);
    worker.stop();
    start = undefined;
    await startMockApi();
  })().finally(() => {
    restart = undefined;
  });
  return restart;
}

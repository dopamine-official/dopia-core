import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
export const worker = setupWorker(...handlers);
let start: Promise<unknown> | undefined;
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

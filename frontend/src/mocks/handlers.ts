import { http, HttpResponse, delay, type PathParams } from "msw";
import { z } from "zod";
import { ApiError, scenarioSchema, sendSchema } from "@/lib/contracts";
import { resolveLocale } from "@/i18n";
import * as engine from "./engine";
import { withState } from "./storage";

const json = (value: unknown) =>
  new HttpResponse(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
function guarded(
  fn: (request: Request, params: PathParams) => Promise<Response>,
) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params: PathParams;
  }) => {
    try {
      await delay(120);
      return await fn(request, params);
    } catch (error) {
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof z.ZodError
            ? 422
            : 500;
      const code =
        error instanceof ApiError
          ? error.code
          : status === 422
            ? "invalid_input"
            : "storage_unavailable";
      const detail =
        error instanceof z.ZodError
          ? error.issues.map((issue) => ({
              field: issue.path.join("."),
              reason: issue.code,
            }))
          : error instanceof ApiError && Array.isArray(error.detail)
            ? error.detail
            : [];
      return HttpResponse.json({ code, message: code, detail }, { status });
    }
  };
}
function auth(state: engine.State, request: Request) {
  const user = engine.account(state);
  const expected = request.headers.get("X-Preview-Account");
  if (expected && expected !== user.account_id)
    throw new ApiError("account_changed", 401);
  return user;
}
function run<T>(request: Request, operation: (state: engine.State) => T) {
  return withState((state) => {
    auth(state, request);
    return operation(state);
  });
}
function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function turnStream(turn: engine.Turn, roomId: string) {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      const emit = (name: string, data: unknown) => {
        if (!cancelled)
          controller.enqueue(
            encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
          );
      };
      const finish = () => {
        if (!cancelled) {
          controller.close();
          cancelled = true;
        }
      };
      try {
        emit("accepted", { user_message_id: turn.user_message_id });
        let position = 0;
        while (
          !cancelled &&
          turn.status === "generating" &&
          Date.now() < turn.finishes_at
        ) {
          await new Promise((resolve) => setTimeout(resolve, 65));
          const progress = Math.max(
            0,
            Math.min(
              1,
              (Date.now() - turn.started_at - 300) /
                (turn.finishes_at - turn.started_at - 300),
            ),
          );
          const next = Math.floor(turn.response.length * progress);
          if (next > position && turn.behavior !== "fail") {
            emit("token", { text: turn.response.slice(position, next) });
            position = next;
          }
          if (turn.behavior === "disconnect" && progress > 0.25) {
            finish();
            return;
          }
        }
        if (cancelled) return;
        const saved = await withState((state) =>
          state.rooms
            .find((room) => room.room_id === roomId)
            ?.turns.find(
              (value) => value.client_message_id === turn.client_message_id,
            ),
        );
        if (saved?.status === "completed")
          emit("completed", {
            assistant_message_id: saved.assistant_message_id,
            content: saved.response,
          });
        else
          emit("failed", {
            code: "mock_response_failed",
            message: "Prepared failure scenario",
          });
        finish();
      } catch {
        if (!cancelled) {
          emit("failed", {
            code: "storage_unavailable",
            message: "Local storage unavailable",
          });
          finish();
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
export const handlers = [
  http.post(
    "/api/v1/account/guest",
    guarded(async () => {
      const user = await withState(engine.guest);
      return json({ account_id: user.account_id });
    }),
  ),
  http.get(
    "/api/v1/account/me",
    guarded(async (req) => json(await run(req, engine.account))),
  ),
  http.post(
    "/api/v1/mock/login",
    guarded(async (req) => {
      const { provider } = z
        .object({ provider: z.enum(["google"]) })
        .parse(await req.json());
      return json(await run(req, (state) => engine.login(state, provider)));
    }),
  ),
  http.post(
    "/api/v1/account/logout",
    guarded(async (req) => {
      const user = await run(req, (state) => engine.logout(state));
      return json({ account_id: user.account_id });
    }),
  ),
  http.post(
    "/api/v1/account/withdraw",
    guarded(async (req) => {
      const user = await run(req, (state) => engine.logout(state, true));
      return json({ account_id: user.account_id });
    }),
  ),
  http.post(
    "/api/v1/account/me/adult_verification",
    guarded(async (req) => {
      const body = z
        .object({ gender: z.string(), birth_date: z.string() })
        .parse(await req.json());
      return json(
        await run(req, (state) =>
          engine.verifyAdult(state, body.gender, body.birth_date),
        ),
      );
    }),
  ),
  http.post(
    "/api/v1/account/me/consents",
    guarded(async (req) => {
      const { items } = z
        .object({
          items: z.array(z.object({ id: z.string(), version: z.string() })),
        })
        .parse(await req.json());
      return json(
        await run(req, (state) => engine.recordConsents(state, items)),
      );
    }),
  ),
  http.patch(
    "/api/v1/account/me/adult_mode",
    guarded(async (req) => {
      const { adult_mode } = z
        .object({ adult_mode: z.boolean() })
        .parse(await req.json());
      return json(
        await run(req, (state) => engine.updateAdultMode(state, adult_mode)),
      );
    }),
  ),
  http.patch(
    "/api/v1/account/me",
    guarded(async (req) => {
      // A save with no fields sends an empty multipart body, which does not parse.
      const form = await req.formData().catch(() => new FormData());
      const nickname = form.get("nickname");
      const photo = form.get("photo");
      let photo_url: string | undefined;
      if (photo instanceof File) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(photo.type))
          throw new ApiError("photo_type_invalid", 422);
        if (photo.size > 2 * 1024 * 1024)
          throw new ApiError("file_too_large", 413);
        photo_url = await toDataUrl(photo);
      }
      return json(
        await run(req, (state) =>
          engine.updateProfile(state, {
            ...(typeof nickname === "string" ? { nickname } : {}),
            ...(photo_url ? { photo_url } : {}),
          }),
        ),
      );
    }),
  ),
  http.get(
    "/api/v1/home",
    guarded(async (req) => {
      const fail = await run(req, (state) => {
        if (state.scenario.home === "error") {
          state.scenario.home = "normal";
          return true;
        }
        return false;
      });
      if (fail) throw new ApiError("mock_home_failed", 503);
      return json(
        await run(req, (state) =>
          engine.home(state, resolveLocale(req.headers.get("X-Locale"))),
        ),
      );
    }),
  ),
  http.post(
    "/api/v1/chats/open",
    guarded(async (req) => {
      const { character_id } = z
        .object({ character_id: z.uuid() })
        .parse(await req.json());
      return json(
        await run(req, (state) =>
          engine.openRoom(
            state,
            character_id,
            resolveLocale(req.headers.get("X-Locale")),
          ),
        ),
      );
    }),
  ),
  http.get(
    "/api/v1/chats/recent",
    guarded(async (req) =>
      json(
        await run(req, (state) =>
          engine.recent(state, resolveLocale(req.headers.get("X-Locale"))),
        ),
      ),
    ),
  ),
  http.get(
    "/api/v1/chats/:room_id",
    guarded(async (req, params) =>
      json(
        await run(req, (state) =>
          engine.roomView(
            state,
            String(params.room_id),
            resolveLocale(req.headers.get("X-Locale")),
          ),
        ),
      ),
    ),
  ),
  http.delete(
    "/api/v1/chats/:room_id",
    guarded(async (req, params) => {
      await run(req, (state) => {
        engine.ownedRoom(state, String(params.room_id)).deleted = true;
        engine.event(state, "chat_deleted", {
          room_id: String(params.room_id),
        });
      });
      return new HttpResponse(null, { status: 204 });
    }),
  ),
  http.post(
    "/api/v1/chats/:room_id/messages",
    guarded(async (req, params) => {
      const input = sendSchema.parse(await req.json());
      const roomId = String(params.room_id);
      const turn = await run(req, (state) =>
        engine.startTurn(
          state,
          roomId,
          input,
          resolveLocale(req.headers.get("X-Locale")),
        ),
      );
      return new HttpResponse(turnStream(turn, roomId), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      });
    }),
  ),
  http.get(
    "/api/v1/mock/scenario",
    guarded(async (req) => json(await run(req, (state) => state.scenario))),
  ),
  http.put(
    "/api/v1/mock/scenario",
    guarded(async (req) => {
      const next = scenarioSchema.parse(await req.json());
      return json(
        await run(req, (state) => {
          state.scenario = next;
          return next;
        }),
      );
    }),
  ),
  http.get(
    "/api/v1/mock/events",
    guarded(async (req) =>
      json(
        await run(req, (state) =>
          state.events
            .filter((item) => item.account_id === state.active_account_id)
            .slice()
            .reverse(),
        ),
      ),
    ),
  ),
  http.post(
    "/api/v1/mock/reset",
    guarded(async () =>
      json(
        await withState((state) => {
          Object.assign(state, engine.initialState());
          return engine.guest(state);
        }),
      ),
    ),
  ),
];

"use client";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, request } from "@/lib/api";
import {
  ApiError,
  characterDetailSchema,
  characterImageSchema,
  type CharacterDetail,
  type CharacterImage,
} from "@/lib/contracts";
import { errorCode } from "@/lib/analytics";
import { regionConfig } from "@/i18n";
import { useCreatorOnly, useSession } from "./providers";
import { Screen, useTrack } from "./page";
import { ErrorState, Icon, Loading, Modal } from "./ui";

// The text fields a creator writes: name, length limit and the step it is on (CHARACTER web 2-2-5).
const TEXTS = [
  ["name", 30, "info"],
  ["tagline", 35, "info"],
  ["character_name", 30, "info"],
  ["personality", 2000, "prompt"],
  ["speech_style", 2000, "prompt"],
  ["world_setting", 6000, "prompt"],
  ["status_window_format", 500, "prompt"],
  ["status_window_initial", 500, "prompt"],
  ["status_window_rules", 1000, "prompt"],
  ["first_message", 3000, "start"],
] as const;
type TextKey = (typeof TEXTS)[number][0];
const STEPS = ["info", "prompt", "start", "media", "register"] as const;
type Step = (typeof STEPS)[number];
type Tab = "main" | "status_window";
type Values = Record<TextKey, string> & {
  gender: "" | "female" | "male";
  age: string;
  status_window_enabled: boolean;
  is_adult: boolean;
};
type FieldKey = TextKey | "thumbnail" | "gender" | "age" | "is_adult";

const ADULT_MIN_AGE = 20;
const MAX_IMAGES = 100;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const LIMITS = Object.fromEntries(
  TEXTS.map(([key, limit]) => [key, limit]),
) as Record<TextKey, number>;

/** Length as the creator sees it: trimmed, in code points, so an emoji counts once. */
const length = (value: string) => Array.from(value.trim()).length;
/** Keeps a text within its limit; what is over the limit is not taken. */
function clip(value: string, limit: number) {
  return length(value) <= limit
    ? value
    : Array.from(value).slice(0, limit).join("");
}
function toValues(detail: CharacterDetail | null): Values {
  const texts = Object.fromEntries(
    TEXTS.map(([key]) => [key, detail?.[key] ?? ""]),
  ) as Record<TextKey, string>;
  return {
    ...texts,
    gender: detail?.gender ?? "",
    age: detail?.age == null ? "" : String(detail.age),
    status_window_enabled: detail?.status_window_enabled ?? false,
    is_adult: detail?.is_adult ?? false,
  };
}
function stepOf(field: FieldKey): Step {
  if (field === "is_adult") return "register";
  if (field === "thumbnail" || field === "gender" || field === "age")
    return "info";
  return TEXTS.find(([key]) => key === field)![2];
}
/** `*action*` in a message shows as emphasis, like the chat room. */
function rich(text: string): ReactNode {
  return text
    .split(/\*([^*\n]+)\*/g)
    .map((part, index) =>
      index % 2 ? (
        <em key={index}>{part}</em>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    );
}
function fieldErrors(error: unknown): { field: string; reason: string }[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.detail)) return [];
  return error.detail.filter(
    (item): item is { field: string; reason: string } =>
      typeof item?.field === "string" && typeof item?.reason === "string",
  );
}

export function CharacterEditor({ characterId }: { characterId?: string }) {
  return (
    <Screen page="character_create">
      <Gate characterId={characterId} />
    </Screen>
  );
}
function Gate({ characterId }: { characterId?: string }) {
  const allowed = useCreatorOnly(
    characterId ? `/characters/${characterId}/edit` : "/characters/new",
  );
  if (!allowed) return null;
  return characterId ? <Existing id={characterId} /> : <Form initial={null} />;
}
/** The edit route: loads the creator's own character first (CHARACTER web 3-2-6). */
function Existing({ id }: { id: string }) {
  const { account, t, notice } = useSession();
  const router = useRouter();
  const result = useQuery({
    queryKey: ["character", account.account_id, id],
    queryFn: ({ signal }) =>
      api(`/characters/${id}`, characterDetailSchema, { signal }),
    // Every entry asks again and never shows an older answer first (4-3-1).
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const error = result.error;
  const gone =
    error instanceof ApiError && (error.status === 403 || error.status === 404);
  useEffect(() => {
    if (!gone) return;
    notice(
      t(
        error.status === 403
          ? "character.create.not_owner"
          : "character.not_found",
      ),
    );
    router.replace("/characters/mine");
  }, [gone, error, notice, router, t]);
  if (result.isPending || gone)
    return (
      <main id="main" className="ce_state">
        <Loading />
      </main>
    );
  if (result.isError)
    return (
      <main id="main" className="ce_state">
        <ErrorState
          message={t("character.create.load_failed")}
          retry={() => void result.refetch()}
        />
      </main>
    );
  return <Form key={result.dataUpdatedAt} initial={result.data} />;
}

type Line = { text: string; error: boolean };
type Thumbnail = { file: File; url: string };

function Form({ initial }: { initial: CharacterDetail | null }) {
  const { t, account, locale, notice } = useSession();
  const send = useTrack();
  const router = useRouter();
  const query = useQueryClient();
  // The last answer of the server; null until a new character is saved once.
  const [saved, setSaved] = useState(initial);
  const savedRef = useRef(initial);
  const [values, setValues] = useState(() => toValues(initial));
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  const [images, setImages] = useState<CharacterImage[]>(initial?.images ?? []);
  const imagesRef = useRef(images);
  const [drafts, setDrafts] = useState<
    Record<string, { name: string; description: string }>
  >({});
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [step, setStep] = useState<Step>("info");
  const [tab, setTab] = useState<Tab>("main");
  const [view, setView] = useState<"list" | "grid">("list");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [line, setLine] = useState<Line>({ text: "", error: false });
  const [focus, setFocus] = useState<FieldKey | "media" | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const queue = useRef<File[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const alive = useRef(true);
  const mainRef = useRef<HTMLElement>(null);
  const thumbnailInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);

  const status = saved?.status ?? "draft";
  const canSaveDraft = status === "draft" || status === "rejected";
  const mediaLocked = status === "pending" || status === "approved";
  const adultAvailable =
    regionConfig().content.adult_mode_available && account.adult_verified;
  const age = values.age === "" ? null : Number(values.age);
  const adultLocked = age === null || age < ADULT_MIN_AGE;
  const isAdult = adultAvailable && !adultLocked && values.is_adult;
  const base = toValues(saved);
  const changedTexts = TEXTS.filter(
    ([key]) => values[key].trim() !== base[key],
  ).map(([key]) => key);
  // Picture names and descriptions are saved with the character, not on their own.
  const imagesDirty = images.some((image) => {
    const draft = drafts[image.id];
    return (
      !!draft &&
      (draft.name.trim() !== image.name ||
        draft.description.trim() !== image.description)
    );
  });
  const dirty =
    !!thumbnail ||
    imagesDirty ||
    changedTexts.length > 0 ||
    values.gender !== base.gender ||
    values.age !== base.age ||
    values.status_window_enabled !== base.status_window_enabled ||
    isAdult !== base.is_adult;
  const imageUrl = thumbnail?.url ?? saved?.image_url ?? null;
  const say = (text: string, error = false) => setLine({ text, error });
  const savedAt = () =>
    say(
      t("character.create.saved_at", {
        time: new Date().toLocaleTimeString(locale),
      }),
    );

  function putImages(next: CharacterImage[]) {
    imagesRef.current = next;
    setImages(next);
  }
  function putSaved(next: CharacterDetail) {
    savedRef.current = next;
    setSaved(next);
    putImages(next.images);
  }

  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    send("character_create_viewed", {
      mode: initial ? "edit" : "new",
      status: initial?.status ?? "draft",
      has_revision: !!initial?.revision_status,
    });
  }, [send, initial]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The picture preview is this page's own object; let it go with the page or the next pick.
  useEffect(
    () => () => {
      if (thumbnail) URL.revokeObjectURL(thumbnail.url);
    },
    [thumbnail],
  );
  // Closing the tab or reloading with unsaved changes asks first (2-2-5).
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);
  useEffect(() => {
    if (!zoom) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoom(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [zoom]);
  // After a step or tab change the field to fix gets the focus.
  useEffect(() => {
    if (!focus) return;
    const target =
      focus === "media"
        ? (document.querySelector<HTMLElement>(".ce_item.bad input") ??
          document.getElementById("ce_media_add"))
        : document.getElementById(`ce_${focus}`);
    target?.focus();
    target?.scrollIntoView({ block: "center" });
    setFocus(null);
  }, [focus, step, tab]);

  function go(next: Step) {
    setStep(next);
    mainRef.current?.scrollTo({ top: 0 });
    send("character_create_step_viewed", { step: next });
  }
  function jump(field: FieldKey | "media") {
    const where = field === "media" ? "media" : stepOf(field);
    if (where !== step) go(where);
    if (where === "prompt")
      setTab(field.startsWith("status_window") ? "status_window" : "main");
    setFocus(field);
  }
  function clearError(field: FieldKey) {
    if (errors[field])
      setErrors((current) => ({ ...current, [field]: undefined }));
  }
  function setText(key: TextKey, value: string) {
    setValues((current) => ({ ...current, [key]: clip(value, LIMITS[key]) }));
    clearError(key);
  }
  function chooseThumbnail(file: File | undefined) {
    // Nothing changes while a save is on its way: its answer replaces what is shown.
    if (!file || busyRef.current) return;
    if (!IMAGE_TYPES.includes(file.type))
      return setErrors((current) => ({
        ...current,
        thumbnail: "invalid_image",
      }));
    if (file.size > MAX_BYTES)
      return setErrors((current) => ({ ...current, thumbnail: "too_large" }));
    setThumbnail({ file, url: URL.createObjectURL(file) });
    clearError("thumbnail");
  }

  /** What a submit still needs, in screen order. */
  function missing(): FieldKey[] {
    const list: FieldKey[] = [];
    if (!imageUrl) list.push("thumbnail");
    for (const [key] of TEXTS) {
      if (key === "status_window_rules") continue;
      if (key.startsWith("status_window") && !values.status_window_enabled)
        continue;
      if (!values[key].trim()) list.push(key);
      if (key === "character_name") {
        if (!values.gender) list.push("gender");
        if (age === null) list.push("age");
      }
    }
    return list;
  }
  const label = (field: FieldKey | "persona") =>
    t(`character.create.field.${field}`);

  function body(action: "save" | "submit") {
    const all = !savedRef.current;
    const form = new FormData();
    form.set("action", action);
    for (const [key] of TEXTS)
      if (all || changedTexts.includes(key)) form.set(key, values[key].trim());
    if (all || values.gender !== base.gender) form.set("gender", values.gender);
    if (all || values.age !== base.age) form.set("age", values.age);
    if (all || values.status_window_enabled !== base.status_window_enabled)
      form.set("status_window_enabled", String(values.status_window_enabled));
    if (all || isAdult !== base.is_adult) form.set("is_adult", String(isAdult));
    if (thumbnail) form.set("thumbnail", thumbnail.file);
    return form;
  }
  async function reload() {
    const id = savedRef.current?.id;
    if (!id) return;
    try {
      const detail = await api(`/characters/${id}`, characterDetailSchema);
      if (!alive.current) return;
      putSaved(detail);
      setValues(toValues(detail));
      setThumbnail(null);
      setErrors({});
      setDrafts({});
      setImageErrors({});
      setPicked([]);
    } catch (error) {
      if (alive.current) leaveOn(error);
    }
  }
  /** Errors that end the editing of this character. True when it handled one. */
  function leaveOn(error: unknown) {
    if (!(error instanceof ApiError)) return false;
    if (error.code === "creation_disabled") {
      notice(t("character.create.disabled"));
      router.replace("/");
      return true;
    }
    if (error.code === "not_owner" || error.code === "character_not_found") {
      notice(
        t(
          error.code === "not_owner"
            ? "character.create.not_owner"
            : "character.not_found",
        ),
      );
      router.replace("/characters/mine");
      return true;
    }
    return false;
  }
  /** Saves or submits. Returns the saved character, or null when nothing was saved. */
  async function persist(action: "save" | "submit") {
    if (busyRef.current) return null;
    if (action === "submit") {
      const list = missing();
      if (list.length) {
        setErrors((current) => ({
          ...current,
          ...Object.fromEntries(list.map((field) => [field, "required"])),
        }));
        jump(list[0]);
        say(
          t("character.create.missing", {
            list: list.map(label).join(", "),
          }),
          true,
        );
        return null;
      }
    }
    // A picture name that is empty or taken would be refused: fix it first.
    if (badImages.length) {
      // An empty name says so only now, not while it is being typed again.
      setImageErrors((now) => ({
        ...now,
        ...Object.fromEntries(
          badImages
            .filter((image) => !draftOf(image).name.trim())
            .map((image) => [image.id, "name_required"]),
        ),
      }));
      jump("media");
      say(
        t(
          `character.create.media.${
            draftOf(badImages[0]).name.trim()
              ? "name_duplicate"
              : "name_required"
          }`,
        ),
        true,
      );
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    const current = savedRef.current;
    const failedKey =
      action === "save"
        ? "character.create.save_failed"
        : "character.create.submit_failed";
    const event =
      action === "save" ? "character_draft_saved" : "character_submitted";
    try {
      // The pictures first: once submitted they can no longer be changed.
      if (current && !(await saveImages(current.id))) return null;
      const detail = await api(
        current ? `/characters/${current.id}` : "/characters",
        characterDetailSchema,
        { method: current ? "PATCH" : "POST", body: body(action) },
      );
      if (!alive.current) return null;
      send(event, {
        result: "succeeded",
        character_id: detail.id,
        is_new: !current,
        is_adult: detail.is_adult,
        ...(action === "submit"
          ? { is_revision: detail.revision_status === "pending" }
          : {}),
      });
      putSaved(detail);
      setThumbnail(null);
      query.removeQueries({ queryKey: ["my_characters"] });
      if (action === "submit") {
        router.push("/characters/mine");
        return detail;
      }
      // The address follows the character without loading the page again (4-3-2).
      if (!current)
        window.history.replaceState(null, "", `/characters/${detail.id}/edit`);
      savedAt();
      return detail;
    } catch (error) {
      if (!alive.current) return null;
      send(event, { result: "failed", code: errorCode(error) });
      if (leaveOn(error)) return null;
      const fields = fieldErrors(error).filter(
        (item) => item.field !== "action",
      );
      if (error instanceof ApiError && error.status === 413) {
        setErrors((now) => ({ ...now, thumbnail: "too_large" }));
        jump("thumbnail");
        say(t("character.create.image_too_large"), true);
      } else if (fields.length) {
        setErrors((now) => ({
          ...now,
          ...Object.fromEntries(
            fields.map((item) => [item.field, item.reason]),
          ),
        }));
        if (fields.some((item) => item.reason === "age_too_low"))
          setValues((now) => ({ ...now, is_adult: false }));
        jump(fields[0].field as FieldKey);
        say(t(failedKey), true);
      } else if (
        error instanceof ApiError &&
        error.code === "adult_verification_required"
      ) {
        say(t("character.create.adult_verification_required"), true);
      } else {
        say(t(failedKey), true);
        if (error instanceof ApiError && error.code === "save_not_allowed")
          void reload();
      }
      return null;
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // ---------- situation images (2-2-5, 4-4-3) ----------
  function uniqueName(file: File) {
    // Names typed but not saved yet count too: they are saved with the next save.
    const names = new Set(
      imagesRef.current.flatMap((image) => [
        image.name,
        (drafts[image.id]?.name ?? image.name).trim(),
      ]),
    );
    const stem =
      clip(file.name.replace(/\.[^.]+$/, ""), 40).trim() ||
      t("character.create.field.images");
    if (!names.has(stem)) return stem;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const name = clip(stem, 40 - suffix.length) + suffix;
      if (!names.has(name)) return name;
    }
  }
  async function addFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    // One upload at a time: the screen is locked while one runs.
    if (!files.length || mediaLocked || busyRef.current || queue.current.length)
      return;
    queue.current.push(...files);
    let added = 0;
    const skipped: string[] = [];
    const skip = (key: string, file: File) =>
      skipped.push(t(`character.create.media.${key}`, { name: file.name }));
    setUploading({ done: 0, total: queue.current.length });
    try {
      // A new character is saved once first, so the pictures have somewhere to go.
      const id = (savedRef.current ?? (await persist("save")))?.id;
      if (!id) return;
      let stop = false;
      while (queue.current.length && alive.current) {
        const file = queue.current[0];
        if (stop || imagesRef.current.length >= MAX_IMAGES) {
          stop = true;
          skip("skipped_limit", file);
        } else if (!IMAGE_TYPES.includes(file.type)) skip("skipped_type", file);
        else if (file.size > MAX_BYTES) skip("skipped_size", file);
        else {
          const upload = (name: string) => {
            const form = new FormData();
            form.set("file", file);
            form.set("name", name);
            return api(`/characters/${id}/images`, characterImageSchema, {
              method: "POST",
              body: form,
            });
          };
          try {
            let image: CharacterImage;
            try {
              image = await upload(uniqueName(file));
            } catch (error) {
              // Another tab took the name meanwhile: one more try under the next number.
              const duplicate = fieldErrors(error).some(
                (item) => item.field === "name" && item.reason === "duplicate",
              );
              if (!duplicate) throw error;
              image = await upload(
                clip(uniqueName(file), 37) + `-${imagesRef.current.length + 2}`,
              );
            }
            if (!alive.current) return;
            putImages([...imagesRef.current, image]);
            added++;
          } catch (error) {
            if (!alive.current) return;
            const code = errorCode(error);
            if (code === "image_limit_reached") {
              stop = true;
              skip("skipped_limit", file);
            } else if (code === "save_not_allowed") {
              queue.current = [];
              void reload();
              return;
            } else if (leaveOn(error)) {
              queue.current = [];
              return;
            } else if (error instanceof ApiError && error.status === 413)
              skip("skipped_size", file);
            else if (fieldErrors(error).length) skip("skipped_type", file);
            else skip("skipped_failed", file);
          }
        }
        queue.current.shift();
        setUploading((now) => (now ? { ...now, done: now.done + 1 } : now));
      }
    } finally {
      queue.current = [];
      if (alive.current) {
        setUploading(null);
        if (added || skipped.length) {
          send("character_images_added", { added, skipped: skipped.length });
          say(
            [
              t("character.create.media.added", { count: added }),
              skipped.length
                ? t("character.create.media.skipped", {
                    count: skipped.length,
                    list:
                      skipped.slice(0, 3).join(", ") +
                      (skipped.length > 3 ? " …" : ""),
                  })
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
            !added,
          );
        }
      }
    }
  }
  const draftOf = (image: CharacterImage) =>
    drafts[image.id] ?? { name: image.name, description: image.description };
  function editImage(
    image: CharacterImage,
    key: "name" | "description",
    value: string,
  ) {
    setDrafts((now) => ({
      ...now,
      [image.id]: {
        ...draftOf(image),
        [key]: clip(value, key === "name" ? 40 : 200),
      },
    }));
    if (key === "name" && imageErrors[image.id])
      setImageErrors((now) => ({ ...now, [image.id]: "" }));
  }
  function dropImage(id: string) {
    putImages(imagesRef.current.filter((image) => image.id !== id));
    setPicked((now) => now.filter((item) => item !== id));
    setDrafts((now) => {
      const rest = { ...now };
      delete rest[id];
      return rest;
    });
  }
  /**
   * Saves the picture names and descriptions typed since the last save, before the
   * character itself. False when the save must stop here.
   */
  async function saveImages(id: string) {
    // What an earlier try was refused for is asked again now.
    setImageErrors({});
    for (const image of [...imagesRef.current]) {
      const draft = drafts[image.id];
      if (!draft) continue;
      const change: { name?: string; description?: string } = {};
      if (draft.name.trim() !== image.name) change.name = draft.name.trim();
      if (draft.description.trim() !== image.description)
        change.description = draft.description.trim();
      if (!Object.keys(change).length) continue;
      try {
        const next = await api(
          `/characters/${id}/images/${image.id}`,
          characterImageSchema,
          { method: "PATCH", body: JSON.stringify(change) },
        );
        if (!alive.current) return false;
        putImages(
          imagesRef.current.map((item) => (item.id === next.id ? next : item)),
        );
      } catch (error) {
        if (!alive.current) return false;
        const code = errorCode(error);
        if (code === "image_not_found") {
          dropImage(image.id);
          continue;
        }
        if (code === "save_not_allowed") void reload();
        else if (!leaveOn(error)) {
          setImageErrors((now) => ({
            ...now,
            [image.id]: fieldErrors(error).some(
              (item) => item.reason === "duplicate",
            )
              ? "name_duplicate"
              : "failed",
          }));
          jump("media");
          say(t("character.create.save_failed"), true);
        }
        return false;
      }
    }
    setDrafts({});
    return true;
  }
  async function removeImages(ids: string[]) {
    const id = savedRef.current?.id;
    if (!id || !ids.length) return;
    let removed = 0;
    let failed = false;
    for (const imageId of ids) {
      try {
        await request(`/characters/${id}/images/${imageId}`, {
          method: "DELETE",
        });
      } catch (error) {
        if (!alive.current) return;
        const code = errorCode(error);
        if (code === "save_not_allowed") return void reload();
        if (leaveOn(error)) return;
        if (code !== "image_not_found") {
          failed = true;
          continue;
        }
      }
      if (!alive.current) return;
      dropImage(imageId);
      removed++;
    }
    say(
      failed
        ? t("character.create.media.failed")
        : t("character.create.media.deleted", { count: removed }),
      failed,
    );
  }
  async function cancelRevision() {
    const id = savedRef.current?.id;
    if (!id || cancelBusy) return;
    setCancelBusy(true);
    try {
      await request(`/characters/${id}/revision`, { method: "DELETE" });
      send("character_revision_cancelled", { result: "succeeded" });
    } catch (error) {
      if (!alive.current) return;
      const code = errorCode(error);
      if (code !== "revision_not_found") {
        send("character_revision_cancelled", { result: "failed", code });
        setCancelBusy(false);
        setCancelling(false);
        if (!leaveOn(error))
          say(t("character.create.revision.cancel_failed"), true);
        return;
      }
    }
    if (!alive.current) return;
    query.removeQueries({ queryKey: ["my_characters"] });
    await reload();
    if (!alive.current) return;
    setCancelBusy(false);
    setCancelling(false);
  }
  /** A link out of this screen: with unsaved changes the browser asks first. */
  function guardLeave(event: { preventDefault: () => void }) {
    if (dirty && !window.confirm(t("character.create.leave_confirm")))
      event.preventDefault();
  }

  // ---------- view helpers ----------
  const badImages = images.filter((image) => {
    const name = draftOf(image).name.trim();
    return (
      !name ||
      images.some(
        (other) => other.id !== image.id && draftOf(other).name.trim() === name,
      )
    );
  });
  const need = missing();
  const done: Record<Step, boolean> = {
    info: !need.some((field) => stepOf(field) === "info"),
    prompt: !need.some((field) => stepOf(field) === "prompt"),
    start: !need.some((field) => stepOf(field) === "start"),
    media: images.length > 0 && !badImages.length,
    register: !need.length && !badImages.length,
  };
  const promptKeys: TextKey[] = [
    "personality",
    "speech_style",
    "world_setting",
    "first_message",
    ...(values.status_window_enabled
      ? ([
          "status_window_format",
          "status_window_initial",
          "status_window_rules",
        ] as const)
      : []),
  ];
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const errorText = (field: FieldKey) => {
    const reason = errors[field];
    if (!reason) return null;
    const key =
      reason === "required"
        ? "field_required"
        : reason === "too_long"
          ? "field_too_long"
          : reason === "invalid_image"
            ? "image_type_invalid"
            : reason === "too_large"
              ? "image_too_large"
              : reason === "age_too_low"
                ? "adult_age_hint"
                : "field_invalid";
    return (
      <span className="ce_error" role="alert">
        {t(`character.create.${key}`)}
      </span>
    );
  };
  const textField = (
    key: TextKey,
    options: { long?: boolean; single?: boolean; optional?: boolean } = {},
  ) => (
    <label className={`ce_field ${errors[key] ? "invalid" : ""}`}>
      <span className="ce_label">
        {label(key)}
        {!options.optional && <span className="ce_req"> *</span>}
      </span>
      <span className="ce_hint">{t(`character.create.hint.${key}`)}</span>
      {options.single ? (
        <input
          id={`ce_${key}`}
          type="text"
          autoComplete="off"
          value={values[key]}
          placeholder={
            key === "name" || key === "tagline"
              ? t(`character.create.placeholder.${key}`)
              : undefined
          }
          onChange={(event) => setText(key, event.target.value)}
        />
      ) : (
        <textarea
          id={`ce_${key}`}
          className={options.long ? "long" : ""}
          value={values[key]}
          placeholder={
            key === "status_window_format" || key === "status_window_initial"
              ? t(`character.create.placeholder.${key}`)
              : undefined
          }
          onChange={(event) => setText(key, event.target.value)}
        />
      )}
      <span className="ce_count">
        {number(length(values[key]))}/{number(LIMITS[key])}
      </span>
      {errorText(key)}
    </label>
  );

  const previewName = {
    info: "card",
    register: "card",
    prompt: "chat",
    start: "chat",
    media: "images",
  }[step];
  const statusSample = values.status_window_enabled
    ? values.status_window_initial.trim()
    : "";
  const reason = saved?.rejection_reason;
  const checklist: [FieldKey, string][] = [
    ["thumbnail", imageUrl ? t("character.create.checklist.present") : ""],
    ...TEXTS.filter(
      ([key]) =>
        values.status_window_enabled || !key.startsWith("status_window"),
    ).flatMap(([key]): [FieldKey, string][] => [
      [
        key,
        values[key].trim()
          ? t("character.create.checklist.filled", {
              count: number(length(values[key])),
            })
          : "",
      ],
      ...(key === "character_name"
        ? ([
            [
              "gender",
              values.gender
                ? t(`character.create.gender.${values.gender}`)
                : "",
            ],
            [
              "age",
              age === null ? "" : t("character.create.checklist.age", { age }),
            ],
          ] as [FieldKey, string][])
        : []),
    ]),
  ];

  return (
    <div className="ce_app">
      <header className="ce_top">
        <div className="header_start">
          <Link className="brand" href="/" onClick={guardLeave}>
            {t("common.brand")}
          </Link>
        </div>
        <nav
          className="ce_steps"
          aria-label={t("character.create.steps_label")}
        >
          {STEPS.map((id, index) => (
            <button
              key={id}
              type="button"
              className="ce_step"
              aria-current={step === id ? "step" : undefined}
              onClick={() => go(id)}
            >
              <span className="ce_num">{index + 1}</span>
              {t(`character.create.step.${id}`)}
              {id !== "media" && <span className="ce_req">*</span>}
              {done[id] && (
                <span className="ce_done" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </nav>
        {saved?.revision_status && (
          <button
            type="button"
            className="button"
            disabled={busy || cancelBusy || !!uploading}
            onClick={() => setCancelling(true)}
          >
            {t("character.create.revision.cancel")}
          </button>
        )}
        {canSaveDraft && (
          <button
            type="button"
            className="button primary"
            disabled={busy || !!uploading}
            onClick={() => void persist("save")}
          >
            {t("character.create.save_draft")}
          </button>
        )}
      </header>

      <main
        id="main"
        ref={mainRef}
        className={`ce_main ${over ? "over" : ""}`}
        // Locked while a save or an upload is on its way, so nothing typed or picked
        // meanwhile is lost and a submit cannot cut the upload short.
        inert={busy || !!uploading}
        onDragOver={(event) => {
          if (step !== "media" || mediaLocked) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setOver(false);
        }}
        onDrop={(event) => {
          if (step !== "media" || mediaLocked) return;
          event.preventDefault();
          setOver(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        {reason && (status === "rejected" || saved?.revision_status) && (
          <div className="ce_notice reject">
            <strong>{t("character.create.reject_reason_title")}</strong>
            <p>{reason}</p>
          </div>
        )}
        {status === "approved" && (
          <div className="ce_notice">
            <p>{t("character.create.revision.notice")}</p>
          </div>
        )}

        {step === "info" && (
          <section className="ce_pane">
            <div className={`ce_field ${errors.thumbnail ? "invalid" : ""}`}>
              <span className="ce_label">
                {label("thumbnail")}
                <span className="ce_req"> *</span>
              </span>
              <span className="ce_hint">
                {t("character.create.hint.thumbnail")}
              </span>
              <div className="ce_slot">
                <button
                  type="button"
                  id="ce_thumbnail"
                  className="ce_drop"
                  aria-label={label("thumbnail")}
                  onClick={() => thumbnailInput.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    chooseThumbnail(event.dataTransfer.files[0]);
                  }}
                >
                  {imageUrl ? (
                    <img src={imageUrl} alt="" />
                  ) : (
                    t("character.create.thumbnail_slot")
                  )}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => thumbnailInput.current?.click()}
                >
                  {t("character.create.upload")}
                </button>
                <input
                  ref={thumbnailInput}
                  type="file"
                  hidden
                  accept={IMAGE_TYPES.join(",")}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    chooseThumbnail(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </div>
              {errorText("thumbnail")}
            </div>
            {textField("name", { single: true })}
            {textField("tagline", { single: true })}
            <div
              className={`ce_field ${
                errors.character_name || errors.gender || errors.age
                  ? "invalid"
                  : ""
              }`}
            >
              <span className="ce_label">
                {label("persona")}
                <span className="ce_req"> *</span>
              </span>
              <span className="ce_hint">
                {t("character.create.hint.persona")}
              </span>
              <div className="ce_persona">
                <label className="ce_sub name">
                  <span>{label("character_name")}</span>
                  <input
                    id="ce_character_name"
                    type="text"
                    autoComplete="off"
                    value={values.character_name}
                    placeholder={t(
                      "character.create.placeholder.character_name",
                    )}
                    onChange={(event) =>
                      setText("character_name", event.target.value)
                    }
                  />
                </label>
                <div className="ce_sub">
                  <span id="ce_gender_label">{label("gender")}</span>
                  <div
                    className="ce_choice"
                    role="radiogroup"
                    aria-labelledby="ce_gender_label"
                  >
                    {(["female", "male"] as const).map((gender, index) => (
                      <label key={gender}>
                        <input
                          id={index === 0 ? "ce_gender" : undefined}
                          type="radio"
                          name="gender"
                          value={gender}
                          checked={values.gender === gender}
                          onChange={() => {
                            setValues((now) => ({ ...now, gender }));
                            clearError("gender");
                          }}
                        />
                        {t(`character.create.gender.${gender}`)}
                      </label>
                    ))}
                  </div>
                </div>
                <label className="ce_sub">
                  <span>{label("age")}</span>
                  <span className="ce_unit">
                    <input
                      id="ce_age"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={values.age}
                      placeholder={t("character.create.placeholder.age")}
                      onChange={(event) => {
                        // Digits only, up to 99,999 (2-2-5).
                        const digits = event.target.value
                          .replace(/\D/g, "")
                          .slice(0, 5);
                        setValues((now) => ({
                          ...now,
                          age: digits === "" ? "" : String(Number(digits)),
                        }));
                        clearError("age");
                      }}
                    />
                    <i>{t("character.create.age_unit")}</i>
                  </span>
                </label>
              </div>
              <span className="ce_hint after">
                {t("character.create.adult_age_hint")}
              </span>
              {errorText("character_name") ??
                errorText("gender") ??
                errorText("age")}
            </div>
          </section>
        )}

        {step === "prompt" && (
          <section className="ce_pane">
            <div className="ce_tabs" role="tablist">
              {(["main", "status_window"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="ce_tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                >
                  {t(`character.create.tab.${id}`)}
                </button>
              ))}
            </div>
            {tab === "main" ? (
              <div role="tabpanel">
                {textField("personality")}
                {textField("speech_style")}
                {textField("world_setting", { long: true })}
              </div>
            ) : (
              <div role="tabpanel">
                <div className="ce_switch_row">
                  <div>
                    <div className="ce_label">
                      {t("character.create.tab.status_window")}
                    </div>
                    <div className="ce_hint">
                      {t("character.create.hint.status_window_enabled")}
                    </div>
                  </div>
                  <label className="ce_switch">
                    <input
                      type="checkbox"
                      aria-label={t(
                        "character.create.field.status_window_enabled",
                      )}
                      checked={values.status_window_enabled}
                      onChange={(event) =>
                        setValues((now) => ({
                          ...now,
                          status_window_enabled: event.target.checked,
                        }))
                      }
                    />
                    <i />
                  </label>
                </div>
                {values.status_window_enabled && (
                  <>
                    {textField("status_window_format")}
                    {textField("status_window_initial")}
                    {textField("status_window_rules", { optional: true })}
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {step === "start" && (
          <section className="ce_pane">
            {textField("first_message", { long: true })}
          </section>
        )}

        {step === "media" && (
          <section className="ce_pane">
            {mediaLocked ? (
              <div className="ce_notice">
                <p>{t("character.create.media.locked")}</p>
              </div>
            ) : (
              <div className="ce_tip">
                <ul>
                  <li>{t("character.create.media.tip_1")}</li>
                  <li>{t("character.create.media.tip_2")}</li>
                  <li>{t("character.create.media.tip_3")}</li>
                </ul>
              </div>
            )}
            <div className="ce_media_bar">
              <h3>
                {t("character.create.media.all", { count: images.length })}
              </h3>
              {!mediaLocked && (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={!picked.length}
                    onClick={() => void removeImages(picked)}
                  >
                    {picked.length
                      ? t("character.create.media.delete_selected_count", {
                          count: picked.length,
                        })
                      : t("character.create.media.delete_selected")}
                  </button>
                  <button
                    type="button"
                    id="ce_media_add"
                    className="button"
                    onClick={() => mediaInput.current?.click()}
                  >
                    {t("character.create.media.add")}
                  </button>
                </>
              )}
              <div
                className="ce_seg"
                role="group"
                aria-label={t("character.create.media.view_label")}
              >
                {(["list", "grid"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={view === id}
                    onClick={() => setView(id)}
                  >
                    {t(`character.create.media.view_${id}`)}
                  </button>
                ))}
              </div>
            </div>
            <input
              ref={mediaInput}
              type="file"
              hidden
              multiple
              accept={IMAGE_TYPES.join(",")}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            {uploading && (
              <p className="ce_uploading" role="status">
                {t("character.create.media.uploading", uploading)}
              </p>
            )}
            <div className={`ce_media ${view}`}>
              {images.map((image) => {
                const draft = draftOf(image);
                // A taken name says so as it is typed, an empty one when a save is tried;
                // a refusal of the server stays until the name changes.
                const bad =
                  !!imageErrors[image.id] || badImages.includes(image);
                const problem =
                  imageErrors[image.id] ||
                  (badImages.includes(image) && draft.name.trim()
                    ? "name_duplicate"
                    : "");
                return (
                  <div key={image.id} className={`ce_item ${bad ? "bad" : ""}`}>
                    {!mediaLocked && (
                      <input
                        type="checkbox"
                        className="ce_pick"
                        aria-label={t("character.create.media.select")}
                        checked={picked.includes(image.id)}
                        onChange={(event) =>
                          setPicked((now) =>
                            event.target.checked
                              ? [...now, image.id]
                              : now.filter((id) => id !== image.id),
                          )
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="ce_thumb"
                      aria-label={t("character.create.media.zoom")}
                      onClick={() => setZoom(image.image_url)}
                    >
                      <img src={image.image_url} alt="" loading="lazy" />
                    </button>
                    <div className="ce_texts">
                      {mediaLocked ? (
                        <>
                          <strong>{image.name}</strong>
                          <span className="ce_meta">{image.description}</span>
                        </>
                      ) : (
                        <>
                          <input
                            type="text"
                            aria-label={t("character.create.media.image_name")}
                            placeholder={t("character.create.media.image_name")}
                            value={draft.name}
                            onChange={(event) =>
                              editImage(image, "name", event.target.value)
                            }
                          />
                          <textarea
                            aria-label={t("character.create.media.description")}
                            placeholder={t(
                              "character.create.media.description_placeholder",
                            )}
                            value={draft.description}
                            onChange={(event) =>
                              editImage(
                                image,
                                "description",
                                event.target.value,
                              )
                            }
                          />
                          {problem && (
                            <span className="ce_error" role="alert">
                              {t(`character.create.media.${problem}`)}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    {!mediaLocked && (
                      <button
                        type="button"
                        className="ce_del"
                        aria-label={t("character.create.media.delete")}
                        onClick={() => void removeImages([image.id])}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {!mediaLocked && (
              <button
                type="button"
                className={`ce_dropzone ${images.length ? "small" : ""}`}
                onClick={() => mediaInput.current?.click()}
              >
                <strong>{t("character.create.media.drop_title")}</strong>
                {t("character.create.media.drop_hint")}
              </button>
            )}
          </section>
        )}

        {step === "register" && (
          <section className="ce_pane">
            {adultAvailable && (
              <div className="ce_switch_row">
                <div>
                  <div className="ce_label">{label("is_adult")}</div>
                  <div className="ce_hint">
                    {t("character.create.hint.is_adult")}
                  </div>
                  {adultLocked && (
                    <div className="ce_error">
                      {age === null
                        ? t("character.create.adult_age_missing")
                        : t("character.create.adult_age_too_low", {
                            age,
                            min: ADULT_MIN_AGE,
                          })}
                    </div>
                  )}
                </div>
                <label className={`ce_switch ${adultLocked ? "locked" : ""}`}>
                  <input
                    id="ce_is_adult"
                    type="checkbox"
                    aria-label={label("is_adult")}
                    disabled={adultLocked}
                    checked={isAdult}
                    onChange={(event) => {
                      setValues((now) => ({
                        ...now,
                        is_adult: event.target.checked,
                      }));
                      clearError("is_adult");
                    }}
                  />
                  <i />
                </label>
              </div>
            )}
            <div className="ce_field">
              <span className="ce_label">
                {t("character.create.checklist.title")}
              </span>
              <span className="ce_hint">
                {t("character.create.checklist.hint")}
              </span>
              <table className="ce_sum">
                <tbody>
                  {checklist.map(([field, value]) => {
                    const empty = need.includes(field);
                    return (
                      <tr
                        key={field}
                        className={empty ? "miss" : ""}
                        onClick={() => jump(field)}
                      >
                        <td>
                          <button type="button">{label(field)}</button>
                        </td>
                        <td>
                          {value ||
                            (empty
                              ? t("character.create.checklist.empty")
                              : "—")}
                        </td>
                      </tr>
                    );
                  })}
                  <tr
                    className={badImages.length ? "miss" : ""}
                    onClick={() => jump("media")}
                  >
                    <td>
                      <button type="button">
                        {t("character.create.field.images")}
                      </button>
                    </td>
                    <td>
                      {badImages.length
                        ? t("character.create.checklist.images_bad", {
                            count: images.length,
                            bad: badImages.length,
                          })
                        : t("character.create.checklist.images", {
                            count: images.length,
                          })}
                    </td>
                  </tr>
                  {adultAvailable && (
                    <tr>
                      <td>{label("is_adult")}</td>
                      <td>
                        {t(
                          `character.create.checklist.${isAdult ? "yes" : "no"}`,
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="button primary ce_submit"
              disabled={busy || (status === "approved" && !dirty)}
              onClick={() => void persist("submit")}
            >
              {t("character.create.submit")}
            </button>
          </section>
        )}
      </main>

      <aside className="ce_side">
        <h2>
          {t("character.create.preview.title")}{" "}
          <span>/ {t(`character.create.preview.${previewName}`)}</span>
        </h2>
        <div className="ce_side_body">
          {previewName === "card" ? (
            <div className="ce_card">
              <div className="ce_pic">
                {imageUrl ? (
                  <img src={imageUrl} alt="" />
                ) : (
                  t("character.create.preview.no_image")
                )}
              </div>
              <b>
                {values.name.trim() || t("character.create.preview.name_empty")}
              </b>
              <p>
                {values.tagline.trim() ||
                  t("character.create.preview.tagline_empty")}
              </p>
              {isAdult && <span className="ce_badge">19</span>}
            </div>
          ) : previewName === "images" ? (
            images.length ? (
              <>
                <p className="ce_note">
                  {t("character.create.preview.images_title")}
                </p>
                <table className="ce_sum">
                  <tbody>
                    {images.map((image) => (
                      <tr key={image.id}>
                        <td>
                          {draftOf(image).name.trim() ||
                            t("character.create.preview.image_no_name")}
                        </td>
                        <td>
                          {draftOf(image).description.trim() ||
                            t("character.create.preview.image_no_description")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="ce_note">
                {t("character.create.preview.images_hint")}
              </p>
            )
          ) : (
            <>
              <div className="ce_chat_head">
                <span className="ce_ava">
                  {imageUrl && <img src={imageUrl} alt="" />}
                </span>
                {values.character_name.trim() ||
                  t("character.create.preview.character_name_empty")}
              </div>
              <div className="ce_bubble">
                {values.first_message.trim() ? (
                  rich(values.first_message.trim())
                ) : (
                  <span className="ce_note">
                    {t("character.create.preview.first_message_empty")}
                  </span>
                )}
              </div>
              {statusSample && (
                <div className="ce_status_box">{statusSample}</div>
              )}
              {values.status_window_enabled && !statusSample && (
                <p className="ce_note">
                  {t("character.create.preview.status_hint")}
                </p>
              )}
            </>
          )}
        </div>
      </aside>

      <footer className="ce_foot">
        <span>
          {t("character.create.footer.prompt", {
            count: number(
              promptKeys.reduce((sum, key) => sum + length(values[key]), 0),
            ),
          })}
        </span>
        <span>
          {t("character.create.footer.images", { count: images.length })}
        </span>
        <span
          className={`ce_status ${line.error ? "error" : ""}`}
          role="status"
        >
          {line.text}
        </span>
      </footer>

      {zoom && (
        <button
          type="button"
          className="ce_zoom"
          aria-label={t("character.create.media.zoom_close")}
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="" />
        </button>
      )}
      {cancelling && (
        <Modal
          title={t("character.create.revision.cancel_title")}
          onClose={() => {
            if (!cancelBusy) setCancelling(false);
          }}
        >
          <p className="muted">
            {t("character.create.revision.cancel_confirm")}
          </p>
          <div className="modal_actions">
            <button
              className="button"
              disabled={cancelBusy}
              onClick={() => setCancelling(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              disabled={cancelBusy}
              onClick={() => void cancelRevision()}
            >
              {t("character.create.revision.cancel")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

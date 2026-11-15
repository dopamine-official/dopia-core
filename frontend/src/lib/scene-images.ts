// A reply places a situation image by writing {{img::name}} where the picture belongs. The
// stored text keeps the tags; these functions only decide what to show.
//
// The picture is not part of a bubble: the reply is cut at each tag, so the text before it,
// the picture and the text after it are shown one under another.
export type SceneImage = { name: string; image_url: string };
export type ScenePart =
  | { type: "text"; text: string }
  | { type: "image"; name: string; image_url: string };

// A saved reply holds the picture's address, {{img::/files/a.webp}}: the server swaps the name
// for it, so a picture renamed later still shows. A reply still arriving holds the name.
//
// Models do not always write the tag exactly: one colon, a space inside, another case. A name
// holds no brace and no line break, so a tag left open cannot swallow the next one.
const TAG = /\{\{\s*img\s*::?\s*([^{}\n]*?)\s*\}\}/gi;
// A tag that never closes (a reply cut short, or a model's slip): nothing from it to the end
// of its line is shown.
const OPEN_TAG = /\{\{\s*img\s*:[^\n]*/gi;
// An ending that could still turn into a tag once more text arrives.
const OPENING = /\{(?:\{\s*(?:i(?:m(?:g\s*(?::[^{}\n]*)?)?)?)?)?$/i;

function tidy(text: string) {
  return text
    .replace(OPEN_TAG, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The text and pictures of a reply, in order. A tag that names none of [images], and a second
 * tag for a picture already shown in this reply, are left out without a trace: the text around
 * them stays one piece.
 *
 * [saved] is for a reply read from the room: the server put the addresses there, so one is
 * shown even when the character no longer lists it. A reply still arriving comes from the
 * model, and an address in it is shown only when it is one of this character's.
 */
export function splitSceneImages(
  body: string,
  images: SceneImage[],
  saved = false,
): ScenePart[] {
  // The model may change the case of a name; it is still that picture.
  const byName = new Map(
    images.map((image) => [image.name.trim().toLowerCase(), image]),
  );
  const byUrl = new Map(images.map((image) => [image.image_url, image]));
  const shown = new Set<string>();
  const parts: ScenePart[] = [];
  let text = "";
  let position = 0;
  const flush = () => {
    const clean = tidy(text);
    if (clean) parts.push({ type: "text", text: clean });
    text = "";
  };
  for (const match of body.matchAll(TAG)) {
    text += body.slice(position, match.index);
    position = match.index + match[0].length;
    const value = match[1];
    const address = saved && /^(?:https?:\/\/|\/)/.test(value);
    const image =
      byName.get(value.toLowerCase()) ??
      byUrl.get(value) ??
      (address ? { name: "", image_url: value } : undefined);
    if (!image || shown.has(image.image_url)) continue;
    shown.add(image.image_url);
    flush();
    parts.push({ type: "image", name: image.name, image_url: image.image_url });
  }
  text += body.slice(position);
  flush();
  return parts;
}

/** The text alone, for a one-line preview. */
export function withoutSceneImages(body: string) {
  return tidy(body.replace(TAG, ""));
}

/** What to show while a reply is still arriving: nothing of a tag that is only half there. */
export function holdBackSceneImage(partial: string) {
  const open = partial.search(OPENING);
  return open === -1 ? partial : partial.slice(0, open).trimEnd();
}

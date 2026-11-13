// A character with a status window ends its reply with <status>…</status> (CHAT WEB 2-2-2).
// The stored text keeps the block; these functions only decide what to show.
//
// Models do not always write the tags exactly: the case may differ, a space may slip inside, or
// the tags may be wrapped in backticks or a code fence. All of those are the same block.
const OPEN_TAG = "<\\s*status\\s*>";
const FENCE = "```\\w*\\s*";
// The text between the tags holds no opening tag, so a block starts at the opening tag nearest
// to its closing tag. An earlier "<status>" (a character quoting the word) stays ordinary text.
const CORE = `\`?${OPEN_TAG}\`?((?:(?!${OPEN_TAG})[\\s\\S])*?)\`?<\\s*/\\s*status\\s*>\`?`;
// A fence belongs to the block only when it wraps it on both sides; a fence before the block
// alone is the end of an unrelated code block.
const BLOCK = new RegExp(`${FENCE}${CORE}\\s*\`\`\`|${CORE}`, "gi");
const OPEN_FENCE = new RegExp(`${FENCE}$`);
const OPEN = new RegExp(`(?:${FENCE})?\`?${OPEN_TAG}`, "i");
// An ending that could still turn into the opening tag once more text arrives: a wrapper
// (backticks or a fence), a partly written tag, or both.
const OPENING = new RegExp(
  `(?:${FENCE}|\`+)?(?:<\\s*(?:s(?:t(?:a(?:t(?:u(?:s\\s*)?)?)?)?)?)?)?$`,
  "i",
);

function strip(content: string) {
  let status: string | null = null;
  let body = "";
  let position = 0;
  for (const match of content.matchAll(BLOCK)) {
    body += content.slice(position, match.index);
    // A fence opened just before the block and not closed yet (the reply is still arriving, or
    // the model forgot to close it) wraps the block too. An odd number of fences so far means
    // this one opens; an even number means it closed an earlier code block, which stays.
    const fences = content.slice(0, match.index).split("```").length - 1;
    if (fences % 2 === 1) body = body.replace(OPEN_FENCE, "");
    status = (match[1] ?? match[2]).trim() || null;
    position = match.index + match[0].length;
  }
  // After the last block, an opening tag starts a block that never closes (a reply cut short):
  // it is shown nowhere.
  const rest = content.slice(position);
  const open = rest.search(OPEN);
  body += open === -1 ? rest : rest.slice(0, open);
  return { body, status };
}

/** The message without its status blocks, and the last block's text if there is one. */
export function splitStatusWindow(content: string) {
  const { body, status } = strip(content);
  return { body: body.trim(), status };
}

/** What to show while a reply is still arriving: nothing from the status window onwards. */
export function visibleWhileStreaming(partial: string) {
  const { body } = strip(partial);
  return body.slice(0, body.search(OPENING)).trimEnd();
}

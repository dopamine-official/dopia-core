import { describe, expect, it } from "vitest";
import {
  holdBackSceneImage,
  splitSceneImages,
  withoutSceneImages,
} from "@/lib/scene-images";

const images = [
  { name: "복도", image_url: "/a.webp" },
  { name: "하굣길", image_url: "/b.webp" },
];
const picture = (name: string, image_url: string) => ({
  type: "image",
  name,
  image_url,
});
const text = (value: string) => ({ type: "text", text: value });

describe("scene images", () => {
  it("cuts the reply at each tag: picture, text, picture, text", () => {
    expect(
      splitSceneImages(
        "{{img::복도}}\n*걸어온다.*\n안 갔어?\n{{img::하굣길}}\n같이 갈래?",
        images,
      ),
    ).toEqual([
      picture("복도", "/a.webp"),
      text("*걸어온다.*\n안 갔어?"),
      picture("하굣길", "/b.webp"),
      text("같이 갈래?"),
    ]);
  });
  it("is one piece of text when there is no tag", () => {
    expect(splitSceneImages("안녕", images)).toEqual([text("안녕")]);
    expect(splitSceneImages("", images)).toEqual([]);
  });
  it("puts a picture last when the reply ends with its tag", () => {
    expect(splitSceneImages("안녕\n{{img:: 복도 }}", images)).toEqual([
      text("안녕"),
      picture("복도", "/a.webp"),
    ]);
  });
  it("leaves out a name it does not know and keeps the text in one piece", () => {
    expect(splitSceneImages("하나\n{{img::옥상}}\n둘", images)).toEqual([
      text("하나\n\n둘"),
    ]);
    // A room whose character has no pictures shows no tag either.
    expect(splitSceneImages("{{img::복도}}\n하나", [])).toEqual([text("하나")]);
  });
  it("shows a picture once in a reply", () => {
    expect(
      splitSceneImages("{{img::복도}}\n하나\n{{img::복도}}\n둘", images),
    ).toEqual([picture("복도", "/a.webp"), text("하나\n\n둘")]);
  });
  it("shows nothing of a tag that never closes, to the end of its line", () => {
    expect(splitSceneImages("하나\n{{img::복도\n둘", images)).toEqual([
      text("하나\n\n둘"),
    ]);
    // The open tag does not swallow the next one.
    expect(
      splitSceneImages("{{img::복도\n하나\n{{img::하굣길}}", images),
    ).toEqual([text("하나"), picture("하굣길", "/b.webp")]);
  });
  it("takes a tag written loosely as the same tag", () => {
    expect(
      splitSceneImages("{{img:복도}}\n하나\n{{ IMG :: 하굣길 }}", images),
    ).toEqual([
      picture("복도", "/a.webp"),
      text("하나"),
      picture("하굣길", "/b.webp"),
    ]);
  });
  it("shows the address a saved reply holds, whatever the character lists now", () => {
    const reply = "{{img::/a.webp}}\n하나\n{{img::https://cdn/gone.webp}}";
    expect(splitSceneImages(reply, images, true)).toEqual([
      picture("복도", "/a.webp"),
      text("하나"),
      picture("", "https://cdn/gone.webp"),
    ]);
    // A reply still arriving is the model's: only this character's own address is shown.
    expect(splitSceneImages(reply, images)).toEqual([
      picture("복도", "/a.webp"),
      text("하나"),
    ]);
    // The name and the address of one picture are the same picture.
    expect(
      splitSceneImages("{{img::복도}}\n하나\n{{img::/a.webp}}", images, true),
    ).toEqual([picture("복도", "/a.webp"), text("하나")]);
  });
  it("gives a preview the text alone", () => {
    expect(withoutSceneImages("{{img::복도}}\n하나\n{{img::옥상}}\n둘")).toBe(
      "하나\n\n둘",
    );
    expect(withoutSceneImages("하나 {{img::복")).toBe("하나");
  });
  it("holds back a tag while it is still arriving", () => {
    const reply = "하나\n{{img::복도}}\n둘";
    const seen = new Set<string>();
    for (let end = 1; end <= reply.length; end++) {
      const visible = holdBackSceneImage(reply.slice(0, end));
      // Never a brace on screen: either the tag is whole and becomes a picture, or it waits.
      for (const part of splitSceneImages(visible, images))
        if (part.type === "text") {
          expect(part.text).not.toContain("{");
          seen.add(part.text);
        }
    }
    expect(seen).toContain("하나");
    expect(seen).toContain("둘");
    expect(holdBackSceneImage("하나\n{")).toBe("하나");
    expect(holdBackSceneImage("하나\n{{img::복")).toBe("하나");
    expect(holdBackSceneImage("하나\n{{ IMG :복")).toBe("하나");
    expect(holdBackSceneImage("{a}")).toBe("{a}");
  });
});

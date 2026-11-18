import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consentItems } from "@/mocks/consents";

// A legal document shown in the consent modal states its version on the line `버전 <x>`.
// The consent version the server asks for must be the same, or a changed document would not
// ask anyone to agree again.
const root = join(__dirname, "../..");
const regionsDir = join(root, "../backend/src/main/resources/i18n/regions");
const legalDir = join(root, "public/legal");

type Item = { id: string; version: string };
const regions: string[] = JSON.parse(
  readFileSync(join(regionsDir, "index.json"), "utf8"),
).regions;

function documentVersion(path: string) {
  return /^버전 (.+)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim();
}

describe("legal document versions", () => {
  for (const region of regions) {
    const items: Item[] = JSON.parse(
      readFileSync(join(regionsDir, `${region}.json`), "utf8"),
    ).consent.items;
    for (const item of items) {
      it(`${region} ${item.id} matches every translation`, () => {
        const source = join(legalDir, region, "ko-KR", `${item.id}.md`);
        expect(existsSync(source), `${source} is missing`).toBe(true);
        for (const locale of readdirSync(join(legalDir, region))) {
          const path = join(legalDir, region, locale, `${item.id}.md`);
          if (!existsSync(path)) continue;
          expect(documentVersion(path), path).toBe(item.version);
        }
      });
    }
  }

  it("the mock consent items follow the default region", () => {
    const items: Item[] = JSON.parse(
      readFileSync(join(regionsDir, `${regions[0]}.json`), "utf8"),
    ).consent.items;
    expect(consentItems.map(({ id, version }) => ({ id, version }))).toEqual(
      items.map(({ id, version }) => ({ id, version })),
    );
  });
});

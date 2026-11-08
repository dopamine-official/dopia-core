import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const root = new URL("../src/i18n/", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const flatten = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null
      ? flatten(child, `${prefix}${key}.`)
      : [[`${prefix}${key}`, child]],
  );
const regions = read("regions/index.json");
const profiles = read("profiles.json");
const bundles = {};
for (const locale of readdirSync(new URL("locales/", root))) {
  bundles[locale] = Object.fromEntries(
    readdirSync(new URL(`locales/${locale}/`, root)).flatMap((file) =>
      flatten(
        read(`locales/${locale}/${file}`),
        `${file.replace(".json", "")}.`,
      ),
    ),
  );
  for (const [key, value] of Object.entries(bundles[locale])) {
    assert.match(key, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
    assert.ok(
      typeof value === "string" && value.trim(),
      `${locale}: empty ${key}`,
    );
    assert.equal(
      value.replace(/\{[a-z_]+\}/g, "").match(/[{}]/g),
      null,
      `${locale}: invalid placeholder in ${key}`,
    );
  }
}
const baseline = bundles["ko-KR"];
for (const [locale, bundle] of Object.entries(bundles)) {
  assert.deepEqual(
    Object.keys(bundle).sort(),
    Object.keys(baseline).sort(),
    `${locale}: keys differ`,
  );
  for (const key of Object.keys(baseline))
    assert.deepEqual(
      bundle[key].match(/\{[a-z_]+\}/g)?.sort(),
      baseline[key].match(/\{[a-z_]+\}/g)?.sort(),
      `${locale}: parameters differ for ${key}`,
    );
}
assert.ok(regions.regions.includes(regions.default_region));
assert.ok(bundles[regions.default_locale]);
const deployment = read("deployment.json");
assert.ok(regions.regions.includes(deployment.region));
assert.ok(
  Object.hasOwn(profiles, deployment.profile),
  "Unknown deployment profile",
);
for (const code of regions.regions) {
  const region = read(`regions/${code}.json`);
  assert.equal(region.code, code);
  assert.equal(typeof region.enabled, "boolean");
  if (code === deployment.region) assert.ok(region.enabled);
  if (code === regions.default_region) {
    assert.ok(region.enabled);
    assert.equal(region.locale.default, regions.default_locale);
  }
  for (const config of [
    region.locale,
    ...Object.values(profiles).map(
      (profile) => profile.locale ?? region.locale,
    ),
  ]) {
    assert.ok(Array.isArray(config.supported) && config.supported.length);
    assert.equal(new Set(config.supported).size, config.supported.length);
    assert.ok(config.supported.includes(config.default));
    for (const locale of config.supported)
      assert.ok(bundles[locale], `Missing ${locale}`);
  }
}
console.log(
  `i18n: ${Object.keys(baseline).length} matching keys × ${Object.keys(bundles).length} locales; regions and profiles valid.`,
);

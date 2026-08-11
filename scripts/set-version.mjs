#!/usr/bin/env node
/**
 * Set the app version in every file that carries it.
 *
 * The version lives in three places, and CI refuses to build a release when a
 * tag disagrees with them. Editing them by hand is how that gets forgotten, so
 * this does all three at once:
 *
 *   npm run set-version 0.2.2
 *   git commit -am "Release v0.2.2"
 *   git tag v0.2.2 && git push origin main --tags
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run set-version <major.minor.patch>   e.g. 0.2.2");
  process.exit(1);
}

/** Rewrite JSON without disturbing the rest of the file's shape. */
function bumpJson(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const previous = parsed.version;
  parsed.version = version;
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
  return previous;
}

/**
 * Only the first `version = "..."` line, which is the package's own — later
 * ones belong to dependency tables and must not be touched.
 */
function bumpToml(path) {
  const text = readFileSync(path, "utf8");
  const previous = text.match(/^version = "(.+)"$/m)?.[1];
  writeFileSync(path, text.replace(/^version = ".+"$/m, `version = "${version}"`));
  return previous;
}

const changed = [
  ["package.json", bumpJson("package.json")],
  ["src-tauri/tauri.conf.json", bumpJson("src-tauri/tauri.conf.json")],
  ["src-tauri/Cargo.toml", bumpToml("src-tauri/Cargo.toml")],
];

for (const [file, previous] of changed) {
  console.log(`  ${file.padEnd(28)} ${previous} → ${version}`);
}

console.log(`
Next:
  cargo check --manifest-path src-tauri/Cargo.toml   # refreshes Cargo.lock
  git commit -am "Release v${version}"
  git tag v${version} && git push origin main --tags`);

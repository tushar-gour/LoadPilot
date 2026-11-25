import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Source convention guard, not a parser or a semantic SOLID proof.
test("Production modules declare at most one top-level class per file", () => {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => path.endsWith(".ts"));
  for (const file of files) {
    const source = readFileSync(new URL(file.split("\\").join("/"), root), "utf8");
    const classes = source.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+/gm) ?? [];
    assert.ok(classes.length <= 1, `${file}: ${classes.length} classes`);
  }
});

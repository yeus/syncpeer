import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const icon = fs.readFileSync(new URL("../icon.svg", import.meta.url), "utf8");
const pathGeometry = [...icon.matchAll(/<path[\s\S]*?\sd="([^"]+)"/g)]
  .map((match) => match[1].replace(/\s+/g, " ").trim());

test("keeps the existing Syncpeer icon geometry", () => {
  assert.equal(pathGeometry.length, 4);
  assert.equal(
    createHash("sha256").update(JSON.stringify(pathGeometry)).digest("hex"),
    "b17c76ed1bf0b29e467d060c4f13ab70178158ac00de48db8e9f734bf450289e",
  );
});

test("uses a white background, blue ship and cargo, and orange exhaust", () => {
  assert.match(icon, /fill="#ffffff"/i);
  assert.match(icon, /#2a3548/i);
  assert.match(icon, /#f78f3b/i);
  assert.match(icon, /linearGradient[^>]+gradientUnits="userSpaceOnUse"/i);
});

#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(ROOT, "apps", "desktop", "assets", "icon.png");
const SIZE = 256;

const COLORS = Object.freeze({
  transparent: [0, 0, 0, 0],
  paper: [242, 237, 223, 255],
  ink: [26, 24, 21, 255],
  accent: [167, 71, 51, 255]
});

const png = new PNG({ width: SIZE, height: SIZE, colorType: 6 });

function pixel(x, y, color) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const offset = (y * SIZE + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = color[3];
}

function fillRect(left, top, right, bottom, color) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) pixel(x, y, color);
  }
}

function fillCircle(cx, cy, radius, color) {
  const radiusSquared = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radiusSquared) pixel(x, y, color);
    }
  }
}

function fillRoundedTile() {
  const inset = 9;
  const edge = SIZE - 1 - inset;
  const radius = 41;
  const near = inset + radius;
  const far = edge - radius;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let inside = x >= inset && x <= edge && y >= inset && y <= edge;
      if (inside && (x < near || x > far) && (y < near || y > far)) {
        const cx = x < near ? near : far;
        const cy = y < near ? near : far;
        const dx = x - cx;
        const dy = y - cy;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      pixel(x, y, inside ? COLORS.paper : COLORS.transparent);
    }
  }
}

fillRoundedTile();

// Existing Interview brand mark, scaled from the app's 32×32 SVG.
fillRect(79, 79, 119, 87, COLORS.ink);
fillRect(79, 79, 87, 119, COLORS.ink);
fillRect(137, 169, 177, 177, COLORS.ink);
fillRect(169, 137, 177, 177, COLORS.ink);
fillCircle(128, 128, 10, COLORS.accent);

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, PNG.sync.write(png));

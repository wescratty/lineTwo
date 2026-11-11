#!/usr/bin/env node
// Push a rendered episode to Line 2 for review.
//
//   node scripts/push-render.mjs "path/to/S2E3.mp3" "S2E3 - draft 2"
//
// Needs two environment variables:
//   LINE2_URL    e.g. https://line-two-dev.pages.dev
//   LINE2_TOKEN  the API token set on the server
//
// Prints the review link. Opening that link goes straight to the episode.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const [file, titleArg] = process.argv.slice(2);
const base = (process.env.LINE2_URL || "").replace(/\/$/, "");
const token = process.env.LINE2_TOKEN;

if (!file || !base || !token) {
  console.error('Usage: LINE2_URL=... LINE2_TOKEN=... node scripts/push-render.mjs <audio file> ["title"]');
  process.exit(1);
}

const types = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg" };
const title = titleArg || basename(file, extname(file));
const body = await readFile(file);

const res = await fetch(`${base}/api/episodes?title=${encodeURIComponent(title)}`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": types[extname(file).toLowerCase()] || "application/octet-stream",
  },
  body,
});

if (!res.ok) {
  console.error(`Upload failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const episode = await res.json();
console.log(`Uploaded "${episode.title}" (${(episode.size / 1e6).toFixed(1)} MB), id ${episode.id}`);
console.log(`Review link: ${base}/?e=${episode.id}`);

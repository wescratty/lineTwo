#!/usr/bin/env node
// Pull review notes for an episode as markdown.
//
//   node scripts/pull-notes.mjs latest            # newest episode still in review
//   node scripts/pull-notes.mjs 1a2b3c4d notes.md  # by id, written to a file
//
// Needs LINE2_URL and LINE2_TOKEN (see push-render.mjs).

import { writeFile } from "node:fs/promises";

const [id = "latest", outFile] = process.argv.slice(2);
const base = (process.env.LINE2_URL || "").replace(/\/$/, "");
const token = process.env.LINE2_TOKEN;

if (!base || !token) {
  console.error("Usage: LINE2_URL=... LINE2_TOKEN=... node scripts/pull-notes.mjs [id|latest] [out.md]");
  process.exit(1);
}

const res = await fetch(`${base}/api/episodes/${id}/notes?format=md`, {
  headers: { authorization: `Bearer ${token}` },
});

if (!res.ok) {
  console.error(`Couldn't get notes: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const markdown = await res.text();
if (outFile) {
  await writeFile(outFile, markdown);
  console.log(`Wrote ${outFile}`);
} else {
  process.stdout.write(markdown);
}

# Line 2

"Caller on line 2." The product name is Line 2; raising your hand is the action.

Listen to an episode, tap once, say your note. The note is saved with its timestamp
and the show picks up where it left off. This is **Note mode v1**: the review tool
for The Last Prompt, and the first of three planned modes (Note, Choose, Ask).

## What it does

- Plays an episode from the server, a local audio file, or a pasted mp3 link.
- **Raise hand**: one tap pauses the show and records. It stops by itself when you
  stop talking (or tap again), saves the note at that timestamp, backs up two
  seconds and resumes.
- **Marker**: a timestamp with no voice. Also works from the lock screen or a
  headset: "next track" drops a marker, "previous track" jumps back 15 seconds.
- Notes list: tap a timestamp to jump there, hear the clip, type or fix the text.
- Notes sync to the server and come back out as a markdown checklist.
- Works without a server too ("this device only"): notes stay in the browser and
  can be copied or downloaded as markdown.

## Layout

    public/                  the page (plain HTML, CSS, JS; no build step)
    functions/api/[[path]].ts  the API (Cloudflare Pages Function, TypeScript)
    scripts/push-render.mjs  upload a render, print the review link
    scripts/pull-notes.mjs   fetch an episode's notes as markdown
    wrangler.toml            Cloudflare config: R2 bucket + Workers AI

## Run locally

    npm install
    cp .dev.vars.example .dev.vars      # set API_TOKEN to anything
    npm run dev                         # http://localhost:8788

Then open `http://localhost:8788/#t=<your token>` once. The token is remembered.

Local dev with the `[ai]` block in `wrangler.toml` needs `wrangler login`
(transcription always runs on Cloudflare). Comment the block out to run fully
offline; voice notes then keep their clip but have no text.

## Deploy to Cloudflare

1. Create an R2 bucket named `line-two`.
2. Create a Pages project from this repo (build command: none, output: `public`).
3. Add a secret `API_TOKEN` (a long random string) to the project.
4. Open `https://<your-site>/#t=<API_TOKEN>` once on each device, then
   "Add to Home Screen" on the phone.

## The review loop

    # after a render
    LINE2_URL=https://<your-site> LINE2_TOKEN=<token> \
      node scripts/push-render.mjs "S2E3.mp3" "S2E3 draft 2"
    # -> prints a review link; the episode also shows as "Ready for review" in the app

    # after listening
    node scripts/pull-notes.mjs latest notes/S2E3.md

## API

All routes need the token (`Authorization: Bearer` header or `?t=`), except health.

| Method | Path | What |
|---|---|---|
| GET | `/api/health` | server up, token valid, transcription on |
| GET | `/api/episodes` | list, newest first |
| PUT | `/api/episodes?title=` | upload; body is the audio file |
| GET/PATCH/DELETE | `/api/episodes/:id` | read, rename or mark reviewed, delete |
| GET | `/api/episodes/:id/audio` | audio with byte ranges |
| GET | `/api/episodes/:id/notes` | notes as JSON, or `?format=md` |
| POST | `/api/episodes/:id/notes` | add a note: form fields `id`, `t`, `text`, `audio` |
| PATCH/DELETE | `/api/episodes/:id/notes/:noteId` | edit text or done flag, delete |
| GET | `/api/episodes/:id/notes/:noteId/clip` | the recorded voice clip |

`:id` can be `latest`: the newest episode not yet marked reviewed.

## Limits to know

- Uploads go through one request, so the plan's request size cap applies
  (about 100 MB on the free plan when this was written; check current limits).
- One shared token, one user. Fine for a dev link; not for the public.

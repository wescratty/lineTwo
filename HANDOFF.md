# HANDOFF: Line 2 (2026-11-11)

## Where things stand

Note mode v1 is built and tested locally. It is in GitHub (wescratty/lineTwo) as a PR from feature/note-mode-v1. Not yet on Cloudflare.
Next: Wes reviews and merges the PR, then we set up a dev link on Cloudflare.

## Decisions so far

- Product: an interactive player with three modes on one primitive
  (voice + timestamp + agent): **Note** (review notes), **Choose** (branching
  stories), **Ask** (AI-answered listener questions, host opt-in, real host stingers,
  labelled agent voice, Claude as the default agent).
- Build order: Note first (Wes is the user, on The Last Prompt), then Choose, then Ask.
- Stack: TypeScript. Thin clients, logic on the server. Web app first on Cloudflare
  (Pages + Functions + R2 + Workers AI), then React Native with Expo for the phone.
- Git rule: never commit to master. Feature branch per change, merged by PR.

## Tested (local wrangler dev + headless Chrome with a fake microphone)

- Token auth (401 without or with a wrong token), access link `/#t=TOKEN`.
- Upload via push-render.mjs, byte-identical download, range requests (206/416).
- Notes: add text, add voice clip, marker, idempotent re-send, edit, delete,
  markdown export via pull-notes.mjs, mark reviewed, `latest` alias.
- Page: episode list, `?e=latest` deep link, play, raise hand (pauses, records,
  saves, syncs, resumes two seconds back), marker, notes list.

## NOT tested: needs Wes's real devices and account

1. **Transcription.** Workers AI Whisper can't run in the build sandbox. The code
   tries `whisper-large-v3-turbo` then falls back to `whisper`. iPhone records
   `audio/mp4`; confirm Whisper accepts it.
2. **iPhone Safari behaviour**: microphone prompt, auto-stop on silence in a noisy
   place (threshold adapts to background noise but needs tuning on a job site),
   audio continuing with the screen locked.
3. **Lock-screen / headset marker** (Media Session "next track"). Should work on
   iOS but is unverified.
4. Deploy steps in README (R2 bucket, Pages project, API_TOKEN secret).

## Known limits of the web version

- A locked phone cannot record a voice note from a web page. Locked/gloved use gets
  markers only (headset double press). Real hands-free voice notes need the
  native app (the Expo step).
- No push notifications yet. Needs the deployed domain and an installed
  home-screen app on iOS.
- Cloud Claude sessions can't reach arbitrary sites, so push-render/pull-notes
  must run from Wes's computer (or a session linked to it).

## Next steps, in order

1. Wes reviews and merges the PR.
2. Cloudflare: bucket, Pages project, API_TOKEN, dev link. Test items 1 to 3 above.
3. Wire the Last Prompt render step to call push-render.mjs, and the edit step to
   call pull-notes.mjs.
4. Notification when a render is ready.
5. Then decide: Expo app for locked-phone voice notes, or Choose mode.

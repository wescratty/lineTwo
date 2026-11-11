// Line 2 API - one catch-all Pages Function.
//
// Storage layout in the R2 bucket:
//   episodes/<id>.json      episode metadata
//   audio/<id>              the episode audio
//   notes/<id>.json         array of notes for that episode
//   clips/<id>/<noteId>     the spoken note, as recorded
//
// Every route except /api/health needs the API token, sent either as
// "Authorization: Bearer <token>" or as ?t=<token> (audio tags can't send headers).

interface Env {
  BUCKET: R2Bucket;
  AI?: Ai;
  API_TOKEN?: string;
}

interface Episode {
  id: string;
  title: string;
  createdAt: string;
  size: number;
  type: string;
  reviewed: boolean;
}

interface Note {
  id: string;
  t: number; // seconds into the episode
  text: string;
  createdAt: string;
  hasClip: boolean;
  clipType?: string;
  done: boolean;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (status: number, error: string): Response => json({ error }, status);

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const authed = isAuthed(request, url, env);

  if (parts[0] === "health") {
    return json({ ok: true, authed, transcribe: Boolean(env.AI) });
  }
  if (!env.API_TOKEN) return fail(500, "API_TOKEN is not set on the server");
  if (!authed) return fail(401, "unauthorized");

  try {
    return await route(request, url, env, parts);
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : String(err));
  }
};

function isAuthed(request: Request, url: URL, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("t") ?? "";
  return safeEqual(given, env.API_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function route(request: Request, url: URL, env: Env, parts: string[]): Promise<Response> {
  const method = request.method;
  if (parts[0] !== "episodes") return fail(404, "not found");

  // /api/episodes
  if (parts.length === 1) {
    if (method === "GET") return json(await listEpisodes(env));
    if (method === "PUT" || method === "POST") return uploadEpisode(request, url, env);
    return fail(405, "method not allowed");
  }

  const epId = parts[1] === "latest" ? await latestId(env) : parts[1];
  if (!epId) return fail(404, "no episodes yet");
  const episode = await getEpisode(env, epId);
  if (!episode) return fail(404, "episode not found");

  // /api/episodes/:id
  if (parts.length === 2) {
    if (method === "GET") return json(episode);
    if (method === "PATCH") {
      const body = (await request.json()) as Partial<Episode>;
      if (typeof body.title === "string") episode.title = body.title;
      if (typeof body.reviewed === "boolean") episode.reviewed = body.reviewed;
      await putJson(env, `episodes/${epId}.json`, episode);
      return json(episode);
    }
    if (method === "DELETE") {
      const clips = await env.BUCKET.list({ prefix: `clips/${epId}/` });
      await env.BUCKET.delete([
        `episodes/${epId}.json`,
        `audio/${epId}`,
        `notes/${epId}.json`,
        ...clips.objects.map((o) => o.key),
      ]);
      return json({ deleted: epId });
    }
    return fail(405, "method not allowed");
  }

  // /api/episodes/:id/audio
  if (parts[2] === "audio" && method === "GET") {
    return serveObject(request, env, `audio/${epId}`, episode.type);
  }

  // /api/episodes/:id/notes...
  if (parts[2] === "notes") {
    const notes = await loadNotes(env, epId);

    if (parts.length === 3) {
      if (method === "GET") {
        if (url.searchParams.get("format") === "md") {
          return new Response(toMarkdown(episode, notes), {
            headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return json({ episode, notes });
      }
      if (method === "POST") return addNote(request, env, epId, notes);
      return fail(405, "method not allowed");
    }

    const note = notes.find((n) => n.id === parts[3]);
    if (!note) return fail(404, "note not found");

    if (parts[4] === "clip" && method === "GET") {
      return serveObject(request, env, `clips/${epId}/${note.id}`, note.clipType ?? "audio/webm");
    }
    if (parts.length === 4 && method === "PATCH") {
      const body = (await request.json()) as Partial<Note>;
      if (typeof body.text === "string") note.text = body.text;
      if (typeof body.done === "boolean") note.done = body.done;
      await saveNotes(env, epId, notes);
      return json(note);
    }
    if (parts.length === 4 && method === "DELETE") {
      await saveNotes(env, epId, notes.filter((n) => n.id !== note.id));
      if (note.hasClip) await env.BUCKET.delete(`clips/${epId}/${note.id}`);
      return json({ deleted: note.id });
    }
  }

  return fail(404, "not found");
}

// ---------- episodes ----------

async function listEpisodes(env: Env): Promise<Episode[]> {
  const listed = await env.BUCKET.list({ prefix: "episodes/" });
  const episodes = await Promise.all(
    listed.objects.map(async (o) => {
      const obj = await env.BUCKET.get(o.key);
      return obj ? ((await obj.json()) as Episode) : null;
    }),
  );
  return episodes
    .filter((e): e is Episode => e !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Newest episode that still needs review, or the newest of all. */
async function latestId(env: Env): Promise<string | null> {
  const all = await listEpisodes(env);
  return (all.find((e) => !e.reviewed) ?? all[0])?.id ?? null;
}

async function getEpisode(env: Env, id: string): Promise<Episode | null> {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  const obj = await env.BUCKET.get(`episodes/${id}.json`);
  return obj ? ((await obj.json()) as Episode) : null;
}

/** Upload: the request body is the audio file itself. ?title=...  */
async function uploadEpisode(request: Request, url: URL, env: Env): Promise<Response> {
  if (!request.body) return fail(400, "send the audio file as the request body");
  const type = request.headers.get("content-type") || "audio/mpeg";
  const id = crypto.randomUUID().slice(0, 8);

  // R2 needs a known length to accept a stream; buffer when the client didn't send one.
  const hasLength = request.headers.has("content-length");
  const body = hasLength ? request.body : await request.arrayBuffer();
  const stored = await env.BUCKET.put(`audio/${id}`, body, { httpMetadata: { contentType: type } });

  const episode: Episode = {
    id,
    title: url.searchParams.get("title") || `Untitled ${id}`,
    createdAt: new Date().toISOString(),
    size: stored.size,
    type,
    reviewed: false,
  };
  await putJson(env, `episodes/${id}.json`, episode);
  return json(episode, 201);
}

// ---------- notes ----------

async function loadNotes(env: Env, epId: string): Promise<Note[]> {
  const obj = await env.BUCKET.get(`notes/${epId}.json`);
  return obj ? ((await obj.json()) as Note[]) : [];
}

async function saveNotes(env: Env, epId: string, notes: Note[]): Promise<void> {
  notes.sort((a, b) => a.t - b.t);
  await putJson(env, `notes/${epId}.json`, notes);
}

/**
 * Add (or re-send) a note. Multipart form: id, t, text?, audio?.
 * The client makes the id, so a retry after a dropped connection can't duplicate a note.
 */
async function addNote(request: Request, env: Env, epId: string, notes: Note[]): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("id") || crypto.randomUUID());
  if (!/^[a-z0-9-]+$/i.test(id)) return fail(400, "bad note id");
  const t = Number(form.get("t"));
  if (!Number.isFinite(t) || t < 0) return fail(400, "t must be seconds into the episode");

  let text = String(form.get("text") || "").trim();
  const audio = form.get("audio") as unknown;
  let hasClip = false;
  let clipType: string | undefined;

  if (audio instanceof Blob && audio.size > 0) {
    const buf = await audio.arrayBuffer();
    clipType = audio.type || "audio/webm";
    await env.BUCKET.put(`clips/${epId}/${id}`, buf, { httpMetadata: { contentType: clipType } });
    hasClip = true;
    if (!text) text = await transcribe(env, buf);
  }

  const existing = notes.find((n) => n.id === id);
  const note: Note = {
    id,
    t,
    text: text || existing?.text || "",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    hasClip: hasClip || Boolean(existing?.hasClip),
    clipType: clipType ?? existing?.clipType,
    done: existing?.done ?? false,
  };
  await saveNotes(env, epId, [...notes.filter((n) => n.id !== id), note]);
  return json(note, existing ? 200 : 201);
}

/** Speech to text. Returns "" if transcription is off or fails; the clip is kept either way. */
async function transcribe(env: Env, buf: ArrayBuffer): Promise<string> {
  if (!env.AI) return "";
  const ai = env.AI as unknown as { run(model: string, input: unknown): Promise<{ text?: string }> };
  try {
    const out = await ai.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(buf), language: "en" });
    return (out.text ?? "").trim();
  } catch {
    try {
      const out = await ai.run("@cf/openai/whisper", { audio: [...new Uint8Array(buf)] });
      return (out.text ?? "").trim();
    } catch {
      return "";
    }
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function toMarkdown(episode: Episode, notes: Note[]): string {
  const lines = [
    `# Review notes: ${episode.title}`,
    "",
    `Episode id: ${episode.id} | uploaded ${episode.createdAt} | review ${episode.reviewed ? "finished" : "still open"}`,
    "",
  ];
  if (!notes.length) lines.push("_No notes._");
  for (const n of notes) {
    const text = n.text || (n.hasClip ? "(voice clip, not transcribed)" : "(marker)");
    lines.push(`- [${n.done ? "x" : " "}] **${formatTime(n.t)}** ${text}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- R2 helpers ----------

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

/** Serve an object with byte-range support (phones won't play or seek audio without it). */
async function serveObject(request: Request, env: Env, key: string, type: string): Promise<Response> {
  const head = await env.BUCKET.head(key);
  if (!head) return fail(404, "not found");
  const size = head.size;
  const headers = new Headers({
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });

  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (match && (match[1] || match[2])) {
    let start: number;
    let end: number;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (start > end || start >= size) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const obj = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return fail(404, "not found");
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return fail(404, "not found");
  headers.set("content-length", String(size));
  return new Response(obj.body, { headers });
}

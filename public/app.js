// Line 2 - Note mode. ("Caller on line 2.")
// Listen to an episode, tap once, say your note. It is saved with the timestamp,
// and the show picks up where it left off.
//
// Two ways to run:
//   synced  - the page is served by the Cloudflare project and has an access token.
//             Episodes come from the server; notes sync there (and get transcribed).
//   local   - no server or no token. Open a file or paste a link; notes stay in this
//             browser and can be copied out as markdown.

const $ = (id) => document.getElementById(id);
const audio = $("audio");

// ---------- small helpers ----------

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const TOKEN_KEY = "rh-token";
// An access link looks like https://site/#t=TOKEN. Opening it once stores the token,
// so it never has to be typed.
{
  const match = location.hash.match(/(?:^#|&)t=([^&]+)/);
  if (match) {
    store.set(TOKEN_KEY, decodeURIComponent(match[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
}
const token = () => store.get(TOKEN_KEY) || "";

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const newId = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/** Short tone, so you know what happened without looking at the screen. */
function beep(frequency = 880, ms = 120) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
    osc.onended = () => ctx.close();
  } catch { /* no audio context: skip the cue */ }
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res;
}

// ---------- local note storage (IndexedDB) ----------
// Every note lands here first, so a dropped connection never loses one.

const db = (() => {
  let opening;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("line-two", 1);
      req.onupgradeneeded = () => {
        const notes = req.result.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("ep", "ep");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, work) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("notes", mode);
      const req = work(tx.objectStore("notes"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  const quiet = (promise, fallback) => promise.catch(() => fallback);
  return {
    put: (note) => quiet(run("readwrite", (s) => s.put(note))),
    del: (id) => quiet(run("readwrite", (s) => s.delete(id))),
    byEpisode: (ep) => quiet(run("readonly", (s) => s.index("ep").getAll(ep)), []),
  };
})();

// ---------- state ----------

const state = {
  synced: false,     // server reachable and token accepted
  episodes: [],      // server episodes
  ep: null,          // { id, title, src, remote, reviewed }
  notes: [],
  recording: null,   // active raise-hand recording
};

// ---------- home ----------

async function init() {
  try {
    const health = await (await fetch("/api/health", { headers: { authorization: `Bearer ${token()}` } })).json();
    state.synced = Boolean(health.ok && health.authed);
    $("mode").textContent = state.synced ? "synced" : health.ok ? "needs access link" : "this device only";
  } catch {
    $("mode").textContent = "this device only";
  }

  if (state.synced) {
    try {
      state.episodes = await (await api("/episodes")).json();
    } catch (err) {
      toast(`Couldn't load episodes: ${err.message}`);
    }
  }
  renderHome();

  // Deep links: /?e=<id> or /?e=latest (newest episode still waiting for review).
  const wanted = new URLSearchParams(location.search).get("e");
  if (wanted && state.episodes.length) {
    const ep =
      wanted === "latest"
        ? state.episodes.find((e) => !e.reviewed) || state.episodes[0]
        : state.episodes.find((e) => e.id === wanted);
    if (ep) openEpisode(remoteEpisode(ep));
  }
}

const remoteEpisode = (e) => ({
  id: e.id,
  title: e.title,
  src: `/api/episodes/${e.id}/audio?t=${encodeURIComponent(token())}`,
  remote: true,
  reviewed: e.reviewed,
});

function renderHome() {
  const latest = state.episodes.find((e) => !e.reviewed);
  const latestBox = $("latest");
  latestBox.replaceChildren();
  if (latest) {
    const card = document.createElement("button");
    card.className = "latest-card";
    card.innerHTML = "<small>Ready for review</small><strong></strong>";
    card.querySelector("strong").textContent = latest.title;
    card.onclick = () => openEpisode(remoteEpisode(latest));
    latestBox.append(card);
  }

  const list = $("episodes");
  list.replaceChildren();
  for (const e of state.episodes) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("span");
    title.textContent = e.title;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = new Date(e.createdAt).toLocaleDateString();
    if (!e.reviewed) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = " ● review";
      meta.append(badge);
    }
    button.append(title, meta);
    button.onclick = () => openEpisode(remoteEpisode(e));
    li.append(button);
    list.append(li);
  }
}

$("file").onchange = (event) => {
  const file = event.target.files[0];
  if (!file) return;
  openEpisode({
    id: `local:${file.name}:${file.size}`,
    title: file.name.replace(/\.[^.]+$/, ""),
    src: URL.createObjectURL(file),
    remote: false,
  });
};

$("urlform").onsubmit = (event) => {
  event.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  let title = url;
  try { title = decodeURIComponent(new URL(url).pathname.split("/").pop()) || url; } catch { /* keep raw */ }
  openEpisode({ id: `url:${url}`, title, src: url, remote: false });
};

$("back").onclick = () => {
  audio.pause();
  $("player").hidden = true;
  $("home").hidden = false;
  history.replaceState(null, "", "/");
};

// ---------- player ----------

async function openEpisode(ep) {
  state.ep = ep;
  $("home").hidden = true;
  $("player").hidden = false;
  $("title").textContent = ep.title;
  $("reviewed").hidden = !ep.remote;
  $("reviewed").textContent = ep.reviewed ? "Reopen review" : "Finish review";
  if (ep.remote) history.replaceState(null, "", `/?e=${ep.id}`);

  audio.src = ep.src;
  audio.playbackRate = Number(store.get("rh-speed")) || 1;
  $("speed").textContent = `${audio.playbackRate}×`;
  audio.addEventListener(
    "loadedmetadata",
    () => {
      const saved = Number(store.get(`rh-pos:${ep.id}`));
      if (saved > 0 && saved < audio.duration - 5) audio.currentTime = saved;
    },
    { once: true },
  );

  setUpLockScreenControls(ep);
  await loadNotes();
}

audio.addEventListener("error", () => {
  if (state.ep) toast("Couldn't play that audio. Check the link or file.");
});

$("play").onclick = () => (audio.paused ? audio.play() : audio.pause());
$("rew").onclick = () => skip(-15);
$("fwd").onclick = () => skip(15);
$("speed").onclick = () => {
  const speeds = [1, 1.25, 1.5, 2];
  audio.playbackRate = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
  $("speed").textContent = `${audio.playbackRate}×`;
  store.set("rh-speed", String(audio.playbackRate));
};

function skip(seconds) {
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + seconds), audio.duration || Infinity);
}

audio.addEventListener("play", () => ($("play").textContent = "❚❚"));
audio.addEventListener("pause", () => ($("play").textContent = "▶"));
audio.addEventListener("durationchange", () => {
  $("seek").max = Math.floor(audio.duration || 0);
  $("dur").textContent = formatTime(audio.duration);
});

let lastSavedPosition = 0;
audio.addEventListener("timeupdate", () => {
  if (!seeking) $("seek").value = Math.floor(audio.currentTime);
  $("cur").textContent = formatTime(audio.currentTime);
  if (state.ep && Math.abs(audio.currentTime - lastSavedPosition) > 5) {
    lastSavedPosition = audio.currentTime;
    store.set(`rh-pos:${state.ep.id}`, String(Math.floor(audio.currentTime)));
  }
});

let seeking = false;
$("seek").oninput = () => {
  seeking = true;
  $("cur").textContent = formatTime(Number($("seek").value));
};
$("seek").onchange = () => {
  audio.currentTime = Number($("seek").value);
  seeking = false;
};

/**
 * Lock screen and headset buttons. "Next track" is repurposed as "drop a marker",
 * because it is the one control that works with the phone locked and gloves on
 * (a double press on most headsets). "Previous track" jumps back 15 seconds.
 */
function setUpLockScreenControls(ep) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: "Line 2", album: "For review" });
  const on = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
  };
  on("play", () => audio.play());
  on("pause", () => audio.pause());
  on("previoustrack", () => skip(-15));
  on("nexttrack", () => dropMarker());
}

// ---------- raise hand ----------

$("hand").onclick = () => (state.recording ? stopRecording() : raiseHand());
$("marker").onclick = () => dropMarker();

function dropMarker() {
  if (!state.ep) return;
  addNote(audio.currentTime, null);
  beep(660, 90);
  toast(`Marker at ${formatTime(audio.currentTime)}`);
}

function setHand(mode) {
  const hand = $("hand");
  hand.classList.remove("listening", "saving");
  if (mode === "listening") {
    hand.classList.add("listening");
    $("handLabel").textContent = "● Listening…";
    $("handHint").textContent = "Stop talking to finish, or tap.";
  } else {
    $("handLabel").textContent = "✋ Raise hand";
    $("handHint").textContent = "Tap once, talk, stop talking. The show resumes itself.";
  }
}

async function raiseHand() {
  if (!state.ep) return;
  const t = audio.currentTime;
  const wasPlaying = !audio.paused;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    addNote(t, null);
    toast("No microphone access. Dropped a marker instead.");
    return;
  }

  audio.pause();
  beep();

  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
    (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type),
  );
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);

  // Watch the microphone level to tell when you've stopped talking.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const started = performance.now();
  let heard = false;
  let lastVoice = started;
  let smoothed = 0;
  let floor = Infinity; // background noise level, so a loud job site doesn't read as speech

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const rms = Math.sqrt(sum / samples.length);
    smoothed = smoothed * 0.7 + rms * 0.3;
    const now = performance.now();
    if (now - started > 250) floor = Math.min(floor, smoothed);
    const threshold = Math.max(0.015, (Number.isFinite(floor) ? floor : 0) * 2.5);

    $("level").style.width = `${Math.min(100, rms * 500)}%`;
    if (smoothed > threshold && now - started > 250) {
      heard = true;
      lastVoice = now;
    }
    const gaveUp = !heard && now - started > 7000;       // never said anything
    const finished = heard && now - lastVoice > 2200;    // said something, then went quiet
    const tooLong = now - started > 60000;
    if (gaveUp || finished || tooLong) stopRecording();
  }, 100);

  recorder.onstop = () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    ctx.close();
    state.recording = null;
    setHand("idle");

    if (heard && chunks.length) {
      addNote(t, new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
      toast(`Note saved at ${formatTime(t)}`);
    } else {
      addNote(t, null);
      toast("Didn't hear anything. Dropped a marker instead.");
    }
    beep(660, 90);

    // Back up two seconds so you re-enter with a little context.
    audio.currentTime = Math.max(0, t - 2);
    if (wasPlaying) audio.play().catch(() => {});
  };

  state.recording = { recorder };
  setHand("listening");
  recorder.start();
}

function stopRecording() {
  const recorder = state.recording?.recorder;
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

// ---------- notes ----------

async function loadNotes() {
  const ep = state.ep;
  const local = await db.byEpisode(ep.id);
  let notes = local;

  if (ep.remote) {
    try {
      const { notes: remote } = await (await api(`/episodes/${ep.id}/notes`)).json();
      const onServer = new Set(remote.map((n) => n.id));
      const waiting = local.filter((n) => !onServer.has(n.id));
      local.filter((n) => onServer.has(n.id)).forEach((n) => db.del(n.id));
      notes = [...remote.map((n) => ({ ...n, ep: ep.id, synced: true })), ...waiting];
      waiting.forEach(syncNote); // anything that didn't make it up last time
    } catch {
      toast("Offline: showing notes saved on this device.");
    }
  }
  if (state.ep !== ep) return;
  state.notes = notes;
  renderNotes();
}

async function addNote(t, blob) {
  const note = {
    id: newId(),
    ep: state.ep.id,
    t: Math.round(t * 10) / 10,
    text: "",
    createdAt: new Date().toISOString(),
    done: false,
    hasClip: Boolean(blob),
    blob: blob || undefined,
    synced: false,
  };
  state.notes.push(note);
  renderNotes();
  await db.put(note);
  if (state.ep.remote) syncNote(note);
}

async function syncNote(note) {
  const form = new FormData();
  form.set("id", note.id);
  form.set("t", String(note.t));
  if (note.text) form.set("text", note.text);
  if (note.blob) form.set("audio", note.blob, "clip");
  const textWhenSent = note.text;
  try {
    const saved = await (await api(`/episodes/${note.ep}/notes`, { method: "POST", body: form })).json();
    const editedMeanwhile = note.text !== textWhenSent;
    const keepText = note.text;
    Object.assign(note, saved, { synced: true });
    if (editedMeanwhile) {
      note.text = keepText;
      saveText(note);
    }
    await db.del(note.id);
  } catch {
    note.synced = false; // stays on this device; retried next time the episode opens
  }
  renderNotes();
}

function saveText(note) {
  if (state.ep.remote && note.synced) {
    api(`/episodes/${note.ep}/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: note.text }),
    }).catch(() => toast("Couldn't save that edit. Try again when online."));
  } else {
    db.put(note);
  }
}

function removeNote(note) {
  state.notes = state.notes.filter((n) => n !== note);
  db.del(note.id);
  if (state.ep.remote && note.synced) {
    api(`/episodes/${note.ep}/notes/${note.id}`, { method: "DELETE" }).catch(() => toast("Couldn't delete on the server."));
  }
  renderNotes();
}

function clipUrl(note) {
  if (note.blob) return URL.createObjectURL(note.blob);
  return `/api/episodes/${note.ep}/notes/${note.id}/clip?t=${encodeURIComponent(token())}`;
}

function renderNotes() {
  state.notes.sort((a, b) => a.t - b.t);
  const list = $("notes");
  list.replaceChildren();
  $("count").textContent = state.notes.length ? `(${state.notes.length})` : "";

  if (!state.notes.length) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No notes yet. Raise your hand when something needs fixing.";
    list.append(empty);
    return;
  }

  for (const note of state.notes) {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "note-head";
    const stamp = document.createElement("button");
    stamp.className = "stamp";
    stamp.textContent = formatTime(note.t);
    stamp.title = "Jump here";
    stamp.onclick = () => {
      audio.currentTime = Math.max(0, note.t - 3);
      audio.play().catch(() => {});
    };
    const text = document.createElement("span");
    text.className = "note-text";
    if (note.text) {
      text.textContent = note.text;
    } else {
      text.classList.add("empty");
      text.textContent = note.hasClip ? (note.synced || !state.ep.remote ? "Voice note" : "Voice note, transcribing…") : "Marker";
    }
    head.append(stamp, text);

    const actions = document.createElement("div");
    actions.className = "note-actions";
    if (note.hasClip) {
      const play = document.createElement("button");
      play.textContent = "▶ Hear it";
      play.onclick = () => {
        audio.pause();
        new Audio(clipUrl(note)).play().catch(() => toast("Couldn't play the clip."));
      };
      actions.append(play);
    }
    const edit = document.createElement("button");
    edit.textContent = note.text ? "Edit" : "Type it";
    edit.onclick = () => {
      const area = document.createElement("textarea");
      area.value = note.text;
      area.rows = 2;
      text.replaceWith(area);
      area.focus();
      area.onblur = () => {
        note.text = area.value.trim();
        saveText(note);
        renderNotes();
      };
    };
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = () => {
      if (del.dataset.armed) return removeNote(note);
      del.dataset.armed = "1";
      del.textContent = "Tap again to delete";
      setTimeout(() => {
        delete del.dataset.armed;
        del.textContent = "Delete";
      }, 3000);
    };
    actions.append(edit, del);
    if (state.ep.remote && !note.synced) {
      const pending = document.createElement("span");
      pending.className = "pending";
      pending.textContent = "saving…";
      actions.append(pending);
    }

    li.append(head, actions);
    list.append(li);
  }
}

// ---------- export ----------

function notesAsMarkdown() {
  const lines = [`# Review notes: ${state.ep.title}`, ""];
  if (!state.notes.length) lines.push("_No notes._");
  for (const n of state.notes) {
    const text = n.text || (n.hasClip ? "(voice clip, not transcribed)" : "(marker)");
    lines.push(`- [${n.done ? "x" : " "}] **${formatTime(n.t)}** ${text}`);
  }
  return lines.join("\n") + "\n";
}

function downloadNotes() {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([notesAsMarkdown()], { type: "text/markdown" }));
  link.download = `${state.ep.title.replace(/[^\w.-]+/g, "_")}-notes.md`;
  link.click();
}

$("download").onclick = downloadNotes;
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(notesAsMarkdown());
    toast("Notes copied");
  } catch {
    downloadNotes();
  }
};

$("reviewed").onclick = async () => {
  const ep = state.ep;
  try {
    const saved = await (
      await api(`/episodes/${ep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewed: !ep.reviewed }),
      })
    ).json();
    ep.reviewed = saved.reviewed;
    const listed = state.episodes.find((e) => e.id === ep.id);
    if (listed) listed.reviewed = saved.reviewed;
    $("reviewed").textContent = ep.reviewed ? "Reopen review" : "Finish review";
    renderHome();
    toast(ep.reviewed ? "Review finished. Notes are ready to pull." : "Review reopened.");
  } catch (err) {
    toast(`Couldn't update: ${err.message}`);
  }
};

// ---------- keyboard (desk use) ----------

document.addEventListener("keydown", (event) => {
  if (!state.ep || $("player").hidden) return;
  if (/^(INPUT|TEXTAREA)$/.test(event.target.tagName) && event.target.type !== "range") return;
  if (event.code === "Space") {
    event.preventDefault();
    $("play").click();
  } else if (event.key === "n" || event.key === "h") {
    $("hand").click();
  } else if (event.key === "m") {
    dropMarker();
  } else if (event.key === "ArrowLeft") {
    skip(-15);
  } else if (event.key === "ArrowRight") {
    skip(15);
  }
});

init();

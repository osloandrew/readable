/*
How to run locally (recommended):
- In the folder containing index.html, styles.css, scripts.js, and Readable.csv:

Option A (Python 3):
  python -m http.server 8000
  Open: http://localhost:8000

Option B (Node):
  npx serve

This is needed because most browsers block fetch() for local file:// pages.
*/

const CSV_PATH = "Readable.csv";

const AUDIO_DIR = "Audio";
const AUDIO_EXT = "m4a";

const IMAGES_DIR = "Images";
const IMAGE_EXT = "png";

// Keep only one audio playing at a time
let currentlyPlaying = { audio: null, btn: null };

// Cache audio objects (prevents repeated network overhead)
const audioCache = new Map();

// Cache "does this audio exist?" results so we only check once
const audioExistsCache = new Map();

/* -------------------- Audio helpers -------------------- */

function buildAudioUrl(language, sentenceText) {
  // IMPORTANT: sentenceText already includes punctuation like ".".
  // Per your convention, filenames are "[Sentence.].m4a" so we append ".m4a"
  // -> if sentence ends with ".", you get "..m4a", exactly as desired.
  const filename = `${sentenceText}.${AUDIO_EXT}`;
  const path = `${AUDIO_DIR}/${language}/${filename}`;

  // Encode each segment so spaces, Hebrew/Japanese, etc. work in URLs.
  // Keep slashes unencoded.
  return path.split("/").map(encodeURIComponent).join("/");
}

async function audioExists(url) {
  if (audioExistsCache.has(url)) return audioExistsCache.get(url);

  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    const ok = res.ok;
    audioExistsCache.set(url, ok);
    return ok;
  } catch {
    audioExistsCache.set(url, false);
    return false;
  }
}

function getOrCreateAudio(url) {
  if (audioCache.has(url)) return audioCache.get(url);
  const a = new Audio(url);
  a.preload = "none";
  audioCache.set(url, a);
  return a;
}

function stopCurrentAudio() {
  if (currentlyPlaying.audio) {
    currentlyPlaying.audio.pause();
    currentlyPlaying.audio.currentTime = 0;
  }
  if (currentlyPlaying.btn) {
    currentlyPlaying.btn.classList.remove("is-playing");
    currentlyPlaying.btn.textContent = "▶";
  }
  currentlyPlaying = { audio: null, btn: null };
}

function attachAudioButton(playBtn, language, sentence) {
  const url = buildAudioUrl(language, sentence);
  const audio = getOrCreateAudio(url);

  // Wire audio-level listeners once per cached audio object
  if (!audio.__wired) {
    audio.addEventListener("ended", () => {
      if (currentlyPlaying.audio === audio) stopCurrentAudio();
    });

    audio.addEventListener("error", () => {
      audio.__missing = true;
      if (currentlyPlaying.audio === audio) stopCurrentAudio();
    });

    audio.__wired = true;
  }

  playBtn.addEventListener("click", async () => {
    // If lesson playback is running, stop it and switch to manual playback
    if (lessonPlayback.running) stopLessonPlayback();

    // Stop other audio if a different sentence is playing
    if (currentlyPlaying.audio && currentlyPlaying.audio !== audio) {
      stopCurrentAudio();
    }

    // Toggle stop if this exact audio is playing
    if (currentlyPlaying.audio === audio && !audio.paused) {
      stopCurrentAudio();
      return;
    }

    stopCurrentAudio();

    playBtn.classList.add("is-playing");
    playBtn.textContent = "⏸";
    currentlyPlaying = { audio, btn: playBtn };

    try {
      await audio.play();
    } catch {
      audio.__missing = true;
      stopCurrentAudio();
    }
  });
}

/* -------------------- Lesson playback -------------------- */

let lessonPlayback = {
  running: false,
  token: 0,
  btn: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stopLessonPlayback() {
  lessonPlayback.token++; // cancels any in-flight loop
  lessonPlayback.running = false;

  stopCurrentAudio();

  if (lessonPlayback.btn) {
    lessonPlayback.btn.textContent = "Play lesson";
    lessonPlayback.btn.classList.remove("is-playing");
  }
}

async function playOne(url, sentenceBtn) {
  const audio = getOrCreateAudio(url);

  // Stop any other audio + reset old UI
  stopCurrentAudio();

  if (sentenceBtn) {
    sentenceBtn.classList.add("is-playing");
    sentenceBtn.textContent = "⏸";
  }

  currentlyPlaying = { audio, btn: sentenceBtn };
  audio.currentTime = 0;

  return new Promise(async (resolve, reject) => {
    const onEnded = () => cleanup(resolve);
    const onError = () => cleanup(() => reject(new Error("missing")));

    function cleanup(done) {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      done();
    }

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    try {
      await audio.play();
    } catch (e) {
      cleanup(() => reject(e));
    }
  });
}

async function playLessonInOrder(urls, btns, token) {
  for (let i = 0; i < urls.length; i++) {
    if (lessonPlayback.token !== token) return;

    await playOne(urls[i], btns[i] || null);

    // End of sentence will call stopCurrentAudio() via "ended" listener,
    // which also resets the active sentence button UI.

    if (i < urls.length - 1) {
      if (lessonPlayback.token !== token) return;
      await sleep(1000); // 1-second pause between sentences
    }
  }
}

/* -------------------- DOM + state -------------------- */

const els = {
  lessonSelect: document.getElementById("lessonSelect"),
  languageSelect: document.getElementById("languageSelect"),
  helperLanguageSelect: document.getElementById("helperLanguageSelect"),
  prevLessonBtn: document.getElementById("prevLessonBtn"),
  nextLessonBtn: document.getElementById("nextLessonBtn"),
  storyContainer: document.getElementById("storyContainer"),
  metaBar: document.getElementById("metaBar"),
  lessonImageWrap: document.getElementById("lessonImageWrap"),
  lessonImage: document.getElementById("lessonImage"),
};

const STORAGE_KEYS = {
  lesson: "readable.lesson",
  lang: "readable.lang",
  helperLang: "readable.helperLang",
};

let model = {
  lessons: [],
  lessonIds: [],
  languages: [],
  currentLessonId: null,
  currentLanguage: null,
  helperLanguage: null, // null means Off
};

// Used to prevent async button checks from mutating an old render
let renderToken = 0;

/* -------------------- Images -------------------- */

function updateLessonImage(lessonId) {
  if (!els.lessonImageWrap || !els.lessonImage) return;

  const src = `${IMAGES_DIR}/Lesson ${lessonId}.${IMAGE_EXT}`;

  els.lessonImageWrap.style.display = "none";
  els.lessonImage.removeAttribute("src");
  els.lessonImage.alt = "";

  const img = new Image();
  img.onload = () => {
    els.lessonImage.src = src;
    els.lessonImage.alt = `Lesson ${lessonId} illustration`;
    els.lessonImageWrap.style.display = "block";
  };
  img.onerror = () => {
    els.lessonImageWrap.style.display = "none";
  };
  img.src = src;
}

/* -------------------- Init -------------------- */

init();

async function init() {
  hydratePreferences();
  wireUI();

  try {
    const csvText = await fetchText(CSV_PATH);
    const rows = parseCSV(csvText);
    buildModel(rows);
    initializeUIFromModel();
    stopLessonPlayback();
    render();
  } catch (err) {
    console.error(err);
    els.metaBar.textContent = `Error loading CSV: ${String(err)}`;
    els.storyContainer.innerHTML = `
      <div class="line">
        <div class="lineno">!</div>
        <div class="textblock">
          <div class="primary">Could not load "${CSV_PATH}".</div>
          <div class="secondary">
            Ensure the CSV is in the same folder and run a local server (see scripts.js comment).
          </div>
        </div>
      </div>
    `;
  }
}

function hydratePreferences() {
  const savedLesson = localStorage.getItem(STORAGE_KEYS.lesson);
  const savedLang = localStorage.getItem(STORAGE_KEYS.lang);
  const savedHelperLang = localStorage.getItem(STORAGE_KEYS.helperLang);

  model.currentLessonId = savedLesson || null;
  model.currentLanguage = savedLang || null;
  model.helperLanguage = savedHelperLang ? savedHelperLang : null;
}

function persistPreferences() {
  localStorage.setItem(STORAGE_KEYS.lesson, model.currentLessonId ?? "");
  localStorage.setItem(STORAGE_KEYS.lang, model.currentLanguage ?? "");
  if (model.helperLanguage) {
    localStorage.setItem(STORAGE_KEYS.helperLang, model.helperLanguage);
  } else {
    localStorage.removeItem(STORAGE_KEYS.helperLang);
  }
}

function wireUI() {
  els.lessonSelect.addEventListener("change", () => {
    model.currentLessonId = els.lessonSelect.value;
    persistPreferences();
    stopLessonPlayback();
    render();
  });

  els.languageSelect.addEventListener("change", () => {
    model.currentLanguage = els.languageSelect.value;

    // If helper equals main language, force helper Off to avoid redundancy.
    if (model.helperLanguage === model.currentLanguage) {
      model.helperLanguage = null;
      if (els.helperLanguageSelect) els.helperLanguageSelect.value = "";
    }

    persistPreferences();
    stopLessonPlayback();
    render();
  });

  els.helperLanguageSelect.addEventListener("change", () => {
    const v = els.helperLanguageSelect.value;
    model.helperLanguage = v ? v : null;

    // If helper equals main language, force helper Off to avoid redundancy.
    if (model.helperLanguage === model.currentLanguage) {
      model.helperLanguage = null;
      els.helperLanguageSelect.value = "";
    }

    persistPreferences();
    stopLessonPlayback();
    render();
  });

  els.prevLessonBtn.addEventListener("click", () => {
    const idx = model.lessonIds.indexOf(model.currentLessonId);
    if (idx > 0) {
      model.currentLessonId = model.lessonIds[idx - 1];
      els.lessonSelect.value = model.currentLessonId;
      persistPreferences();
      stopLessonPlayback();
      render();
    }
  });

  els.nextLessonBtn.addEventListener("click", () => {
    const idx = model.lessonIds.indexOf(model.currentLessonId);
    if (idx >= 0 && idx < model.modelLessonIdsLengthMinusOne) {
      // placeholder, replaced below
    }
  });

  // Replace the broken placeholder with the original correct logic:
  els.nextLessonBtn.addEventListener("click", () => {
    const idx = model.lessonIds.indexOf(model.currentLessonId);
    if (idx >= 0 && idx < model.lessonIds.length - 1) {
      model.currentLessonId = model.lessonIds[idx + 1];
      els.lessonSelect.value = model.currentLessonId;
      persistPreferences();
      stopLessonPlayback();
      render();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") els.prevLessonBtn.click();
    if (e.key === "ArrowRight") els.nextLessonBtn.click();
  });
}

/* -------------------- Fetch -------------------- */

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  return await res.text();
}

/* -------------------- CSV parsing -------------------- */

function parseCSV(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0) continue;

    const row = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      row[key] = values[c] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur.trim());
        cur = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur.trim());
  return out;
}

/* -------------------- Model -------------------- */

function buildModel(rows) {
  if (rows.length === 0) throw new Error("CSV contains no rows.");

  const allCols = Object.keys(rows[0]);
  const languageCols = allCols.filter(
    (c) => !["Lesson", "Line", "CEFR"].includes(c)
  );

  if (languageCols.length === 0) {
    throw new Error(
      "No language columns found (expected columns besides Lesson/Line/CEFR)."
    );
  }

  const byLesson = new Map();

  for (const r of rows) {
    const lessonId = String(r["Lesson"]).trim();
    const lineNo = Number(String(r["Line"]).trim());
    const cefr = String(r["CEFR"] ?? "").trim();

    if (!lessonId) continue;
    if (!byLesson.has(lessonId)) {
      byLesson.set(lessonId, { lessonId, cefr, lines: [] });
    }

    const texts = {};
    for (const lang of languageCols) {
      texts[lang] = String(r[lang] ?? "").trim();
    }

    byLesson.get(lessonId).lines.push({ lineNo, texts });
  }

  const lessonIds = Array.from(byLesson.keys()).sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  );

  const lessons = lessonIds.map((id) => {
    const lesson = byLesson.get(id);
    lesson.lines.sort((x, y) => x.lineNo - y.lineNo);
    return lesson;
  });

  model.lessons = lessons;
  model.lessonIds = lessonIds;
  model.languages = languageCols;

  if (
    !model.currentLessonId ||
    !model.lessonIds.includes(model.currentLessonId)
  ) {
    model.currentLessonId = model.lessonIds[0];
  }

  if (
    !model.currentLanguage ||
    !model.languages.includes(model.currentLanguage)
  ) {
    model.currentLanguage = model.languages.includes("English")
      ? "English"
      : model.languages[0];
  }

  // Validate helper language if previously saved
  if (model.helperLanguage && !model.languages.includes(model.helperLanguage)) {
    model.helperLanguage = null;
  }
  if (model.helperLanguage === model.currentLanguage) {
    model.helperLanguage = null;
  }
}

function initializeUIFromModel() {
  els.lessonSelect.innerHTML = "";
  for (const id of model.lessonIds) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `Lesson ${id}`;
    els.lessonSelect.appendChild(opt);
  }
  els.lessonSelect.value = model.currentLessonId;

  els.languageSelect.innerHTML = "";
  for (const lang of model.languages) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    els.languageSelect.appendChild(opt);
  }
  els.languageSelect.value = model.currentLanguage;

  // Helper Language: Off + same list
  els.helperLanguageSelect.innerHTML = "";

  const offOpt = document.createElement("option");
  offOpt.value = "";
  offOpt.textContent = "Off";
  els.helperLanguageSelect.appendChild(offOpt);

  for (const lang of model.languages) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    els.helperLanguageSelect.appendChild(opt);
  }

  els.helperLanguageSelect.value = model.helperLanguage
    ? model.helperLanguage
    : "";

  persistPreferences();
}

/* -------------------- Render -------------------- */

function render() {
  renderToken++;
  const myToken = renderToken;

  const lesson = model.lessons.find(
    (l) => l.lessonId === model.currentLessonId
  );
  if (!lesson) return;

  updateLessonImage(lesson.lessonId);

  const idx = model.lessonIds.indexOf(model.currentLessonId);
  els.prevLessonBtn.disabled = idx <= 0;
  els.nextLessonBtn.disabled = idx >= model.lessonIds.length - 1;

  const helperSuffix = model.helperLanguage
    ? ` · Helper: ${model.helperLanguage}`
    : "";

  const cefr = lesson.cefr ? `CEFR ${lesson.cefr}` : "CEFR —";
  els.metaBar.textContent = `Lesson ${lesson.lessonId} · ${cefr} · Language: ${model.currentLanguage}${helperSuffix}`;

  els.storyContainer.innerHTML = "";

  // Always reserve the TOP slot for the Play lesson button (may remain empty)
  const playLessonSlot = document.createElement("div");
  playLessonSlot.className = "play-lesson-slot";
  els.storyContainer.appendChild(playLessonSlot);

  // Prepare per-line bookkeeping so lesson playback can activate the same buttons
  const sentenceUrls = [];
  const sentenceBtns = new Array(lesson.lines.length).fill(null);

  // Render lines immediately; sentence buttons appear only after HEAD confirms
  lesson.lines.forEach((line, i) => {
    const lineEl = document.createElement("div");
    lineEl.className = "line";

    const tb = document.createElement("div");
    tb.className = "textblock";

    const sentence = (line.texts[model.currentLanguage] || "").trim();

    // Row: [reserved button space] [sentence text]
    const textRow = document.createElement("div");
    textRow.className = "textrow";

    // Always reserve a 30x30 slot so text alignment never shifts
    const spacer = document.createElement("div");
    spacer.className = "playbtn-spacer";
    textRow.appendChild(spacer);

    const primary = document.createElement("div");
    primary.className = "primary";
    primary.textContent = sentence;
    textRow.appendChild(primary);

    tb.appendChild(textRow);

    // Helper language line
    if (
      model.helperLanguage &&
      model.helperLanguage !== model.currentLanguage &&
      line.texts[model.helperLanguage]
    ) {
      const secondary = document.createElement("div");
      secondary.className = "secondary";
      secondary.textContent = line.texts[model.helperLanguage];
      tb.appendChild(secondary);
    }

    lineEl.appendChild(tb);
    els.storyContainer.appendChild(lineEl);

    // Track URL for lesson playback + existence checks
    if (!sentence) {
      sentenceUrls.push(null);
      return;
    }

    const url = buildAudioUrl(model.currentLanguage, sentence);
    sentenceUrls.push(url);

    // Add sentence play button only if audio exists (async)
    audioExists(url).then((exists) => {
      if (renderToken !== myToken) return;
      if (!exists) return;

      const playBtn = document.createElement("button");
      playBtn.className = "playbtn";
      playBtn.type = "button";
      playBtn.textContent = "▶";

      spacer.replaceWith(playBtn);
      sentenceBtns[i] = playBtn;

      attachAudioButton(playBtn, model.currentLanguage, sentence);
    });
  });

  // Decide whether to show the Play lesson button:
  // - only if every line has sentence text
  // - and every sentence has audio
  (async () => {
    const tokenAtStart = myToken;

    if (sentenceUrls.some((u) => !u)) return;

    const results = await Promise.all(sentenceUrls.map((u) => audioExists(u)));
    if (renderToken !== tokenAtStart) return;
    if (results.some((x) => !x)) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Play lesson";

    lessonPlayback.btn = btn;

    btn.addEventListener("click", async () => {
      if (lessonPlayback.running) {
        stopLessonPlayback();
        return;
      }

      lessonPlayback.running = true;
      const runToken = ++lessonPlayback.token;

      btn.textContent = "Stop";
      btn.classList.add("is-playing");

      try {
        // During playback, activate each sentence button in order.
        await playLessonInOrder(sentenceUrls, sentenceBtns, runToken);
      } catch {
        // Stop cleanly on any failure
      } finally {
        if (lessonPlayback.token === runToken) {
          lessonPlayback.running = false;
          btn.textContent = "Play lesson";
          btn.classList.remove("is-playing");
          stopCurrentAudio();
        }
      }
    });

    // Put it ABOVE all the sentences
    playLessonSlot.innerHTML = "";
    playLessonSlot.appendChild(btn);
  })();
}

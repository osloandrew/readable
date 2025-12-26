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

const els = {
  lessonSelect: document.getElementById("lessonSelect"),
  languageSelect: document.getElementById("languageSelect"),
  prevLessonBtn: document.getElementById("prevLessonBtn"),
  nextLessonBtn: document.getElementById("nextLessonBtn"),
  showEnglishToggle: document.getElementById("showEnglishToggle"),
  showLineNumbersToggle: document.getElementById("showLineNumbersToggle"),
  storyContainer: document.getElementById("storyContainer"),
  metaBar: document.getElementById("metaBar"),
  lessonImageWrap: document.getElementById("lessonImageWrap"),
  lessonImage: document.getElementById("lessonImage"),
};

const STORAGE_KEYS = {
  lesson: "readable.lesson",
  lang: "readable.lang",
  showEnglish: "readable.showEnglish",
  showLineNumbers: "readable.showLineNumbers",
};

let model = {
  lessons: [], // [{ lessonId, cefr, lines: [{lineNo, texts:{...}}]}]
  lessonIds: [], // ["1", "2", ...]
  languages: [], // ["English", "Norwegian", ...]
  currentLessonId: null,
  currentLanguage: null,
  showEnglish: false,
  showLineNumbers: false,
};

const IMAGES_DIR = "Images";
const IMAGE_EXT = "png";

function updateLessonImage(lessonId) {
  if (!els.lessonImageWrap || !els.lessonImage) return;

  const src = `${IMAGES_DIR}/Lesson ${lessonId}.${IMAGE_EXT}`;

  // Hide until we know it loads
  els.lessonImageWrap.style.display = "none";
  els.lessonImage.removeAttribute("src");
  els.lessonImage.alt = "";

  // Try to load; if it fails, keep hidden
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

init();

async function init() {
  hydratePreferences();
  wireUI();

  try {
    const csvText = await fetchText(CSV_PATH);
    const rows = parseCSV(csvText);
    buildModel(rows);
    initializeUIFromModel();
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
  const savedShowEnglish = localStorage.getItem(STORAGE_KEYS.showEnglish);
  const savedShowLineNumbers = localStorage.getItem(
    STORAGE_KEYS.showLineNumbers
  );

  model.currentLessonId = savedLesson || null;
  model.currentLanguage = savedLang || null;
  model.showEnglish = savedShowEnglish === "true";
  model.showLineNumbers = savedShowLineNumbers === "true";
}

function persistPreferences() {
  localStorage.setItem(STORAGE_KEYS.lesson, model.currentLessonId ?? "");
  localStorage.setItem(STORAGE_KEYS.lang, model.currentLanguage ?? "");
  localStorage.setItem(STORAGE_KEYS.showEnglish, String(model.showEnglish));
  localStorage.setItem(
    STORAGE_KEYS.showLineNumbers,
    String(model.showLineNumbers)
  );
}

function wireUI() {
  els.lessonSelect.addEventListener("change", () => {
    model.currentLessonId = els.lessonSelect.value;
    persistPreferences();
    render();
  });

  els.languageSelect.addEventListener("change", () => {
    model.currentLanguage = els.languageSelect.value;
    persistPreferences();
    render();
  });

  els.prevLessonBtn.addEventListener("click", () => {
    const idx = model.lessonIds.indexOf(model.currentLessonId);
    if (idx > 0) {
      model.currentLessonId = model.lessonIds[idx - 1];
      els.lessonSelect.value = model.currentLessonId;
      persistPreferences();
      render();
    }
  });

  els.nextLessonBtn.addEventListener("click", () => {
    const idx = model.lessonIds.indexOf(model.currentLessonId);
    if (idx >= 0 && idx < model.lessonIds.length - 1) {
      model.currentLessonId = model.lessonIds[idx + 1];
      els.lessonSelect.value = model.currentLessonId;
      persistPreferences();
      render();
    }
  });

  els.showEnglishToggle.addEventListener("change", () => {
    model.showEnglish = els.showEnglishToggle.checked;
    persistPreferences();
    render();
  });

  els.showLineNumbersToggle.addEventListener("change", () => {
    model.showLineNumbers = els.showLineNumbersToggle.checked;
    persistPreferences();
    render();
  });

  // Keyboard navigation: left/right for prev/next lesson
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") els.prevLessonBtn.click();
    if (e.key === "ArrowRight") els.nextLessonBtn.click();
  });
}

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  return await res.text();
}

/**
 * Robust-enough CSV parser for:
 * - comma separated values
 * - quoted fields with commas
 * - double quotes inside quoted fields ("")
 */
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

function buildModel(rows) {
  if (rows.length === 0) throw new Error("CSV contains no rows.");

  // Identify language columns: everything except Lesson, Line, CEFR
  const allCols = Object.keys(rows[0]);
  const languageCols = allCols.filter(
    (c) => !["Lesson", "Line", "CEFR"].includes(c)
  );

  if (languageCols.length === 0)
    throw new Error(
      "No language columns found (expected columns besides Lesson/Line/CEFR)."
    );

  // Group by lesson
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

  // Sort lessons numerically if possible
  const lessonIds = Array.from(byLesson.keys()).sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  );

  // Sort lines within each lesson
  const lessons = lessonIds.map((id) => {
    const lesson = byLesson.get(id);
    lesson.lines.sort((x, y) => x.lineNo - y.lineNo);
    // If CEFR differs across lines, keep the first non-empty; (your CSV has it per row but consistent)
    if (!lesson.cefr) {
      for (const ln of lesson.lines) {
        if (ln.cefr) {
          lesson.cefr = ln.cefr;
          break;
        }
      }
    }
    return lesson;
  });

  model.lessons = lessons;
  model.lessonIds = lessonIds;
  model.languages = languageCols;

  // Defaults if no saved prefs
  if (
    !model.currentLessonId ||
    !model.lessonIds.includes(model.currentLessonId)
  ) {
    model.currentLessonId = model.lessonIds[0];
  }

  // Prefer non-English language if saved; else English if exists; else first language col.
  if (
    !model.currentLanguage ||
    !model.languages.includes(model.currentLanguage)
  ) {
    model.currentLanguage = model.languages.includes("English")
      ? "English"
      : model.languages[0];
  }
}

function initializeUIFromModel() {
  // Lesson select
  els.lessonSelect.innerHTML = "";
  for (const id of model.lessonIds) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `Lesson ${id}`;
    els.lessonSelect.appendChild(opt);
  }
  els.lessonSelect.value = model.currentLessonId;

  // Language select
  els.languageSelect.innerHTML = "";
  for (const lang of model.languages) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    els.languageSelect.appendChild(opt);
  }
  els.languageSelect.value = model.currentLanguage;

  // Toggles
  els.showEnglishToggle.checked = model.showEnglish;
  els.showLineNumbersToggle.checked = model.showLineNumbers;

  persistPreferences();
}

function render() {
  const lesson = model.lessons.find(
    (l) => l.lessonId === model.currentLessonId
  );
  if (!lesson) return;

  updateLessonImage(lesson.lessonId);

  const idx = model.lessonIds.indexOf(model.currentLessonId);
  els.prevLessonBtn.disabled = idx <= 0;
  els.nextLessonBtn.disabled = idx >= model.lessonIds.length - 1;

  const cefr = lesson.cefr ? `CEFR ${lesson.cefr}` : "CEFR —";
  els.metaBar.textContent = `Lesson ${lesson.lessonId} · ${cefr} · Language: ${
    model.currentLanguage
  }${
    model.showEnglish && model.currentLanguage !== "English" ? " + English" : ""
  }`;

  els.storyContainer.innerHTML = "";

  for (const line of lesson.lines) {
    const lineEl = document.createElement("div");
    lineEl.className = "line";

    const noEl = document.createElement("div");
    noEl.className = "lineno";
    noEl.textContent = model.showLineNumbers
      ? String(line.lineNo).padStart(2, "0")
      : "";
    lineEl.appendChild(noEl);

    const tb = document.createElement("div");
    tb.className = "textblock";

    const primary = document.createElement("div");
    primary.className = "primary";
    primary.textContent = line.texts[model.currentLanguage] || "";
    tb.appendChild(primary);

    if (
      model.showEnglish &&
      model.currentLanguage !== "English" &&
      line.texts["English"]
    ) {
      const secondary = document.createElement("div");
      secondary.className = "secondary";
      secondary.textContent = line.texts["English"];
      tb.appendChild(secondary);
    }

    lineEl.appendChild(tb);
    els.storyContainer.appendChild(lineEl);
  }
}

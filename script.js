// ============================================================
//  App logic. You should not need to edit this file.
//  Bot personality and notes settings live in config.js.
// ============================================================

const KEY_NAME = "gemini_api_key";
const CACHE_NAME = "knowledge_embeddings";
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB attachment limit
const MAX_NOTE_CHARS = 1500;            // longer notes are split into parts
const EMBED_BATCH = 50;                 // notes sent per embedding request
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const startersEl = $("starters");
const statusEl = $("status");

let history = [];       // plain conversation sent to Gemini (questions only, no notes)
let pendingFile = null; // { name, kind: "text" | "pdf", data }
let busy = false;

/* ---------- Setup from config.js ---------- */
document.title = BOT_CONFIG.name;
document.documentElement.style.setProperty("--accent", BOT_CONFIG.themeColor);
$("botEmoji").textContent = BOT_CONFIG.emoji;
$("botName").textContent = BOT_CONFIG.name;
$("botTagline").textContent = BOT_CONFIG.tagline;

/* ---------- Light / dark switch ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
}

let savedTheme = null;
try { savedTheme = localStorage.getItem("theme"); } catch (e) {}
const systemPrefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(savedTheme || (systemPrefersDark ? "dark" : "light"));

$("themeBtn").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("theme", next); } catch (e) {}
});

/* ---------- Safe storage helpers ---------- */
function getKey() {
  try {
    const s = sessionStorage.getItem(KEY_NAME);
    if (s) return s;
  } catch (e) {}
  try {
    return localStorage.getItem(KEY_NAME) || "";
  } catch (e) {}
  return "";
}
function saveKey(key, remember) {
  try { sessionStorage.setItem(KEY_NAME, key); } catch (e) {}
  try {
    if (remember) localStorage.setItem(KEY_NAME, key);
    else localStorage.removeItem(KEY_NAME);
  } catch (e) {}
}
function clearKey() {
  try { sessionStorage.removeItem(KEY_NAME); } catch (e) {}
  try { localStorage.removeItem(KEY_NAME); } catch (e) {}
}

/* ---------- Safe formatting: escape HTML first, then bold + bullets ---------- */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function formatText(raw) {
  const lines = escapeHtml(raw).split("\n");
  let html = "";
  let inList = false;
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + bold(bullet[1]) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.trim() === "") continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    html += "<p>" + (heading ? "<strong>" + bold(heading[1]) + "</strong>" : bold(line)) + "</p>";
  }
  if (inList) html += "</ul>";
  return html;
}

/* ============================================================
   KNOWLEDGE (RAG): load notes, embed them, find the best ones
   ============================================================ */

let chunks = [];            // [{ noteId, baseTitle, title, text, vec, tf, ttf }]
let docFreq = new Map();    // for keyword search
let kbState = "off";        // off | loading | ok | missing | empty | error
let activeMethod = "keywords"; // "meaning" or "keywords" (what is really being used)
let methodNote = "";        // "" | "nokey" | "failed"
let fellBack = false;       // true if the last question had to use keywords
let knowledgePromise = Promise.resolve();

/* ----- Status line under the header ----- */
function renderStatus() {
  if (!BOT_CONFIG.useKnowledge) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  const f = BOT_CONFIG.knowledgeFile;
  let t;
  if (kbState === "loading") {
    t = "📚 Loading notes…";
  } else if (kbState === "missing") {
    t = "📚 " + f + " was not found. Add it to your GitHub repository, in the same place as index.html.";
  } else if (kbState === "empty") {
    t = "📚 " + f + " has no notes. Start each note with a line like “## Note title”.";
  } else if (kbState === "error") {
    t = "📚 Couldn't load " + f + ". Check your internet connection and refresh the page.";
  } else {
    const noteCount = new Set(chunks.map((c) => c.noteId)).size;
    let count = noteCount + (noteCount === 1 ? " note" : " notes");
    if (chunks.length !== noteCount) count += " (" + chunks.length + " parts)";
    let method = activeMethod === "meaning" ? "meaning search" : "keyword search";
    let extra = "";
    if (activeMethod === "meaning" && fellBack) {
      extra = " (used keywords for the last question)";
    } else if (activeMethod === "keywords" && BOT_CONFIG.searchMethod === "meaning") {
      if (methodNote === "nokey") extra = " (add your API key for meaning search)";
      else if (methodNote === "failed") extra = " (meaning search unavailable)";
    }
    t = "📚 " + count + " loaded · " + method + extra;
  }
  statusEl.textContent = t;
}

/* ----- Read knowledge.md into notes ----- */
function splitLong(body, max) {
  if (body.length <= max) return [body];
  const paras = body.split(/\n\s*\n/);
  const parts = [];
  let current = "";
  for (const p of paras) {
    if (current && (current + "\n\n" + p).length > max) {
      parts.push(current);
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseKnowledge(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const notes = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##(?!#)\s*(.*)$/);
    if (m) {
      if (cur) notes.push(cur);
      cur = { title: m[1].trim() || "Untitled note", body: [] };
    } else if (cur) {
      cur.body.push(line); // anything above the first ## line is ignored
    }
  }
  if (cur) notes.push(cur);

  const result = [];
  notes.forEach((n, ni) => {
    const body = n.body.join("\n").trim();
    if (!body) return;
    const parts = splitLong(body, MAX_NOTE_CHARS);
    parts.forEach((p, pi) => {
      result.push({
        noteId: ni,
        baseTitle: n.title,
        title: parts.length > 1 ? n.title + " (part " + (pi + 1) + ")" : n.title,
        text: p,
        vec: null
      });
    });
  });
  return result;
}

/* ----- Keyword search ----- */
const STOP_WORDS = new Set(("a an and are as at be but by do does for from how i in is it its me my of on or so " +
  "that the their them then there these this to was we were what when where which who why will with you your can " +
  "should would could about into than very just not no yes if").split(" "));

function tokens(s) {
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}
function countMap(list) {
  const m = new Map();
  list.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
  return m;
}
function buildKeywordIndex() {
  docFreq = new Map();
  chunks.forEach((c) => {
    c.tf = countMap(tokens(c.text));
    c.ttf = countMap(tokens(c.baseTitle));
    new Set([...c.tf.keys(), ...c.ttf.keys()]).forEach((t) => {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    });
  });
}
function topK() {
  return Math.max(1, Math.floor(Number(BOT_CONFIG.topK)) || 3);
}
function keywordSearch(question) {
  const qTerms = [...new Set(tokens(question))].filter((t) => docFreq.has(t));
  if (!qTerms.length) return [];
  const N = chunks.length;
  const idf = (t) => Math.log(1 + N / docFreq.get(t));
  const totalIdf = qTerms.reduce((sum, t) => sum + idf(t), 0);

  const scored = chunks.map((c) => {
    let rank = 0, matchedIdf = 0;
    qTerms.forEach((t) => {
      const tf = c.tf.get(t) || 0;
      const ttf = c.ttf.get(t) || 0;
      if (tf + ttf > 0) {
        rank += idf(t) * (1 + Math.log(tf + 3 * ttf));
        matchedIdf += idf(t);
      }
    });
    return { chunk: c, rank, score: totalIdf ? matchedIdf / totalIdf : 0 };
  });
  return scored
    .filter((s) => s.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, topK())
    .map((s) => ({ chunk: s.chunk, score: s.score }));
}

/* ----- Embeddings (meaning search) ----- */
async function embedTexts(texts, key) {
  const model = BOT_CONFIG.embeddingModel;
  const url = API_BASE + encodeURIComponent(model) + ":batchEmbedContents";
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        requests: batch.map((t) => ({
          model: "models/" + model,
          content: { parts: [{ text: t }] }
        }))
      })
    });
    if (!res.ok) throw new Error("Embedding request failed (" + res.status + ")");
    const data = await res.json();
    const embs = data.embeddings || [];
    if (embs.length !== batch.length) throw new Error("Unexpected embedding response");
    embs.forEach((e) => out.push(e.values));
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// A short "fingerprint" of the notes file, so we only re-embed when it changes.
function fingerprint(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "-" + str.length;
}
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_NAME) || "null"); } catch (e) { return null; }
}
function writeCache(fp, vectors) {
  try {
    // Rounded to 5 decimals to save space; this doesn't change search results.
    const small = vectors.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5));
    localStorage.setItem(CACHE_NAME, JSON.stringify({ fp, vectors: small }));
  } catch (e) {}
}

async function prepareEmbeddings(rawText) {
  methodNote = "";
  fellBack = false;
  if (BOT_CONFIG.searchMethod !== "meaning") { activeMethod = "keywords"; return; }

  const key = getKey();
  if (!key) { activeMethod = "keywords"; methodNote = "nokey"; return; }

  const fp = fingerprint("v1|" + BOT_CONFIG.embeddingModel + "|" + rawText);
  const cached = readCache();
  if (cached && cached.fp === fp && Array.isArray(cached.vectors) && cached.vectors.length === chunks.length) {
    chunks.forEach((c, i) => { c.vec = cached.vectors[i]; });
    activeMethod = "meaning";
    return;
  }

  try {
    const texts = chunks.map((c) => "title: " + c.baseTitle + " | text: " + c.text);
    const vectors = await embedTexts(texts, key);
    chunks.forEach((c, i) => { c.vec = vectors[i]; });
    writeCache(fp, vectors);
    activeMethod = "meaning";
  } catch (e) {
    console.warn("Meaning search unavailable, using keywords:", e);
    activeMethod = "keywords";
    methodNote = "failed";
  }
}

/* ----- Load everything (runs on page load and when the key changes) ----- */
async function loadKnowledge() {
  if (!BOT_CONFIG.useKnowledge) { kbState = "off"; chunks = []; renderStatus(); return; }
  kbState = "loading";
  renderStatus();

  let raw = "";
  try {
    const res = await fetch(BOT_CONFIG.knowledgeFile, { cache: "no-cache" });
    if (res.status === 404) { chunks = []; kbState = "missing"; renderStatus(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    raw = await res.text();
  } catch (e) {
    chunks = [];
    kbState = "error";
    renderStatus();
    return;
  }

  chunks = parseKnowledge(raw);
  if (!chunks.length) { kbState = "empty"; renderStatus(); return; }

  buildKeywordIndex();
  await prepareEmbeddings(raw);
  kbState = "ok";
  renderStatus();
}

function reloadKnowledge() {
  knowledgePromise = knowledgePromise.then(loadKnowledge).catch(() => {});
}

/* ----- Pick the best notes for a question ----- */
async function retrieve(question, key) {
  fellBack = false;
  let results;
  if (activeMethod === "meaning") {
    try {
      const [qVec] = await embedTexts(["task: search result | query: " + question], key);
      results = chunks
        .map((c) => ({ chunk: c, score: cosine(qVec, c.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK());
    } catch (e) {
      console.warn("Meaning search failed for this question, using keywords:", e);
      fellBack = true;
      results = keywordSearch(question);
    }
  } else {
    results = keywordSearch(question);
  }
  renderStatus();
  return results;
}

function buildNotesText(sources) {
  if (!sources.length) return "NOTES:\n(No matching notes were found.)";
  return "NOTES:\n" + sources
    .map((s, i) => "[" + (i + 1) + "] " + s.chunk.title + "\n" + s.chunk.text)
    .join("\n\n");
}

/* ---------- Chat display ---------- */
function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

function buildSources(sources) {
  const d = document.createElement("details");
  d.className = "sources";
  const sum = document.createElement("summary");
  sum.textContent = "Sources (" + sources.length + ")";
  d.appendChild(sum);
  sources.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "source-item";
    const head = document.createElement("div");
    head.className = "source-head";
    head.textContent = "[" + (i + 1) + "] " + s.chunk.title + " · score " + s.score.toFixed(2);
    const body = document.createElement("div");
    body.className = "source-text";
    const flat = s.chunk.text.replace(/\s+/g, " ").trim();
    body.textContent = flat.length > 220 ? flat.slice(0, 220) + "…" : flat;
    item.appendChild(head);
    item.appendChild(body);
    d.appendChild(item);
  });
  return d;
}

function addBubble(role, text, opts = {}) {
  const div = document.createElement("div");
  div.className = "msg " + role + (opts.error ? " error" : "");
  if (role === "user") {
    if (opts.fileName) {
      const note = document.createElement("div");
      note.className = "attach-note";
      note.textContent = "📎 " + opts.fileName;
      div.appendChild(note);
      div.appendChild(document.createElement("br"));
    }
    div.appendChild(document.createTextNode(text));
  } else {
    div.innerHTML = formatText(text);
    if (opts.sources && opts.sources.length) div.appendChild(buildSources(opts.sources));
  }
  chatEl.appendChild(div);
  scrollDown();
  return div;
}

function addThinking() {
  const div = document.createElement("div");
  div.className = "msg bot";
  div.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';
  chatEl.appendChild(div);
  scrollDown();
  return div;
}

function renderStarters() {
  startersEl.innerHTML = "";
  BOT_CONFIG.starterQuestions.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter";
    b.textContent = q;
    b.addEventListener("click", () => {
      inputEl.value = q;
      sendMessage();
    });
    startersEl.appendChild(b);
  });
  startersEl.hidden = false;
}

function newChat() {
  history = [];
  clearFile();
  chatEl.innerHTML = "";
  addBubble("bot", BOT_CONFIG.welcomeMessage);
  renderStarters();
  inputEl.value = "";
  autoGrow();
  inputEl.focus();
}

/* ---------- Friendly errors ---------- */
function errorMessage(status) {
  if (status === 400 || status === 403) return "Your API key looks invalid or isn't allowed to use this model. Click “API key” at the top and paste a valid key.";
  if (status === 404) return "The AI model name wasn't found. Open config.js and check the “model” setting.";
  if (status === 429) return "You're sending requests too quickly or have reached the free limit. Please wait a minute and try again.";
  if (status >= 500) return "Google's AI service is having problems right now. Please try again in a moment.";
  return "Something went wrong (error " + status + "). Please try again.";
}

/* ---------- Gemini call ---------- */
// notesText: the chosen notes (or null). They are added to this request only;
// the saved conversation history stays as your plain questions.
async function askGemini(key, notesText) {
  const url = API_BASE + encodeURIComponent(BOT_CONFIG.model) + ":generateContent";

  let contents = history;
  let system = BOT_CONFIG.systemInstructions;
  if (notesText) {
    system += "\n\n" + BOT_CONFIG.knowledgeRules;
    contents = history.map((m, i) => {
      if (i !== history.length - 1) return m;
      const parts = m.parts.map((p) => Object.assign({}, p));
      parts[0] = { text: notesText + "\n\nQUESTION:\n" + parts[0].text };
      return { role: m.role, parts };
    });
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents
      })
    });
  } catch (e) {
    throw { friendly: "Can't reach the internet. Check your connection and try again." };
  }

  if (!res.ok) throw { friendly: errorMessage(res.status), status: res.status };

  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  if (!text) throw { friendly: "The AI didn't return a reply (it may have been blocked). Try rephrasing and send again." };
  return text;
}

/* ---------- Sending ---------- */
async function sendMessage() {
  if (busy) return;
  let text = inputEl.value.trim();
  if (!text && !pendingFile) return;

  const key = getKey();
  if (!key) { openKeyModal(); return; }

  const file = pendingFile;
  if (!text) text = "Please grade this essay and give detailed feedback.";

  // Build the message parts
  const parts = [];
  if (file && file.kind === "text") {
    parts.push({ text: text + "\n\n--- Attached essay (" + file.name + ") ---\n" + file.data });
  } else {
    parts.push({ text });
    if (file && file.kind === "pdf") {
      parts.push({ inlineData: { mimeType: "application/pdf", data: file.data } });
    }
  }

  startersEl.hidden = true;
  addBubble("user", text, { fileName: file ? file.name : null });
  history.push({ role: "user", parts });

  inputEl.value = "";
  autoGrow();
  clearFile();

  busy = true;
  sendBtn.disabled = true;
  const thinking = addThinking();

  try {
    // Find the best notes (if notes are turned on and loaded)
    let sources = [];
    let notesText = null;
    if (BOT_CONFIG.useKnowledge) {
      await knowledgePromise;
      if (chunks.length) {
        sources = await retrieve(text, key);
        notesText = buildNotesText(sources);
      }
    }

    const reply = await askGemini(key, notesText);
    thinking.remove();
    history.push({ role: "model", parts: [{ text: reply }] });
    addBubble("bot", reply, { sources });
  } catch (err) {
    thinking.remove();
    history.pop(); // remove the failed message so you can safely try again
    addBubble("bot", err.friendly || "Something unexpected went wrong. Please try again.", { error: true });
    if (err.status === 400 || err.status === 403) openKeyModal();
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

/* ---------- File attach ---------- */
function clearFile() {
  pendingFile = null;
  $("fileChip").hidden = true;
  $("fileInput").value = "";
}

$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("removeFile").addEventListener("click", clearFile);

$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
    addBubble("bot", "Word files can't be read directly. Please open your essay in Word, copy the text, and paste it into the message box. You can also save it as a PDF and attach that.", { error: true });
    clearFile();
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    addBubble("bot", "That file is larger than 4 MB. Please attach a smaller file or paste the text instead.", { error: true });
    clearFile();
    return;
  }

  try {
    if (lower.endsWith(".pdf")) {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      pendingFile = { name: file.name, kind: "pdf", data: base64 };
    } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      pendingFile = { name: file.name, kind: "text", data: await file.text() };
    } else {
      addBubble("bot", "Please attach a .txt, .md, or .pdf file, or paste your essay as text.", { error: true });
      clearFile();
      return;
    }
    $("fileName").textContent = "📎 " + file.name;
    $("fileChip").hidden = false;
  } catch (err) {
    addBubble("bot", "I couldn't read that file. Please try another one or paste the text.", { error: true });
    clearFile();
  }
});

/* ---------- API key pop-up ---------- */
function openKeyModal() {
  $("keyInput").value = "";
  let remembered = false;
  try { remembered = !!localStorage.getItem(KEY_NAME); } catch (e) {}
  $("rememberBox").checked = remembered;
  $("keyModal").hidden = false;
  $("keyInput").focus();
}
function closeKeyModal() { $("keyModal").hidden = true; }

$("keyBtn").addEventListener("click", openKeyModal);
$("keyCancel").addEventListener("click", closeKeyModal);
$("keySave").addEventListener("click", () => {
  const k = $("keyInput").value.trim();
  if (!k) { $("keyInput").focus(); return; }
  saveKey(k, $("rememberBox").checked);
  closeKeyModal();
  reloadKnowledge(); // prepare meaning search with the new key
});
$("keyClear").addEventListener("click", () => {
  clearKey();
  closeKeyModal();
  reloadKnowledge();
});
$("keyModal").addEventListener("click", (e) => { if (e.target === $("keyModal")) closeKeyModal(); });

/* ---------- Input behavior ---------- */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener("click", sendMessage);
$("newChatBtn").addEventListener("click", newChat);

/* ---------- Start ---------- */
newChat();
reloadKnowledge();

// ============================================================
//  App logic. You should not need to edit this file.
//  Bot personality lives in config.js.
// ============================================================

const KEY_NAME = "gemini_api_key";
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const startersEl = $("starters");

let history = [];      // conversation sent to Gemini
let pendingFile = null; // { name, kind: "text" | "pdf", data }
let busy = false;

/* ---------- Setup from config.js ---------- */
document.title = BOT_CONFIG.name;
document.documentElement.style.setProperty("--accent", BOT_CONFIG.themeColor);
$("botEmoji").textContent = BOT_CONFIG.emoji;
$("botName").textContent = BOT_CONFIG.name;
$("botTagline").textContent = BOT_CONFIG.tagline;

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

/* ---------- Chat display ---------- */
function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

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
    div.appendChild(document.createTextNode(opts.fileName && opts.hideText ? "" : text));
  } else {
    div.innerHTML = formatText(text);
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
async function askGemini(key) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(BOT_CONFIG.model) + ":generateContent";

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BOT_CONFIG.systemInstructions }] },
        contents: history
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
    const reply = await askGemini(key);
    thinking.remove();
    history.push({ role: "model", parts: [{ text: reply }] });
    addBubble("bot", reply);
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
});
$("keyClear").addEventListener("click", () => { clearKey(); closeKeyModal(); });
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

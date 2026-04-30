const logEl = document.getElementById("log");
const timelineEl = document.getElementById("timeline");
const userSelect = document.getElementById("userSelect");
const ownerSelect = document.getElementById("ownerSelect");
const logSelect = document.getElementById("logSelect");
const vlogUserSelect = document.getElementById("vlogUserSelect");
const recordedAtInput = document.getElementById("recordedAtInput");
const dateInput = document.getElementById("dateInput");

const state = {
  bootstrap: null,
  logLines: []
};

const bootstrap = await fetchJson("/api/bootstrap");
state.bootstrap = bootstrap;
const today = new Date().toISOString().slice(0, 10);
recordedAtInput.value = new Date().toISOString().slice(0, 16);
dateInput.value = today;

renderSelects();
await renderTimeline();
log("Bootstrapped data loaded.");

document.getElementById("refreshButton").addEventListener("click", async () => {
  await refreshAll();
});

document.getElementById("createLogForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  const result = await fetchJson("/api/logs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  log(`Created log: ${result.data.name}`);
  await refreshAll();
});

document.getElementById("uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const file = fields.get("media");
  if (!(file instanceof File) || file.size === 0) {
    log("请先选择一个视频文件。", true);
    return;
  }
  const durationSeconds = Number(fields.get("durationSeconds"));
  const uploadIntent = await fetchJson("/api/upload-intents", {
    method: "POST",
    body: JSON.stringify({
      userId: fields.get("userId"),
      logId: fields.get("logId"),
      recordedAt: new Date(fields.get("recordedAt")).toISOString(),
      durationSeconds,
      note: fields.get("note"),
      timeZone: bootstrap.timeZone
    })
  });
  await fetch(uploadIntent.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream"
    },
    body: file
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await response.text());
    }
  });
  log(`Uploaded clip ${uploadIntent.clipId} -> ${uploadIntent.uploadUrl}`);
  await refreshAll();
});

document.getElementById("vlogForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await fetchJson("/api/daily-vlogs/generate", {
    method: "POST",
    body: JSON.stringify({
      userId: form.get("userId"),
      date: form.get("date"),
      timeZone: bootstrap.timeZone
    })
  });
  log(`Daily vlog generated: ${result.dailyVlog.id} (${result.dailyVlog.status})`);
  await refreshAll();
});

async function refreshAll() {
  state.bootstrap = await fetchJson("/api/bootstrap");
  renderSelects();
  await renderTimeline();
}

function renderSelects() {
  const users = state.bootstrap.users || [];
  const logs = state.bootstrap.logs || [];
  renderOptions(userSelect, users);
  renderOptions(ownerSelect, users);
  renderOptions(vlogUserSelect, users);
  renderOptions(logSelect, logs);
  document.getElementById("timeZoneLabel").textContent = state.bootstrap.timeZone;
  document.getElementById("clipLimit").textContent = `${state.bootstrap.maxClipSeconds}s`;
  document.getElementById("cooldownLimit").textContent = "60m";
}

function renderOptions(select, items) {
  const current = select.value;
  select.innerHTML = items
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join("");
  if (items.some((item) => item.id === current)) {
    select.value = current;
  } else if (items[0]) {
    select.value = items[0].id;
  }
}

async function renderTimeline() {
  const clips = state.bootstrap.clips || [];
  const logs = new Map((state.bootstrap.logs || []).map((log) => [log.id, log.name]));
  const users = new Map((state.bootstrap.users || []).map((user) => [user.id, user.name]));
  const sorted = clips
    .slice()
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  timelineEl.innerHTML = sorted
    .map((clip) => {
      const recordedAt = new Date(clip.recordedAt).toLocaleString();
      return `
        <article class="timelineItem">
          <div class="badge">${clip.hourKey.slice(-2)}:00</div>
          <div>
            <strong>${users.get(clip.userId) || clip.userId}</strong>
            <div class="muted">${logs.get(clip.logId) || clip.logId} · ${recordedAt}</div>
            <div class="muted">${clip.note || "No note"} </div>
          </div>
          <div class="muted">${clip.durationSeconds}s</div>
        </article>
      `;
    })
    .join("");
  if (sorted.length === 0) {
    timelineEl.innerHTML = `<p class="muted">还没有片段，先上传一条吧。</p>`;
  }
}

function log(message, isError = false) {
  const prefix = new Date().toLocaleTimeString();
  const line = `[${prefix}] ${message}`;
  state.logLines.unshift({ line, isError });
  logEl.innerHTML = state.logLines
    .map(({ line: entry, isError: error }) => {
      const safeLine = escapeHtml(entry);
      return error ? `<span class="error">${safeLine}</span>` : safeLine;
    })
    .join("<br />");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

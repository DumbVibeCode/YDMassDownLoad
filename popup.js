
const el = (id) => document.getElementById(id);

const statusLine = el("statusLine");
const barInner = el("barInner");
const progressText = el("progressText");

const btnDownloadPage = el("btnDownloadPage");
const btnDownloadAll = el("btnDownloadAll");

const btnStop = el("btnStop");
const btnStopCancel = el("btnStopCancel");
const btnPauseQueue = el("btnPauseQueue");
const btnPauseFreeze = el("btnPauseFreeze");
const btnResume = el("btnResume");
const btnRetryErrors = el("btnRetryErrors");
const btnClearErrors = el("btnClearErrors");

const errorBox = el("errorBox");
const errCount = el("errCount");
const errList = el("errList");
const btnCopyErrors = el("btnCopyErrors");

const maxConcurrent = el("maxConcurrent");
const maxItems = el("maxItems");
const extFilter = el("extFilter");
const btnSave = el("btnSave");
const saveStatus = el("saveStatus");

const btnCollect = el("btnCollect");
const btnCopyLinks = el("btnCopyLinks");
const btnDownloadTxt = el("btnDownloadTxt");
const linksArea = el("linksArea");
const linksCount = el("linksCount");

let lastCollectedLinks = [];
let lastErrCount = -1;
let pollTimer = null;

// Show extension version (helps to confirm updates)
try { const vEl = el("ver"); if (vEl) vEl.textContent = "v" + chrome.runtime.getManifest().version; } catch (_) {}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function setSaveStatus(text, isErr=false) {
  saveStatus.textContent = text || "";
  saveStatus.style.color = isErr ? "#b00020" : "#0a7b2f";
}

function renderState(s) {
  if (!s || !s.hasTask) {
    statusLine.textContent = "Нет активной задачи";
    progressText.textContent = "—";
    barInner.style.width = "0%";
    errorBox.classList.add("hidden");
    btnRetryErrors.disabled = true;
    btnClearErrors.disabled = true;
    btnCopyErrors.disabled = true;
    return;
  }

  const flags = [];
  if (s.running) flags.push("работает");
  if (s.pausedQueue) flags.push("пауза");
  if (s.pausedFreeze) flags.push("заморозка");
  if (s.stopRequested && !s.abortRequested) flags.push("стоп(очередь)");
  if (s.abortRequested) flags.push("стоп+отмена");
  if (s.limitReached) flags.push("лимит N");

  statusLine.textContent = (s.message || "—") + (flags.length ? ` • ${flags.join(", ")}` : "");

  const total = s.total || 0;
  const handled = s.handled || 0;
  const pct = total > 0 ? Math.round((Math.min(handled, total) / total) * 100) : 0;
  barInner.style.width = `${pct}%`;

  const started = s.started || 0;
  const completed = s.completed || 0;
  const interrupted = s.interrupted || 0;
  const canceled = s.canceled || 0;
  const preFail = (s.preFail ?? s.fail ?? 0);
  const skippedExt = s.skippedExt || 0;
  const activeRunning = s.activeRunning || 0;
  const activePaused = s.activePaused || 0;

  progressText.textContent =
    `Обработано: ${handled}/${total} • запущено: ${started} • завершено: ${completed} • прервано: ${interrupted} • отменено: ${canceled} • ошибок до старта: ${preFail} • фильтр: ${skippedExt} • активных: ${activeRunning} • на паузе: ${activePaused}`;

  // errors (list is fetched separately to avoid heavy polling)
  const ec = (s.errorsCount || 0);
  btnRetryErrors.disabled = (ec === 0) || !!s.running;
  btnClearErrors.disabled = (ec === 0);
  btnCopyErrors.disabled = (ec === 0);
  if (ec > 0) {
    errorBox.classList.remove("hidden");
    errCount.textContent = String(ec);
  } else {
    errorBox.classList.add("hidden");
    errCount.textContent = "0";
    errList.value = "";
    lastErrCount = 0;
  }
}

async function poll() {
  try {
    const res = await chrome.runtime.sendMessage({ cmd: "getTaskState" });
    if (res?.ok) { renderState(res.state); await maybeRefreshErrors(res.state); }
  } catch (_) {}
}

async function maybeRefreshErrors(state) {
  try {
    const ec = state?.errorsCount ?? 0;
    if (!ec || ec === lastErrCount) return;
    lastErrCount = ec;

    const res = await chrome.runtime.sendMessage({ cmd: "getErrorsList" });
    if (!res?.ok) return;

    const errors = res.errors || [];
    errList.value = errors.join("\n");
  } catch (_) {}
}

async function init() {
  try {
    const s = await chrome.runtime.sendMessage({ cmd: "getSettings" });
    maxConcurrent.value = s?.maxConcurrentDownloads ?? 3;
    maxItems.value = s?.maxItemsPerBulk ?? 0;
    extFilter.value = s?.extFilter ?? "";
  } catch (e) {
    setSaveStatus("Не удалось прочитать настройки", true);
  }

  await poll();
  pollTimer = setInterval(poll, 600);
}

btnSave.addEventListener("click", async () => {
  try {
    const n = clampInt(maxConcurrent.value, 1, 10, 3);
    const m = clampInt(maxItems.value, 0, 100000, 0);
    maxConcurrent.value = n;
    maxItems.value = m;

    const res = await chrome.runtime.sendMessage({
      cmd: "setSettings",
      maxConcurrentDownloads: n,
      maxItemsPerBulk: m,
      extFilter: extFilter.value
    });

    if (!res?.ok) throw new Error(res?.error || "Ошибка сохранения");
    extFilter.value = res.extFilter || "";
    setSaveStatus("Сохранено");
    setTimeout(() => setSaveStatus(""), 1200);
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

btnDownloadPage.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.url) throw new Error("Не удалось получить URL вкладки.");

    const res = await chrome.runtime.sendMessage({
      cmd: "downloadCurrentTab",
      url: tab.url
    });

    if (!res?.ok) throw new Error(res?.error || "Ошибка скачивания");
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

btnDownloadAll.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("Не удалось получить вкладку.");

    const res = await chrome.runtime.sendMessage({
      cmd: "startBulkFromTab",
      tabId: tab.id,
      url: tab.url || ""
    });

    if (!res?.ok) throw new Error(res?.error || "Ошибка массового скачивания");
    await poll();
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

btnStop.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "stopQueue" });
  if (res?.ok) renderState(res.state);
});

btnStopCancel.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "stopAndCancel" });
  if (res?.ok) renderState(res.state);
});

btnPauseQueue.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "pauseQueue" });
  if (res?.ok) renderState(res.state);
});

btnPauseFreeze.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "pauseFreeze" });
  if (res?.ok) renderState(res.state);
});

btnResume.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "resumeAll" });
  if (res?.ok) renderState(res.state);
});

btnRetryErrors.addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ cmd: "retryErrors" });
    if (!res?.ok) throw new Error(res?.error || "Не удалось повторить ошибки");

    if (res.state) renderState(res.state);

    if (res.info === "no_errors") {
      setSaveStatus("Нет ошибок для повтора.");
      setTimeout(() => setSaveStatus(""), 1200);
      return;
    }
    if (res.info === "running") {
      setSaveStatus("Сначала останови текущую задачу.", true);
      setTimeout(() => setSaveStatus(""), 1600);
      return;
    }

    await poll();
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

btnClearErrors.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ cmd: "clearErrors" });
  if (res?.ok) renderState(res.state);
});

btnCopyErrors.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(errList.value || "");
    setSaveStatus("Ошибки скопированы");
    setTimeout(() => setSaveStatus(""), 1000);
  } catch (e) {
    setSaveStatus("Не удалось скопировать", true);
  }
});

// Export links
btnCollect.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("Не удалось получить вкладку.");
    const res = await chrome.runtime.sendMessage({
      cmd: "collectLinksFromTab",
      tabId: tab.id,
      url: tab.url || ""
    });
    if (!res?.ok) throw new Error(res?.error || "Не удалось собрать ссылки");

    lastCollectedLinks = res.links || [];
    linksArea.value = lastCollectedLinks.join("\n");
    linksCount.textContent = `Найдено: ${lastCollectedLinks.length}`;
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

btnCopyLinks.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(linksArea.value || "");
    setSaveStatus("Ссылки скопированы");
    setTimeout(() => setSaveStatus(""), 1000);
  } catch (_) {
    setSaveStatus("Не удалось скопировать", true);
  }
});

btnDownloadTxt.addEventListener("click", async () => {
  try {
    const text = linksArea.value || "";
    if (!text.trim()) throw new Error("Список пуст.");

    const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const name = `yadisk_links_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;

    chrome.downloads.download({
      url: blobUrl,
      filename: name,
      conflictAction: "uniquify",
      saveAs: true
    }, () => {
      // ignore
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    });
  } catch (e) {
    setSaveStatus(String(e?.message || e), true);
  }
});

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
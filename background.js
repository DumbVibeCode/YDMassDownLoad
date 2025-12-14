const MENU_ID_LINK = "yadisk_download_link";
const MENU_ID_PAGE = "yadisk_download_page";
const MENU_ID_ALL  = "yadisk_download_all_links";

const DEFAULT_SETTINGS = {
  maxConcurrentDownloads: 3,  // 1..10
  maxItemsPerBulk: 0,         // 0 = без лимита
  extFilter: ""               // например: "mp3, flac, zip"
};

const BULK_MAX_LINKS = 500;        // абсолютный потолок (защита)
const BULK_ITEM_DELAY_MS = 150;    // пауза между элементами (анти-бан)

// ---------- global state ----------
let currentTask = null; // { id, createdAt, queue, total, nextIndex, running, stopRequested, abortRequested, pausedQueue, pausedFreeze, ... }
let activeDownloadMeta = new Map(); // downloadId -> { state: 'in_progress'|'complete'|'interrupted', paused: bool }
let extensionDownloadIds = new Set(); // all downloads started by extension since last service worker start

// ---------- install / menus / defaults ----------
chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    try {
      const existing = await chrome.storage.sync.get(null);
      const patch = {};
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (existing[k] === undefined) patch[k] = v;
      }
      if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
    } catch (e) {
      console.log("Failed to init defaults:", e);
    }

    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ID_LINK,
        title: "Скачать с Яндекс.Диска",
        contexts: ["link"],
        targetUrlPatterns: [
          "*://disk.yandex.ru/*",
          "*://disk.yandex.com/*",
          "*://yadi.sk/*"
        ]
      });

      chrome.contextMenus.create({
        id: MENU_ID_PAGE,
        title: "Скачать с Яндекс.Диска (эта страница)",
        contexts: ["page"],
        documentUrlPatterns: [
          "*://disk.yandex.ru/*",
          "*://disk.yandex.com/*",
          "*://yadi.sk/*"
        ]
      });

      chrome.contextMenus.create({
        id: MENU_ID_ALL,
        title: "Скачать все ссылки с Яндекс.Диска на странице",
        contexts: ["page"]
      });
    });
  })();
});

// ---------- downloads tracking ----------
chrome.downloads.onChanged.addListener((delta) => {
  try {
    if (!delta || delta.id === undefined) return;
    const id = delta.id;

    // Track only downloads started by extension (or those that are part of current task)
    if (!extensionDownloadIds.has(id) && !(currentTask?.downloadIds?.has(id))) return;

    const prev = activeDownloadMeta.get(id) || { state: "in_progress", paused: false, error: "", finalCounted: false };
    const next = { ...prev };

    if (delta.state && delta.state.current) next.state = delta.state.current;
    if (delta.paused && typeof delta.paused.current === "boolean") next.paused = delta.paused.current;
    if (delta.error && typeof delta.error.current === "string") next.error = delta.error.current;

    // Count final states exactly once (so “Удалить из списка загрузок” не ломает статистику)
    if (currentTask && currentTask.downloadIds?.has(id)) {
      if (!next.finalCounted && (next.state === "complete" || next.state === "interrupted")) {
        next.finalCounted = true;

        if (next.state === "complete") {
          currentTask.completed = (currentTask.completed || 0) + 1;
        } else {
          currentTask.interrupted = (currentTask.interrupted || 0) + 1;
          if (String(next.error || "").toUpperCase() === "USER_CANCELED") {
            currentTask.canceled = (currentTask.canceled || 0) + 1;
          }
        }
      }
    }

    activeDownloadMeta.set(id, next);
  } catch (e) {
    // silently ignore tracking glitches
  }
});

chrome.downloads.onErased.addListener((id) => {
  // If a download entry is erased before we saw its final state, try to count it once.
  // This happens when user cancels/removes items quickly in Chrome downloads UI.
  try {
    const meta = activeDownloadMeta.get(id);
    if (currentTask && currentTask.downloadIds?.has(id) && meta && !meta.finalCounted) {
      meta.finalCounted = true;
      currentTask.interrupted = (currentTask.interrupted || 0) + 1;
      // Erase typically follows a user action; treat as canceled for our stats.
      currentTask.canceled = (currentTask.canceled || 0) + 1;
    }
  } catch (_) {
    // ignore
  }
  activeDownloadMeta.delete(id);
});

// ---------- context menu handler ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === MENU_ID_LINK) {
      const url = info.linkUrl;
      if (!url) return;
      const href = await getBestDownloadHref(url);
      await chromeDownload(href);
      return;
    }

    if (info.menuItemId === MENU_ID_PAGE) {
      const url = info.pageUrl;
      if (!url) return;
      const href = await getBestDownloadHref(url);
      await chromeDownload(href);
      return;
    }

    if (info.menuItemId === MENU_ID_ALL) {
      if (!tab?.id) throw new Error("Не удалось получить текущую вкладку.");
      if (!tab.url || !tab.url.startsWith("http")) {
        throw new Error("На этой странице нельзя собрать ссылки (нужна обычная http/https-страница).");
      }
      const res = await startBulkFromTab(tab.id);
      notify("Яндекс.Диск", `Готово. Запущено: ${res.started}/${res.total}, ошибок (до запуска): ${res.preFail ?? 0}, пропущено фильтром: ${res.skippedExt}.`);
      return;
    }
  } catch (e) {
    console.log("Context menu failed:", e);
    notify("Не удалось", String(e?.message || e));
  }
});

// ---------- runtime messages (popup) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const safeSend = (payload) => { try { sendResponse(payload); } catch (_) {} };

  (async () => {
    try {
      if (!msg || typeof msg !== "object" || !msg.cmd) {
        safeSend({ ok: false, error: "Bad message" });
        return;
      }

      switch (msg.cmd) {
        case "getSettings": {
          // Historical behavior: return settings object directly (without ok)
          safeSend(await getSettings());
          return;
        }

        case "setSettings": {
          const n = clampInt(msg.maxConcurrentDownloads, 1, 10, DEFAULT_SETTINGS.maxConcurrentDownloads);
          const maxItems = clampInt(msg.maxItemsPerBulk, 0, 100000, DEFAULT_SETTINGS.maxItemsPerBulk);
          const extFilter = normalizeExtFilter(String(msg.extFilter || ""));
          await chrome.storage.sync.set({ maxConcurrentDownloads: n, maxItemsPerBulk: maxItems, extFilter });
          safeSend({ ok: true, maxConcurrentDownloads: n, maxItemsPerBulk: maxItems, extFilter });
          return;
        }

        case "downloadCurrentTab": {
          const url = String(msg.url || "");
          if (!url) { safeSend({ ok: false, error: "Не удалось получить URL текущей вкладки." }); return; }
          const href = await getBestDownloadHref(url);
          await chromeDownload(href);
          safeSend({ ok: true });
          return;
        }

        case "startBulkFromTab": {
          const tabId = msg.tabId;
          const url = String(msg.url || "");
          if (!tabId) { safeSend({ ok: false, error: "Не удалось получить tabId." }); return; }
          if (!url.startsWith("http")) { safeSend({ ok: false, error: "Нужна обычная http/https-страница." }); return; }
          const res = await startBulkFromTab(tabId);
          safeSend({ ok: true, ...res });
          return;
        }

        case "collectLinksFromTab": {
          const tabId = msg.tabId;
          const url = String(msg.url || "");
          if (!tabId) { safeSend({ ok: false, error: "Не удалось получить tabId." }); return; }
          if (!url.startsWith("http")) { safeSend({ ok: false, error: "Нужна обычная http/https-страница." }); return; }
          const links = await collectYadiskLinksFromTab(tabId);
          safeSend({ ok: true, links: Array.from(new Set(links)) });
          return;
        }

        case "getTaskState": {
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "stopQueue": {
          stopQueue(false);
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "stopAndCancel": {
          await stopQueue(true);
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "pauseQueue": {
          pauseQueueOnly();
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "pauseFreeze": {
          await pauseAndFreeze();
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "resumeAll": {
          await resumeAll();
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "retryErrors": {
          const res = await retryErrors(); // never throws for "no errors"
          safeSend({ ok: true, ...res, state: getTaskState() });
          return;
        }

        case "clearErrors": {
          clearErrors();
          safeSend({ ok: true, state: getTaskState() });
          return;
        }

        case "getErrorsList": {
          if (!currentTask) { safeSend({ ok: true, errors: [] }); return; }
          const list = Array.isArray(currentTask.errorLinks) ? currentTask.errorLinks : [];
          const seen = new Set();
          const uniq = [];
          for (const u of list) {
            if (seen.has(u)) continue;
            seen.add(u);
            uniq.push(u);
          }
          safeSend({ ok: true, errors: uniq });
          return;
        }

        default:
          safeSend({ ok: false, error: "Unknown command" });
          return;
      }
    } catch (e) {
      // Never throw from message handler: return an error object instead.
      safeSend({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // async
});


// ---------- task control ----------
function getTaskState() {
  const t = currentTask;
  if (!t) {
    return {
      running: false,
      hasTask: false,
      message: "Нет активной задачи",
      errorsCount: 0,
      activeRunning: 0,
      activePaused: 0
    };
  }

  const { runningCount, pausedCount } = countActiveDownloads(t.downloadIds);

  const total = t.total || 0;
  const handled = t.handled || 0;

  return {
    hasTask: true,
    id: t.id,
    running: !!t.running,
    stopRequested: !!t.stopRequested,
    abortRequested: !!t.abortRequested,
    pausedQueue: !!t.pausedQueue,
    pausedFreeze: !!t.pausedFreeze,
    limitReached: !!t.limitReached,
    createdAt: t.createdAt,

    total,
    handled,
    started: t.started || 0,             // сколько загрузок реально запущено
    completed: t.completed || 0,         // сколько завершено успешно
    interrupted: t.interrupted || 0,     // сколько прервано (в т.ч. отменено)
    canceled: t.canceled || 0,           // сколько прервано по отмене пользователя
    preFail: t.fail || 0,                // ошибки до запуска (не смогли получить direct URL и т.п.)
    skippedExt: t.skippedExt || 0,

    // legacy fields (чтобы не ломать старые popups, если остались)
    ok: t.completed || 0,
    fail: t.fail || 0,

    activeRunning: runningCount,
    activePaused: pausedCount,

    message: t.message || "",
    errorsCount: (t.errorLinks?.length || 0)
  };
}


function stopQueue(withCancel) {
  if (!currentTask) return;

  currentTask.stopRequested = true;
  currentTask.pausedQueue = false;

  if (withCancel) {
    currentTask.abortRequested = true;
    currentTask.message = "Остановка + отмена активных…";
    return cancelActiveDownloads(currentTask.downloadIds);
  } else {
    currentTask.message = "Остановлено (очередь). Активные закачки продолжаются.";
  }
}

function pauseQueueOnly() {
  if (!currentTask) return;
  currentTask.pausedQueue = true;
  currentTask.pausedFreeze = false;
  currentTask.message = "Пауза очереди (текущие закачки продолжаются).";
}

async function pauseAndFreeze() {
  if (!currentTask) return;
  currentTask.pausedQueue = true;
  currentTask.pausedFreeze = true;
  currentTask.message = "Пауза + заморозка активных…";
  await pauseActiveDownloads(currentTask.downloadIds);
  currentTask.message = "Пауза + активные на паузе.";
}

async function resumeAll() {
  if (!currentTask) return;
  const wasFreeze = currentTask.pausedFreeze;
  currentTask.pausedQueue = false;
  currentTask.pausedFreeze = false;
  if (wasFreeze) {
    currentTask.message = "Возобновляю активные…";
    await resumePausedDownloads(currentTask.downloadIds);
  }
  currentTask.message = "Продолжение.";
}

function clearErrors() {
  if (!currentTask) return;
  currentTask.errorLinks = [];
  currentTask.message = "Ошибки очищены.";
}

async function retryErrors() {
  if (!currentTask) {
    return { started: 0, total: 0, handled: 0, completed: 0, interrupted: 0, canceled: 0, preFail: 0, skippedExt: 0, info: "no_task" };
  }

  if (currentTask.running) {
    currentTask.message = "Сначала останови текущую задачу.";
    return { started: 0, total: 0, handled: 0, completed: 0, interrupted: 0, canceled: 0, preFail: 0, skippedExt: 0, info: "running" };
  }

  const uniq = Array.from(new Set(currentTask.errorLinks));
  if (!uniq.length) {
    currentTask.message = "Нет ошибок для повтора.";
    return { started: 0, total: 0, handled: 0, completed: 0, interrupted: 0, canceled: 0, preFail: 0, skippedExt: 0, info: "no_errors" };
  }

  currentTask.errorLinks = [];
  currentTask.message = `Повторяю ошибки: ${uniq.length} ссылок…`;
  return startBulkWithLinks(uniq);
}

// ---------- settings ----------
async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    maxConcurrentDownloads: clampInt(data.maxConcurrentDownloads, 1, 10, DEFAULT_SETTINGS.maxConcurrentDownloads),
    maxItemsPerBulk: clampInt(data.maxItemsPerBulk, 0, 100000, DEFAULT_SETTINGS.maxItemsPerBulk),
    extFilter: normalizeExtFilter(String(data.extFilter || ""))
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeExtFilter(s) {
  // keep original string but normalized: comma-separated without dots, lowercase
  const parts = s
    .split(/[\s,;]+/)
    .map(x => x.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  return parts.join(", ");
}

function parseExtSet(s) {
  const parts = normalizeExtFilter(s)
    .split(/[\s,;]+/)
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parts);
}

// ---------- bulk start ----------
async function startBulkFromTab(tabId) {
  const links = await collectYadiskLinksFromTab(tabId);
  const unique = Array.from(new Set(links)).slice(0, BULK_MAX_LINKS);
  if (!unique.length) {
    notify("Яндекс.Диск", "На странице не найдено ссылок Яндекс.Диска.");
    return { started: 0, total: 0, handled: 0, completed: 0, interrupted: 0, canceled: 0, preFail: 0, skippedExt: 0 };
  }
  return startBulkWithLinks(unique);
}

async function startBulkWithLinks(links) {
  const { maxConcurrentDownloads, maxItemsPerBulk, extFilter } = await getSettings();

  // replace current task
  currentTask = {
    id: `task_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    running: true,
    stopRequested: false,
    abortRequested: false,
    pausedQueue: false,
    pausedFreeze: false,
    limitReached: false,
    message: "Старт…",

    queue: links,
    total: links.length,
    nextIndex: 0,

    handled: 0,          // обработано ссылок (вкл. фильтр/ошибки/запуски)
    started: 0,          // реально запущено загрузок
    reservedStarts: 0,   // внутренний счетчик для строгого лимита N
    completed: 0,
    interrupted: 0,
    canceled: 0,
    fail: 0,             // ошибки до запуска (не получили direct URL и т.п.)
    skippedExt: 0,

    maxConcurrentDownloads,
    maxItemsPerBulk,
    extSet: parseExtSet(extFilter),

    downloadIds: new Set(),
    errorLinks: []
  };

  notify("Яндекс.Диск", `Найдено ссылок: ${currentTask.total}. Стартую…`);

  const workersCount = Math.min(maxConcurrentDownloads, currentTask.total, (currentTask.maxItemsPerBulk > 0 ? currentTask.maxItemsPerBulk : currentTask.total));
  const workers = Array.from({ length: workersCount }, () => workerLoop(currentTask));

  await Promise.all(workers);

  // finalize
  currentTask.running = false;

  if (currentTask.abortRequested) {
    currentTask.message = "Остановлено.";
  } else if (currentTask.limitReached) {
    currentTask.message = `Достигнут лимит N=${currentTask.maxItemsPerBulk}.`;
  } else if (currentTask.stopRequested) {
    currentTask.message = "Остановлено (очередь).";
  } else {
    currentTask.message = "Готово.";
  }

  return {
    started: currentTask.started,
    total: currentTask.total,
    handled: currentTask.handled,
    completed: currentTask.completed,
    interrupted: currentTask.interrupted,
    canceled: currentTask.canceled,
    preFail: currentTask.fail,
    skippedExt: currentTask.skippedExt
  };
}

async function workerLoop(task) {
  while (true) {
    // stop/abort checks
    if (task.abortRequested || task.stopRequested) return;

    // pause checks
    while (task.pausedQueue && !task.abortRequested && !task.stopRequested) {
      await sleep(250);
    }
    if (task.abortRequested || task.stopRequested) return;

    const i = task.nextIndex++;
    if (i >= task.queue.length) return;

    const shareUrl = task.queue[i];
    let reserved = false;

    try {
      // Hard cap by N (strict). Use reservedStarts to avoid race with concurrency.
      if (task.maxItemsPerBulk > 0 && task.reservedStarts >= task.maxItemsPerBulk) {
        task.limitReached = true;
        task.stopRequested = true;
        return;
      }

      // resolve direct url
      const href = await getBestDownloadHref(shareUrl);

      if (task.abortRequested || task.stopRequested) return;

      // extension filter (apply on direct link file name)
      if (task.extSet && task.extSet.size > 0) {
        const ext = guessExtensionFromDirectUrl(href);
        if (!ext || !task.extSet.has(ext)) {
          task.skippedExt++;
          task.handled++;
          continue;
        }
      }
      // Reserve a download slot for the limit N *after* we know the file passes filters.
      // This makes the limit strict even when maxConcurrentDownloads > N.
      if (task.maxItemsPerBulk > 0) {
        if (task.reservedStarts >= task.maxItemsPerBulk) {
          task.limitReached = true;
          task.stopRequested = true;
          return;
        }
        task.reservedStarts++;
        reserved = true;
      }

      // wait slot (respect pause/stop)
      await waitForSlot(task);

      if (task.abortRequested || task.stopRequested) {
        if (reserved) task.reservedStarts = Math.max(0, task.reservedStarts - 1);
        return;
      }

      // start download
      const id = await chromeDownload(href);
      extensionDownloadIds.add(id);
      task.downloadIds.add(id);
      activeDownloadMeta.set(id, { state: "in_progress", paused: false });

      task.started++;
      task.handled++;

      await sleep(BULK_ITEM_DELAY_MS);
    } catch (e) {
      console.log("Bulk item failed:", shareUrl, e);
      if (reserved) task.reservedStarts = Math.max(0, task.reservedStarts - 1);
      task.fail++;
      task.errorLinks.push(shareUrl);
      task.handled++;
      await sleep(BULK_ITEM_DELAY_MS);
    }
  }
}

async function waitForSlot(task) {
  const limit = clampInt(task.maxConcurrentDownloads, 1, 10, DEFAULT_SETTINGS.maxConcurrentDownloads);

  while (true) {
    if (task.abortRequested || task.stopRequested) return;

    // if pausedQueue, wait
    while (task.pausedQueue && !task.abortRequested && !task.stopRequested) {
      await sleep(250);
    }
    if (task.abortRequested || task.stopRequested) return;

    const running = countRunningDownloads(task.downloadIds);
    if (running < limit) return;

    await sleep(250);
  }
}

function countActiveDownloads(idsSet) {
  if (!idsSet || idsSet.size === 0) return { runningCount: 0, pausedCount: 0 };
  let runningCount = 0;
  let pausedCount = 0;

  for (const id of idsSet) {
    const meta = activeDownloadMeta.get(id);
    if (!meta) continue;
    if (meta.state !== "in_progress") continue;

    if (meta.paused === true) pausedCount++;
    else runningCount++;
  }
  return { runningCount, pausedCount };
}

function countRunningDownloads(idsSet) {
  return countActiveDownloads(idsSet).runningCount;
}


// ---------- pause/cancel helpers ----------
async function cancelActiveDownloads(idsSet) {
  if (!idsSet || idsSet.size === 0) return;
  const ids = Array.from(idsSet);

  await Promise.all(ids.map((id) => new Promise((resolve) => {
    chrome.downloads.cancel(id, () => resolve());
  })));
}

async function pauseActiveDownloads(idsSet) {
  if (!idsSet || idsSet.size === 0) return;
  const ids = Array.from(idsSet);

  await Promise.all(ids.map((id) => new Promise((resolve) => {
    const meta = activeDownloadMeta.get(id);
    if (!meta || meta.state !== "in_progress" || meta.paused) return resolve();
    chrome.downloads.pause(id, () => resolve());
  })));
}

async function resumePausedDownloads(idsSet) {
  if (!idsSet || idsSet.size === 0) return;
  const ids = Array.from(idsSet);

  await Promise.all(ids.map((id) => new Promise((resolve) => {
    const meta = activeDownloadMeta.get(id);
    if (!meta || meta.state !== "in_progress" || !meta.paused) return resolve();
    chrome.downloads.resume(id, () => resolve());
  })));
}

// ---------- link collection ----------
async function collectYadiskLinksFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const out = [];
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const a of anchors) {
        try {
          const href = a.href;
          const u = new URL(href);
          const hostOk = ["disk.yandex.ru", "disk.yandex.com", "yadi.sk"].includes(u.hostname);
          if (!hostOk) continue;
          out.push(href);
        } catch (_) {}
      }
      return out;
    }
  });

  return results?.[0]?.result || [];
}

// ---------- download logic ----------
function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message
  });
}

function isYadiskUrl(urlStr) {
  const u = new URL(urlStr);
  return ["disk.yandex.ru", "disk.yandex.com", "yadi.sk"].includes(u.hostname);
}

async function getBestDownloadHref(urlStr) {
  if (!isYadiskUrl(urlStr)) throw new Error("Это не ссылка Яндекс.Диска.");

  // 1) Official public API
  try {
    const href = await getHrefViaOfficialPublicApi(urlStr);
    if (href) return href;
  } catch (_) {}

  // 2) Fallback for /mail/?hash=...
  const href2 = await getHrefViaWebApi(urlStr);
  if (href2) return href2;

  throw new Error("Не получилось получить прямую ссылку.");
}

async function getHrefViaOfficialPublicApi(publicUrl) {
  const base = "https://cloud-api.yandex.net/v1/disk/public/resources/download";
  const qs = new URLSearchParams({ public_key: publicUrl });
  const endpoint = `${base}?${qs.toString()}`;

  const res = await fetch(endpoint, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`Official API HTTP ${res.status}`);

  const data = await res.json();
  if (!data?.href) throw new Error("Official API: нет href");
  return data.href;
}

async function getHrefViaWebApi(urlStr) {
  const u = new URL(urlStr);
  const hash = u.searchParams.get("hash");
  const uid = u.searchParams.get("uid") || null;
  if (!hash) return null;

  const htmlRes = await fetch(u.toString(), {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  });
  if (!htmlRes.ok) throw new Error(`Page HTTP ${htmlRes.status}`);
  const html = await htmlRes.text();

  const sk = extractSkFromHtml(html);
  if (!sk) throw new Error("Web-API: не смог найти sk в HTML страницы.");

  const payload = uid ? { hash, sk, uid } : { hash, sk };

  const apiRes = await fetch("https://disk.yandex.ru/public/api/download-url", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "accept": "*/*"
    },
    body: JSON.stringify(payload)
  });

  if (!apiRes.ok) throw new Error(`Web-API HTTP ${apiRes.status}`);

  const data = await apiRes.json();
  const direct = data?.url || data?.href;
  if (!direct) throw new Error("Web-API: нет url/href в ответе.");
  return direct;
}

function extractSkFromHtml(html) {
  const patterns = [
    /"sk"\s*:\s*"([^"]+)"/,
    /"environment"\s*:\s*\{[^}]*"sk"\s*:\s*"([^"]+)"/
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function guessExtensionFromDirectUrl(directUrl) {
  try {
    const u = new URL(directUrl);
    // common patterns: filename=... or name=...
    const qp = u.searchParams.get("filename") || u.searchParams.get("name") || u.searchParams.get("file") || "";
    let candidate = qp ? decodeURIComponent(qp) : "";

    if (!candidate) {
      // fallback: last path segment
      const seg = u.pathname.split("/").filter(Boolean).pop() || "";
      candidate = decodeURIComponent(seg);
    }

    // remove any trailing quotes etc
    candidate = candidate.replace(/["']/g, "").trim();
    const dot = candidate.lastIndexOf(".");
    if (dot === -1) return "";
    const ext = candidate.slice(dot + 1).toLowerCase();
    // very long extension probably not real
    if (!ext || ext.length > 10) return "";
    return ext;
  } catch (_) {
    return "";
  }
}

function chromeDownload(url) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, conflictAction: "uniquify" }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!id) reject(new Error("Chrome download: пустой id"));
      else resolve(id);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

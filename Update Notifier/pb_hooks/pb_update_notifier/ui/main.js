const releasesUrl = "https://github.com/pocketbase/pocketbase/releases";
const requestKey = "pb_update_notifier_" + app.utils.randomString();
const retryInterval = 15 * 60 * 1000;

let owner = "";
let generation = 0;
let loading = false;
let nextCheckAt = 0;
let timer;

function authenticated() {
  return app.pb.authStore.isValid && app.pb.authStore.record?.collectionName === "_superusers";
}

function parseVersion(value) {
  if (typeof value !== "string" || value.length > 100) return null;
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { parts, prerelease: !!match[4] };
}

function syncNotice(latestVersion = "") {
  const links = app.store.creditLinks;
  const currentIndex = links.findIndex((link) => link.href === releasesUrl && link.label.startsWith("PocketBase "));
  const noticeIndex = links.findIndex((link) => link.pbUpdateNotifier === true);
  const current = currentIndex >= 0 ? parseVersion(links[currentIndex].label.slice("PocketBase ".length)) : null;
  const latest = parseVersion(latestVersion);
  let newer = false;
  if (authenticated() && current && latest && !latest.prerelease) {
    newer = current.prerelease;
    for (let index = 0; index < 3; index++) {
      if (latest.parts[index] !== current.parts[index]) {
        newer = latest.parts[index] > current.parts[index];
        break;
      }
    }
  }

  if (!newer) {
    if (noticeIndex >= 0) links.splice(noticeIndex, 1);
    return;
  }

  const href = releasesUrl + "/tag/" + encodeURIComponent(latestVersion);
  const label = "Update available: " + (latestVersion.startsWith("v") ? latestVersion : "v" + latestVersion);
  if (noticeIndex >= 0) {
    links[noticeIndex].href = href;
    links[noticeIndex].label = label;
  } else {
    links.splice(currentIndex + 1, 0, {
      pbUpdateNotifier: true,
      href,
      icon: "ri-arrow-up-circle-line",
      label,
    });
  }
}

async function checkForUpdates() {
  clearTimeout(timer);
  if (!authenticated()) {
    syncNotice();
    return;
  }
  if (document.hidden || !navigator.onLine || loading) return;
  if (Date.now() < nextCheckAt) {
    timer = setTimeout(checkForUpdates, nextCheckAt - Date.now());
    return;
  }

  const token = generation;
  loading = true;
  try {
    const result = await app.pb.send("/api/pb-update-notifier/latest", { method: "GET", requestKey });
    if (token !== generation) return;
    nextCheckAt = Date.now() + Math.max(15, Math.min(3600, result.retryAfterSeconds)) * 1000;
    syncNotice(result.latestVersion);
  } catch (error) {
    if (token !== generation || error?.isAbort) return;
    syncNotice();
    nextCheckAt = Date.now() + (error?.status === 423 ? 15000 : retryInterval);
    if (error?.status === 401) app.checkApiError(error, false);
  } finally {
    loading = false;
    if (token !== generation) checkForUpdates();
    else if (authenticated() && !document.hidden && navigator.onLine) {
      timer = setTimeout(checkForUpdates, Math.max(1000, nextCheckAt - Date.now()));
    }
  }
}

app.pb.authStore.onChange(() => {
  const nextOwner = authenticated() ? app.pb.authStore.record.id : "";
  if (nextOwner !== owner) {
    ++generation;
    owner = nextOwner;
    nextCheckAt = 0;
    clearTimeout(timer);
    app.pb.cancelRequest(requestKey);
    syncNotice();
  }
  checkForUpdates();
}, true);

document.addEventListener("visibilitychange", checkForUpdates);
window.addEventListener("online", checkForUpdates);

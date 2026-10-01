const PREFIX = "pb_update_notifier.";
const CHECK_INTERVAL = 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
const RELEASE_PATTERN = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

module.exports.latest = function (e) {
  e.response.header().set("Cache-Control", "no-store");

  let acquired = false;
  e.app.store().setFunc(PREFIX + "busy", function (busy) {
    if (busy) return busy;
    acquired = true;
    return true;
  });
  if (!acquired) {
    e.response.header().set("Retry-After", "15");
    throw new ApiError(423, "An update check is already in progress. Try again shortly.");
  }

  try {
    const saved = e.app.store().get(PREFIX + "cache");
    let cache = saved ? JSON.parse(saved) : null;
    if (!cache || Date.now() >= cache.nextCheckAt) {
      cache = { latestVersion: "", checkedAt: 0, nextCheckAt: 0, error: "" };
      let retryInterval = RETRY_INTERVAL;
      try {
        const response = $http.send({
          url: "https://api.github.com/repos/pocketbase/pocketbase/releases/latest",
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "PB-Update-Notifier",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          timeout: 10,
        });
        if (response.statusCode === 403 || response.statusCode === 429) retryInterval = CHECK_INTERVAL;
        if (response.statusCode !== 200) throw new Error("The release request failed.");

        const release = response.json;
        if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" || release.tag_name.length > 80 || !RELEASE_PATTERN.test(release.tag_name)) throw new Error("The release response is invalid.");

        cache.latestVersion = release.tag_name;
        cache.checkedAt = Date.now();
        cache.nextCheckAt = cache.checkedAt + CHECK_INTERVAL;
      } catch (_) {
        cache.error = "Unable to check PocketBase releases on GitHub. The check will be retried automatically.";
        cache.nextCheckAt = Date.now() + retryInterval;
      }
      e.app.store().set(PREFIX + "cache", JSON.stringify(cache));
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((cache.nextCheckAt - Date.now()) / 1000));
    if (cache.error) {
      e.response.header().set("Retry-After", String(retryAfterSeconds));
      throw new ApiError(503, cache.error);
    }
    return e.json(200, {
      latestVersion: cache.latestVersion,
      checkedAt: cache.checkedAt,
      retryAfterSeconds: retryAfterSeconds,
    });
  } finally {
    e.app.store().set(PREFIX + "busy", false);
  }
};

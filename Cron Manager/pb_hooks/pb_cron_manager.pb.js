/// <reference path="../pb_data/types.d.ts" />

$app.onServe().bindFunc(function (e) {
  e.app.store().set("pb_cron_manager.bootId", $security.randomString(32));
  e.app.store().set("pb_cron_manager.startupError", "");
  try { require(__hooks + "/pb_cron_manager/api.js").initialize(e.app); } catch (_) {
    e.app.store().set("pb_cron_manager.startupError", "Cron Manager could not load its storage at startup. Check permissions and saved JSON files, then restart the instance using your usual method to restore all saved schedules.");
    e.app.logger().error("Cron Manager could not initialize its private storage. Existing app crons are unchanged.");
  }
  e.uiExtensions = (e.uiExtensions || []).concat([
    {
      name: "pb-cron-manager",
      fs: $os.dirFS(__hooks + "/pb_cron_manager/ui"),
    },
  ]);
  return e.next();
});

routerUse(function (e) {
  const path = e.request.url.path;
  if (path === "/_/extensions.js" || path.indexOf("/_/extensions/pb-cron-manager/") === 0) { e.response.header().set("Cache-Control", "no-store"); }
  return e.next();
});

routerAdd("GET", "/api/pb-cron-manager/jobs", function (e) { return require(__hooks + "/pb_cron_manager/api.js").list(e); }, $apis.requireSuperuserAuth(), $apis.skipSuccessActivityLog());

routerAdd("GET", "/api/pb-cron-manager/history", function (e) { return require(__hooks + "/pb_cron_manager/api.js").history(e); }, $apis.requireSuperuserAuth(), $apis.skipSuccessActivityLog());

routerAdd("GET", "/api/pb-cron-manager/jobs/{id}", function (e) { return require(__hooks + "/pb_cron_manager/api.js").read(e); }, $apis.requireSuperuserAuth(), $apis.skipSuccessActivityLog());

routerAdd("POST", "/api/pb-cron-manager/jobs", function (e) { return require(__hooks + "/pb_cron_manager/api.js").save(e, true); }, $apis.requireSuperuserAuth(), $apis.bodyLimit(256 * 1024));

routerAdd("PUT", "/api/pb-cron-manager/jobs/{id}", function (e) { return require(__hooks + "/pb_cron_manager/api.js").save(e, false); }, $apis.requireSuperuserAuth(), $apis.bodyLimit(256 * 1024));

routerAdd("POST", "/api/pb-cron-manager/jobs/{id}/toggle", function (e) { return require(__hooks + "/pb_cron_manager/api.js").toggle(e); }, $apis.requireSuperuserAuth(), $apis.bodyLimit(4096));

routerAdd("DELETE", "/api/pb-cron-manager/jobs/{id}", function (e) { return require(__hooks + "/pb_cron_manager/api.js").remove(e); }, $apis.requireSuperuserAuth(), $apis.bodyLimit(4096));

routerAdd("POST", "/api/pb-cron-manager/jobs/{id}/run", function (e) { return require(__hooks + "/pb_cron_manager/api.js").run(e); }, $apis.requireSuperuserAuth(), $apis.bodyLimit(4096));

/// <reference path="../pb_data/types.d.ts" />

$app.onServe().bindFunc(function (e) {
  e.uiExtensions = (e.uiExtensions || []).concat([
    {
      name: "pb-update-notifier",
      fs: $os.dirFS(__hooks + "/pb_update_notifier/ui"),
    },
  ]);
  return e.next();
});

routerUse(function (e) {
  const path = e.request.url.path;
  if (path === "/_/extensions.js" || path.indexOf("/_/extensions/pb-update-notifier/") === 0) {
    e.response.header().set("Cache-Control", "no-store");
  }
  return e.next();
});

routerAdd(
  "GET",
  "/api/pb-update-notifier/latest",
  function (e) {
    return require(__hooks + "/pb_update_notifier/api.js").latest(e);
  },
  $apis.requireSuperuserAuth(),
  $apis.skipSuccessActivityLog(),
);

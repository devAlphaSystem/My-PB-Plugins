/// <reference path="../pb_data/types.d.ts" />

$app.onServe().bindFunc(function (e) {
  e.app.store().set("pb_hooks_manager.bootId", $security.randomString(32));
  e.app.store().set("pb_hooks_manager.restartRequired", false);
  e.uiExtensions = (e.uiExtensions || []).concat([
    {
      name: "pb-hooks-manager",
      fs: $os.dirFS(__hooks + "/pb_hooks_manager/ui"),
    },
  ]);
  return e.next();
});

routerUse(function (e) {
  const path = e.request.url.path;
  if (path === "/_/extensions.js" || path.indexOf("/_/extensions/pb-hooks-manager/") === 0) { e.response.header().set("Cache-Control", "no-store"); }
  return e.next();
});

routerAdd("GET", "/api/pb-hooks-manager/files", function (e) { return require(__hooks + "/pb_hooks_manager/api.js").list(e); }, $apis.requireSuperuserAuth(), $apis.skipSuccessActivityLog());

routerAdd("GET", "/api/pb-hooks-manager/status", function (e) { return require(__hooks + "/pb_hooks_manager/api.js").status(e); }, $apis.requireSuperuserAuth(), $apis.skipSuccessActivityLog());

["apply", "discard", "visibility"].forEach(function (action) {
  routerAdd(
    "POST",
    "/api/pb-hooks-manager/" + action,
    function (e) {
      const action = e.request.url.path.substring(e.request.url.path.lastIndexOf("/") + 1);
      return require(__hooks + "/pb_hooks_manager/api.js")[action](e);
    },
    $apis.requireSuperuserAuth(),
    $apis.bodyLimit(4096),
  );
});

["GET", "POST", "PUT", "DELETE"].forEach(function (method) {
  const middlewares = [$apis.requireSuperuserAuth(), $apis.bodyLimit(7 * 1024 * 1024)];
  if (method === "GET") middlewares.push($apis.skipSuccessActivityLog());
  routerAdd(method, "/api/pb-hooks-manager/file", function (e) { return require(__hooks + "/pb_hooks_manager/api.js").file(e); }, ...middlewares);
});

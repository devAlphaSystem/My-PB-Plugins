/// <reference path="../pb_data/types.d.ts" />

$app.onServe().bindFunc(function (e) {
  e.uiExtensions = (e.uiExtensions || []).concat([
    {
      name: "pb-collections-live",
      fs: $os.dirFS(__hooks + "/pb_collections_live/ui"),
    },
  ]);
  return e.next();
});

routerUse(function (e) {
  const path = e.request.url.path;
  if (path === "/_/extensions.js" || path.indexOf("/_/extensions/pb-collections-live/") === 0) {
    e.response.header().set("Cache-Control", "no-store");
  }
  return e.next();
});

$app.onServe().bindFunc(function (e) {
  const css = `
        :root,
        :root .dropdown,
        :root .base-surface {
            --accentColor: #1d4ed8 !important;

            --primaryColor: #1d4ed8;
            --primaryAlt1Color: color-mix(
                in srgb, var(--primaryColor), black 10%
            );
            --primaryAlt2Color: color-mix(
                in srgb, var(--primaryColor), black 20%
            );
            --primaryTxtColor: #ffffff;

            --surfaceColor: #f8fbff;
            --pbThemeMixColor: #1d4ed8;

            --surfaceAlt1Color: color-mix(
                in srgb, var(--surfaceColor), var(--pbThemeMixColor) 4%
            );
            --surfaceAlt2Color: color-mix(
                in srgb, var(--surfaceColor), var(--pbThemeMixColor) 10%
            );
            --surfaceAlt3Color: color-mix(
                in srgb, var(--surfaceColor), var(--pbThemeMixColor) 16%
            );
            --surfaceAlt4Color: color-mix(
                in srgb, var(--surfaceColor), var(--pbThemeMixColor) 22%
            );
            --surfaceAlt5Color: color-mix(
                in srgb, var(--surfaceColor), var(--pbThemeMixColor) 28%
            );

            --surfaceTxtColor: #172033;
            --surfaceTxtHintColor: #526275;
            --surfaceTxtDisabledColor: #8491a4;

            --secondaryColor: var(--surfaceAlt2Color);
            --secondaryAlt1Color: var(--surfaceAlt3Color);
            --secondaryAlt2Color: var(--surfaceAlt4Color);
            --secondaryTxtColor: var(--surfaceTxtColor);

            --inputColor: var(--surfaceAlt2Color);
            --inputFocusColor: var(--surfaceAlt3Color);
            --inputBorderColor: var(--surfaceAlt4Color);

            --borderRadius: 8px;
            --lgBorderRadius: 16px;
        }

        :root[data-color-scheme="dark"],
        :root[data-color-scheme="dark"] .dropdown,
        :root[data-color-scheme="dark"] .base-surface {
            --surfaceColor: #101b2a;
            --pbThemeMixColor: #ffffff;

            --surfaceTxtColor: #e5eaf2;
            --surfaceTxtHintColor: #a9b6c8;
            --surfaceTxtDisabledColor: #748399;
        }
    `;

  const directory = $filepath.join(e.app.dataDir(), "ui-theme-demo");

  $os.mkdirAll(directory, 0o700);

  const javascript = `
        const style = document.createElement("style");
        style.id = "pb-theme-demo";
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
    `;

  $os.writeFile($filepath.join(directory, "main.js"), javascript, 0o600);

  e.uiExtensions = (e.uiExtensions || []).concat([
    {
      name: "theme-demo",
      fs: $os.dirFS(directory),
    },
  ]);

  return e.next();
});

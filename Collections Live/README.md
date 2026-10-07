# PB Collections Live

Keeps the **Collections** record list and its total current without reloading the dashboard or replacing the entire table after every change. The plugin uses PocketBase's native realtime connection and the current superuser session. It owns the listing state and reuses the dashboard's field renderers, search controls, record modals, styling, and credits.

This package is a dashboard extension loaded from `pb_hooks`. Installation does not replace the executable, patch PocketBase source files, change collections, or introduce a separate API or authentication system. It works independently of the other plugins in this repository.

## Installing on an existing instance

With PocketBase stopped, run this **from the instance's directory or directly inside its `pb_hooks` directory** on Linux:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Collections%20Live/install.sh | bash'
```

The standalone installer installs or replaces only this plugin's three files. It uses the current directory if named `pb_hooks`; otherwise it uses or creates its direct child `pb_hooks`. It requires Bash, curl, GNU tar, gzip, and GNU coreutils. This download command becomes available after the package is published to the repository's `main` branch.

For manual installation:

1. Use the official **PocketBase v0.40.3 or v0.40.4** executable with its native admin dashboard and JavaScript hooks enabled.
2. Stop the instance using your usual procedure. Copying files while the hooks watcher is active may restart the instance before installation finishes.
3. Merge this package's `pb_hooks` directory into the instance's existing hooks directory, preserving all other files.
4. Start the instance, sign in as a superuser, reload the dashboard with **Ctrl+Shift+R**, and open **Collections**, at `/_/#/collections`.

Installed directory structure:

```text
pocketbase or pocketbase.exe
pb_data/
pb_hooks/
    your_existing_files.pb.js
    pb_collections_live.pb.js
    pb_collections_live/
        ui/
            main.js
            sync.js
```

For a custom `--hooksDir`, copy the contents of this package's `pb_hooks` directory directly into that directory. The hook uses the actual `__hooks` path. No extra flags, packages, compilation, collections, migrations, or writable plugin storage are required.

## Live listing

The extension registers its Collections listing component before the dashboard initializes its router. The component loads the separate synchronization module from the extension's public asset URL when it mounts. It preserves the page's search, sort, selected collection, record modal callbacks, and manual refresh control. Each loaded record has a stable identity, so ordinary field updates retain the existing row and use the native renderer for that field.

Realtime events trigger synchronization against the native record API, with nearby events grouped before querying. An ordinary update can read the affected record without rereading the ordered list. When membership or order may have changed, a query reads the ordered IDs and matching total, then fetches the affected or newly entering records. The server evaluates the current filter and sort; the plugin does not reproduce PocketBase's filter language in the browser.

**Load more** adds 40 records to the loaded range. Live synchronization retains that capacity. Rows that remain in the range keep their identity and selection; deleted records and records leaving the current filter or range are removed from the selection. When rows move above the viewport, the plugin anchors scrolling to a retained visible row where possible. Changes to a collection's field definitions can recreate affected rows to render the new schema.

Rows entering the current list briefly use the dashboard's green success background; existing rows with changed values use its blue information background. The highlight lasts **1.5 seconds**, and another actual change restarts that duration. Initial loading, changing the collection/filter/sort, and newly loaded **Load more** rows do not highlight. Repeated notifications or reconciliation with identical values do not restart it. Deleted or no longer matching rows leave the list normally. The colors follow the native light and dark themes.

The existing refresh button reconciles the loaded range and its contents without reloading the dashboard. Returning to a visible tab, reconnecting the browser, or reconnecting realtime also reconciles the range to recover missed updates.

The plugin's record state also supplies the visible total count. It replaces only the native count node in the page footer. Credits remain native, including notices added by Update Notifier. The page's original count calculation may still make occasional requests when the collection, filter, or manual refresh changes.

The count displays a connection indicator: **Connecting**, **Syncing**, **Live**, **Offline**, **Sync error**, or **Auto**. A synchronization error retains the last loaded data. A displayed count or field value may be stale while the connection is offline or an error remains unresolved.

Base and auth collections use realtime events. PocketBase view collections do not emit record realtime events, so views and lists with view dependencies reconcile every **10 seconds** while the tab is visible; their indicator shows **Auto**. Related collection subscriptions follow the relation schema through at most six levels. Filters containing `@collection.` subscribe to the available collections to detect cross-collection changes. These queries and subscriptions add work to the current instance, especially for large loaded ranges or broad cross-collection filters.

The record editor remains the native drawer. Live changes to the list do not overwrite unsaved edits in an open drawer. A list that has updated does not guarantee that an already open editor has fetched the same version; reopen the record before editing from a fresh server snapshot when another client changed it.

The plugin synchronizes record data, not external changes to collection definitions or direct database writes that bypass PocketBase's event hooks. Ordinary schema changes made through the dashboard use its existing collection reload flow. Record mutations from applications and hooks should use PocketBase's normal APIs and model save/delete methods so realtime events can be emitted.

## Compatibility and validation

The extension targets the official **PocketBase v0.40.3 and v0.40.4** dashboards. The dashboard extension API is experimental upstream. Custom dashboards or other extensions that replace the same listing component require separate compatibility review. Validate a new PocketBase version before upgrading an installation that uses this plugin.

Validation used **18 passing Node synchronization tests** and browser checks against the official **PocketBase v0.40.4** executable in a disposable local instance. The v0.40.3 integration was reviewed statically; that version has not been run with this plugin. Test fixtures and instructions are in [tests/README.md](tests/README.md); the recorded browser comparisons are in [tests/browser-results.json](tests/browser-results.json).

Browser checks verified external field updates, loading 40 then 80 records, preserved selection, related author updates, filtered exits and replacement rows, filtered create/delete and matching totals, an empty filtered list followed by recreation, manual refresh, and a record drawer with unsaved input and editable content. DOM probes confirmed that retained rows, the table, and unchanged field contents kept their node identity. After moving a row, a subsequent field update and a real deletion were checked again to verify that reactive updates and cleanup remained functional. Stopping and restarting PocketBase changed the status from Offline to Live; the existing DOM was preserved and a later external update synchronized successfully.

A view collection using a filtered SQL query displayed Auto and synchronized an external price change through polling; only the price cell changed, while its row, table, and unchanged contents retained identity. A native Save and continue updated only the name and automatic update-date cells and preserved the correct total. With Hooks Manager, Cron Manager, and Update Notifier installed together, the Hooks menu/page, Cron Manager controls, and native version credits remained available. No new browser errors were observed during these checks.

Light and dark layouts were inspected, and switching to dark mode retained the existing table and field nodes. An insertion above a scrolled viewport preserved the visible row at the same pixel offset and kept the existing selection. The test session was signed out and the disposable server was stopped after validation.

The row highlights were subsequently checked in the same isolated v0.40.4 instance. Green entries and blue updates cleared after approximately 1.5 seconds in both themes. Another changed value extended the active highlight; unchanged manual refresh and Load more did not introduce or restart highlights. Sorting and collection navigation cleared active highlights. DOM comparisons retained the table, existing rows, unchanged field contents, and selection. Measurements are recorded under `highlightValidation` in the browser results.

Linux installers have not been executed. No PocketBase source changes, frontend builds, npm commands, or package installation were used. Compatibility with custom dashboards and future upgrades remains unverified. Additional manual checks should cover narrow screens, JSON export, and application-specific field types and filters. The in-app browser did not expose the attempted JSON download as a capturable download event, so its generated file has not been verified.

Integration references:

- [Native Collections page and footer](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/collections/pageCollections.js).
- [Native record list and field rendering](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/records/recordsList.js).
- [Dashboard extension loading before router initialization](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/main.js).
- [Native dashboard extension serving](https://github.com/pocketbase/pocketbase/blob/v0.40.3/apis/extensions.go).
- [PocketBase realtime API](https://pocketbase.io/docs/api-realtime/).

# PB Hooks Manager

Adds a **Hooks** page to the **PocketBase v0.40.3** admin dashboard menu. The page lets you list, open, create, edit, and delete files in the instance's hooks directory, using the layout, form controls, and CSS classes already available in the dashboard.

Installation consists of copying three files and restarting the instance using your usual procedure. No additional flags, recompilation, executable replacement, package installation, collection changes, or migrations are required. The plugin does not modify the database.

**Save draft** saves changes persistently outside `pb_hooks`. **Apply changes** lets you confirm and apply all saved changes in a single dashboard action. Only applying changes modifies the actual hook files; saving drafts does not trigger the hooks watcher.

## Installing on an existing instance

1. Make sure the instance uses the official **PocketBase v0.40.3** executable, with the admin dashboard and JavaScript hooks enabled.
2. **Stop the instance manually using your usual method.** Copying the plugin files while the native watcher is active may trigger a restart before installation is complete.
3. Extract the package and **merge** its `pb_hooks` directory into your existing hooks directory. Preserve all existing files. In a default installation, this directory sits alongside the executable and `pb_data`.
4. Start the instance using your usual method, without adding any arguments for the plugin. Open the admin dashboard, sign in as a superuser, and press **Ctrl+Shift+R** to reload the dashboard assets. **Hooks** will appear in the top menu, at `/_/#/hooks`.

Installed directory structure:

```text
pocketbase or pocketbase.exe
pb_data/
pb_hooks.drafts/             created automatically; persistent private data
pb_hooks/
    your_existing_files.pb.js
    pb_hooks_manager.pb.js
    pb_hooks_manager/
        api.js
        ui/
            main.js
```

If you use `--hooksDir`, copy **the contents** of the package's `pb_hooks` directory into that directory, without creating another `pb_hooks` directory inside it. The plugin uses the actual directory provided by the runtime (`__hooks`). Without `--hooksDir`, PocketBase resolves the location as `pb_data/../pb_hooks`; a custom data directory setting may change this location.

Drafts are stored in a sibling directory whose path is the configured hooks directory path with `.drafts` appended: for example, `pb_hooks.drafts/state.json`. The apply journal is stored in `pb_hooks.drafts/apply.json`. The process must be able to create and write to this directory. It is outside `pb_data`; include it in your external backups if you want to retain drafts. All superusers share the saved changes, with revision checks to detect conflicts.

In Docker, keep both the hooks directory and its sibling drafts directory on persistent storage. The parent directory must allow the drafts directory to be created, or you must create or mount it beforehand. If PocketBase runs as a service, use your usual stop and start procedure. The plugin does not run process manager commands.

The PocketBase process needs read and write permissions for the hooks directory. File creation uses hard links to reject names that already exist, so the filesystem must support them.

## Viewing and managing files

**Hooks** appears before **Settings** in the top menu. The sidebar shares its width preference with **Collections** and **Settings**: resizing it on any of these pages sets the width used when navigating to the others. Form labels sit inside the fields, following the native dashboard styling. The content field uses a monospace textarea, as in **Import collections**, that fills the remaining page height and scrolls internally for long files. Refresh and Copy use matching native circular buttons in the header. Below the editor, usage guidance is aligned to the left and the file or draft timestamp and size to the right in the same row.

- **View:** entering Hooks automatically opens the first file in the list. If there are no files, the page opens **New file**. Unsaved editing retained in the tab takes priority when you return to the page. The list and selected file are checked every three seconds while the tab is visible. Changes made by another administrator or directly on the server appear in subsequent checks. This uses polling, not a WebSocket connection, and does not guarantee instant updates.
- **Refresh and copy:** **Refresh files** reloads the selected file and updates the list, asking for confirmation before discarding unsaved editing or a conflict. While creating a new file, it updates only the list and preserves the editor. The **Copy** icon beside it copies the current editor content, including unsaved changes. Automatic checks never discard unsaved editing.
- **Create:** click **New file**, choose an existing folder under **Directory**, enter a name, and click **Save draft**. The new file is created in `pb_hooks` only when you apply the changes. For `lib/orders.js`, choose `lib` and enter `orders.js` as the name.
- **Edit:** open a file, change its contents, and click **Save draft**. The draft is persisted on the server without modifying the active hook file. Ctrl+S also saves only the draft.
- **Delete:** click **Stage deletion**. An existing file is marked for deletion and removed only when you apply the changes. For a new file that exists only as a draft, this action discards the draft.
- **Discard:** **Discard saved draft** removes the pending change and preserves the file in `pb_hooks`, including when canceling a pending deletion.
- **Apply:** review the `create`, `update`, and `delete` indicators, click **Apply changes**, and confirm the batch. Save or discard any unsaved editing before applying changes.

The plugin supports UTF-8 text without null characters, up to **1 MiB per file**, with the extensions `.js`, `.ts`, `.mjs`, `.cjs`, `.json`, `.txt`, `.md`, `.html`, and `.css`. Up to **100 drafts** are allowed, with a combined content limit of **8 MiB**. The file list uses names and metadata; opening a file with a supported extension may still be rejected because of its size or encoding. Paths are limited to 1,024 characters and 20 segments. Listing stops with an error if traversal exceeds 10,000 entries.

An extension being supported by the editor does not mean PocketBase executes it. In the default runtime, hooks loaded at startup must be directly in the root of `pb_hooks` and end in `.pb.js` or `.pb.ts`. Files in subdirectories are executed only if imported by hooks. The `.pb.ts` extension does not enable TypeScript compilation.

Hidden files and directories, `node_modules`, symbolic links, and the plugin's own files are blocked. The hooks root and its sibling drafts directory must be actual directories, not symbolic links; the hooks root cannot be a filesystem root. This keeps the sibling directory outside the watched tree. The plugin does not support renaming files or managing directories. Its internal files are protected so that editing them through the manager cannot break the manager itself.

If another administrator changes the version you have open, the editor preserves your content and reports the conflict. Saving, staging a deletion, and discarding a draft require the revision returned when that version was read. Whenever a saved draft exists, opening or refreshing the file shows that draft. Without a pending draft, **Refresh files** reads the active file from `pb_hooks`. Refreshing does not discard a saved draft; use **Discard saved draft** for that action. If the selected file or draft was removed, confirming refresh clears the editor and opens the first available file, or **New file** if the list is empty.

When a draft is first saved, the revision of the actual file is stored with it. Applying changes checks that revision again: if the actual file has changed, the batch is rejected before any file is modified. Copy your content, discard the saved draft, open the current version, and reconcile the changes. Even if the actual file becomes missing or unreadable, the saved draft remains available to view or discard.

Unsaved editing is retained only in the tab's memory when navigating between pages and is discarded when switching users or closing the tab. Drafts saved on the server survive browser closure and instance restarts.

## Applying a batch and restarting

**Applying changes uses a single confirmed request, not an atomic transaction across multiple files.** The plugin validates all target files before starting and records the intent and completion of each operation in a separate progress journal. The journal is small; the full draft contents are not rewritten for every file applied.

On Linux, the native watcher may restart PocketBase while changes are being applied. Disk errors, forced termination, or a restart can leave a batch partially applied. After a disconnection, the dashboard checks the persisted journal, shows how many file operations were confirmed, and retains the remaining drafts. Clicking **Apply changes** again resumes the pending changes after another confirmation. If an operation wrote a file but was interrupted before its completion was recorded, resuming compares the actual contents with the intended contents to avoid repeating an already completed change. Drafts are not automatically applied at startup, and changes to actual files are not automatically rolled back.

The **Restart PocketBase** button is available only when the server is identified as Linux. It requires superuser authentication, explicit confirmation, no pending drafts, and the current instance identifier. It uses the native restart mechanism, which reuses the executable, arguments, and environment. The dashboard confirms a restart only after detecting a different startup identifier; HTTP 202 means only that the request was accepted. If it cannot confirm the restart within about a minute, it asks you to check the server outside the plugin. Linux detection uses `/proc/sys/kernel/ostype`; if it is unavailable, only this button and its API operation are disabled.

**On Windows**, applying changes modifies the files, but you must restart PocketBase outside the plugin. The restart button is also unavailable on other operating systems; the native watcher's behavior remains unchanged. The plugin does not block restarts globally, intercept application shutdown, or change backup restoration.

**Writing changes to disk does not reload hooks that have already been registered.** If the instance does not restart automatically, restart it to load the changes. Modules imported with `require()` may also remain cached. The manager does not execute saved code or validate it through a test run.

A syntax error or a change to a hook's initialization code can prevent PocketBase from starting again. If that happens, fix the file directly on the server and start the instance using your usual procedure.

## Access and file protection

All file operations require native superuser authentication. The frontend uses the dashboard session and the existing PocketBase client; the plugin has no separate account or password.

JavaScript hooks run with the privileges of the PocketBase process. Allowing a superuser to edit hooks therefore lets them change code executed on the server. This capability must not be exposed to ordinary users of auth collections.

The plugin restricts editable files to the hooks directory and keeps drafts in its private sibling directory. It rejects paths that escape the allowed directory and symbolic links, and protects its own files. The public dashboard extension serves only `pb_hooks_manager/ui`. **Never expose `pb_hooks` or `pb_hooks.drafts` through `publicDir` or your proxy.** Hook and draft contents are retrieved through the authenticated API.

Revisions use SHA-256, and writes are coordinated across the plugin's clients. Updating a file prepares a temporary file, syncs its contents, and renames it to the target path. Creating a file uses a hard link to publish it without overwriting an existing name. If the write succeeds but temporary file cleanup fails, the message states that the file was saved; reload it before trying again. This does not coordinate external editors, other processes, or operating system administrators: an external change between validation and the final operation can still cause a race condition. Filesystem transactions and atomic renames are not guaranteed across all platforms, especially Windows.

## API

Base path: `/api/pb-hooks-manager`. All routes require superuser authentication. Mutating operations accept JSON and are validated by the backend, regardless of the interface state.

| Method and path               | Purpose                                                                  | Input                                                           |
| ----------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `GET /files`                  | Lists files, drafts, and batch status                                    | No body                                                         |
| `GET /file?path=orders.pb.js` | Reads the saved draft, or the actual file if no draft exists             | URL-encoded `path` query parameter                              |
| `POST /file`                  | Saves a draft for a new file                                             | `path` and `content` in JSON                                    |
| `PUT /file`                   | Saves an edit as a draft                                                 | `path`, `content`, and `revision` in JSON                       |
| `DELETE /file`                | Stages a deletion or cancels a pending creation                          | `path` and `revision` in JSON                                   |
| `POST /discard`               | Discards only the saved draft                                            | `path` and `revision` in JSON                                   |
| `POST /apply`                 | Applies all saved drafts                                                 | `confirm: true`, the batch `revision`, and a unique `requestId` |
| `GET /status`                 | Retrieves batch status, the latest progress, and the instance identifier | No body                                                         |
| `POST /restart`               | Requests a native restart, on Linux only                                 | `confirm: true` and the current `bootId`                        |

Use the revision returned by the most recent read. An outdated revision, or an existing name when creating a file, returns HTTP 409. If another file operation is in progress, the API returns HTTP 423; try again later. Do not retry an update by automatically replacing the revision without reviewing the current contents.

`POST /apply` may return a progress status of `complete` or `partial`; HTTP 200 alone does not mean the entire batch was applied. A subsequent status check identifies an unfinished journal as `interrupted`. If all expected operations were already confirmed, it recognizes completion even if final state compaction was interrupted. Confirmed file operations are listed in `apply.completed`, and `pendingCount` reports the remaining drafts. Reusing the last apply request's identifier only retrieves its result; a confirmed attempt to resume uses a different identifier. The dashboard does not automatically retry mutations after a network failure.

## Updating and uninstalling

To update, stop the instance manually, replace only the three plugin files, start it using your usual procedure, and reload the dashboard with Ctrl+Shift+R. Version 1.1 does not require the watcher option used by the previous version. Leaving the watcher disabled is your choice and also works with the save/apply workflow.

To uninstall, stop the instance manually and remove **only** `pb_hooks/pb_hooks_manager.pb.js`, `pb_hooks/pb_hooks_manager/api.js`, and `pb_hooks/pb_hooks_manager/ui/main.js`. Remove the `ui` and `pb_hooks_manager` directories only if they are empty and belong to this installation. Preserve all other hooks and start the instance again. There are no plugin collections or migrations to roll back.

The sibling `pb_hooks.drafts` directory contains drafts and apply progress saved by users. Keep it for reinstallation, or remove it separately only after deciding to discard all drafts. Its contents are never applied automatically during installation or updates.

## Compatibility and validation

This release targets **PocketBase v0.40.3**. The integration uses the native dashboard extensions API, which is marked as experimental upstream. Compatibility with older versions, custom executables, or builds without the dashboard has not been implemented. Validate any new PocketBase version before upgrading an installation that depends on this plugin.

The implementation was developed by reviewing the source code for that version. **No tests, builds, or server runs were performed during development.**

References for the target version:

- [Registering extensions in the HTTP server startup event](https://github.com/pocketbase/pocketbase/blob/v0.40.3/core/events.go).
- [Native dashboard extension serving](https://github.com/pocketbase/pocketbase/blob/v0.40.3/apis/extensions.go).
- [Loading extensions before initializing the router](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/main.js).
- [Dashboard routes and authenticated access](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/router.js).
- [Official executable initialization](https://github.com/pocketbase/pocketbase/blob/v0.40.3/examples/base/main.go).
- [JavaScript hook loading and watching](https://github.com/pocketbase/pocketbase/blob/v0.40.3/plugins/jsvm/jsvm.go).

PocketBase is distributed under the [MIT license, with attribution to Gani Georgiev](https://github.com/pocketbase/pocketbase/blob/v0.40.3/LICENSE.md). That license belongs to the upstream project; this plugin's package does not include the PocketBase executable or its full source code.

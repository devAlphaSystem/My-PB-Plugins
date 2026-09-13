# PB Update Notifier

Adds an **Update available: v...** link immediately after the current PocketBase version in the admin dashboard footer. The link opens the corresponding official GitHub release in a new tab. The current version and Docs link remain in place.

The plugin follows the same three-file structure as Hooks Manager and Cron Manager and works independently of both. It extends the native `app.store.creditLinks` list, so the same notice appears on every page using the dashboard's credits component, including the Hooks page. It uses the existing typography, icons, link styling, and light/dark theme.

## Installing on an existing instance

With PocketBase stopped, run this **from the instance's directory or directly inside its `pb_hooks` directory** on Linux:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Update%20Notifier/install.sh | bash'
```

The standalone installer installs or replaces only this plugin's three files. It uses the current directory if named `pb_hooks`; otherwise it uses or creates a direct child named `pb_hooks`. Like the other installers, it requires Bash, curl, GNU tar, gzip, and GNU coreutils. The download command becomes available after this package is published to the repository's `main` branch.

For manual installation:

1. Use the official **PocketBase v0.40.3** executable with its native admin dashboard and JavaScript hooks enabled.
2. Stop the instance using your usual procedure. Copying files while the hooks watcher is active may restart the instance before installation finishes.
3. Merge this package's `pb_hooks` directory into the instance's existing hooks directory, preserving all other files.
4. Start the instance, sign in as a superuser, and reload the dashboard with **Ctrl+Shift+R**. Open any page with the native footer, such as Collections.

Installed directory structure:

```text
pocketbase or pocketbase.exe
pb_data/
pb_hooks/
    your_existing_files.pb.js
    pb_update_notifier.pb.js
    pb_update_notifier/
        api.js
        ui/
            main.js
```

For a custom `--hooksDir`, copy the contents of this package's `pb_hooks` directory directly into that directory. The plugin uses the runtime's actual `__hooks` path. No extra flags, packages, compilation, collections, migrations, or writable storage are required. The PocketBase process needs read access to the installed files and outbound HTTPS access to `api.github.com`.

## Update checks

- The first check runs when an authenticated superuser opens the dashboard in a visible, online tab. Checks resume when returning to the tab or reconnecting.
- The backend requests GitHub's latest full release for `pocketbase/pocketbase`. Drafts, prereleases, and invalid version tags are rejected. It uses the release designated as latest, rather than the first entry in the releases list, which may belong to a backport branch.
- A successful response is cached in server memory for **one hour**, shared across tabs and superusers. Only one outbound check runs at a time. An open, visible dashboard checks again when that cache expires; this is polling, not an instant release notification.
- The version comes from the native footer's existing `PocketBase v...` credit entry. Comparison uses numeric major, minor, and patch components. Equal or older releases do not show a notice. Build metadata does not affect ordering; a full release is newer than a prerelease with the same version numbers.
- Clicking the notice opens the release notes. The plugin does not install an update, download a binary, execute shell commands, or restart PocketBase.
- Signing out removes the notice and stops scheduled checks. Responses from an earlier user session are ignored.

For example, a footer showing `PocketBase v0.40.3` gains **Update available: v0.40.4** when GitHub returns that newer release. No notice is added when both versions are `v0.40.4`.

GitHub requests have a **10-second timeout**. Network failures or invalid responses produce HTTP 503 and are cached for **15 minutes**; HTTP 403 and 429 responses defer the next outbound attempt for **one hour**. Concurrent checks return HTTP 423 and are retried by the dashboard after 15 seconds. Failed checks clear the notice and retry without recurring error toasts. **The absence of a notice does not prove that the instance is up to date when checks are failing.**

The cache is discarded when PocketBase restarts. It is not stored in the database or on disk. Requests to GitHub use fixed public request headers and never forward the dashboard session or require a GitHub token. After upgrading PocketBase, reload the dashboard to refresh its displayed version before checking the notice.

## API

`GET /api/pb-update-notifier/latest` requires native superuser authentication and accepts no input. A successful response contains:

| Field               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `latestVersion`     | Validated stable release tag from the official repository. |
| `checkedAt`         | Successful GitHub check time as Unix milliseconds.         |
| `retryAfterSeconds` | Seconds remaining until the server cache expires.          |

HTTP 423 indicates a check is already running. HTTP 503 indicates the last release check failed. Both include a `Retry-After` header. Successful polling requests skip the activity log using the same middleware as the other plugins.

## Compatibility and validation

The implementation targets the official **PocketBase v0.40.3** dashboards. Their native credits components were compared and are identical. Custom dashboards that change or remove the standard version credit are not supported. The dashboard extension API is experimental upstream; review compatibility before adopting a future version.

Validation consisted of static code review, checking integration references, and reading the public GitHub release response. **No tests, builds, installer runs, or PocketBase server runs were performed.**

Manual verification after installation should cover a newer release, the same version, an older release, numeric ordering such as `0.40.9` to `0.40.10`, navigation between Collections/Settings/Hooks, sign-out/sign-in, concurrent tabs, network failures, and light/dark and narrow layouts.

Integration references:

- [Native credits component](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/base/credits.js).
- [Shared dashboard store and credit links](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/store.js).
- [Native dashboard extension serving](https://github.com/pocketbase/pocketbase/blob/v0.40.3/apis/extensions.go).
- [PocketBase HTTP request helper](https://pocketbase.io/docs/js-sending-http-requests/).
- [GitHub latest release endpoint](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

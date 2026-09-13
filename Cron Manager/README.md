# PB Cron Manager

Extends the existing list in **Settings > Crons** in the **PocketBase v0.40.3** admin dashboard. Create JavaScript routines, edit their schedules, pause or resume them, run them manually, and review persistent execution history using controls on their original list rows. The plugin uses the dashboard's existing components and CSS classes and preserves the native settings sidebar. Each job appears once; paused or unregistered managed jobs remain visible in the same list so they can be edited or resumed.

Installation consists of copying three files and restarting the instance using your usual procedure. No additional flags, recompilation, executable replacement, packages, collections, or migrations are required. The plugin works independently of PB Hooks Manager.

## Installing on an existing instance

On Linux, you can use the [one-command installer](../README.md#one-command-installation-on-linux) instead of copying the files manually. With PocketBase stopped, run this **from the instance's directory or directly inside its `pb_hooks` directory**:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Cron%20Manager/install.sh | bash'
```

The command runs this folder's standalone `install.sh` and installs or updates only this plugin's three files. If the current directory is named `pb_hooks`, it installs there; otherwise, it uses the direct child `pb_hooks`, creating it if missing. Start PocketBase and reload the dashboard afterward. Requirements and failure handling are documented in the linked installation guide.

For manual installation:

1. Use the official **PocketBase v0.40.3** executable with the admin dashboard and JavaScript hooks enabled.
2. **Stop the instance manually using your usual method.** Copying hook files while the watcher is active may trigger a restart before installation is complete.
3. Merge this package's `pb_hooks` directory into your instance's existing hooks directory, preserving all other files.
4. Start the instance using your usual method. Sign in as a superuser, reload the dashboard with **Ctrl+Shift+R**, and open **Settings > Crons**, at `/_/#/settings/crons`.

Installed directory structure:

```text
pocketbase or pocketbase.exe
pb_data/
    pb_cron_manager/              created automatically; private persistent data
        jobs.json
        history.json
pb_hooks/
    your_existing_files.pb.js
    pb_cron_manager.pb.js
    pb_cron_manager/
        api.js
        ui/
            main.js
```

If you use `--hooksDir`, copy the contents of the package's `pb_hooks` directory into that directory. Do not create another nested `pb_hooks` directory. The plugin uses the runtime's actual hooks directory (`__hooks`). A custom data directory also changes where `pb_cron_manager/jobs.json` and `history.json` are stored: they are always inside the configured data directory.

The PocketBase process needs permission to read the installed files and create and write its private data directory. In Docker, keep the data directory on persistent storage. Back up the plugin's data together with the instance data. Do not expose these files through `publicDir` or your proxy; they contain executable code and execution details.

## Managing routines

- **Create:** click **New cron** at the bottom of the list and enter a name, schedule, and JavaScript code. New jobs are paused by default, so saving a new routine does not immediately schedule it.
- **Edit:** change the code, name, or schedule and save. Changes to an enabled job update its registration immediately.
- **Pause or resume:** paused jobs remain saved and visible in the list but are removed from the active scheduler. Resuming registers the saved schedule again. Pausing prevents future starts; it does not interrupt code that is already running.
- **Run manually:** confirm the action to run the saved code once. Manual execution is also available for paused jobs and does not enable their schedule.
- **Delete:** confirm removal of a managed job. Its schedule and saved definition are removed; its retained execution history remains available until it ages out of the history limit.

The editor follows the native record drawer, with all fields in its scrollable body. The save button's menu offers **Save and continue** (also available with Ctrl+S or Cmd+S) and **Reset form**, which restores the last loaded or saved values without writing to the server.

Saving, changing a schedule, pausing, resuming, and deleting use PocketBase's native cron registration API. These operations do not edit `pb_hooks` or require a restart. Enabled jobs are restored at startup. Missed schedules are not replayed after downtime.

The plugin manages only the jobs it creates, using native cron identifiers prefixed with `pb_cron_manager.`. The manager's API uses each job's generated 20-character identifier without that prefix. Existing jobs registered by PocketBase, Go code, or other hooks remain in the native list with their existing controls. The manager does not import, edit, pause, or delete those jobs, and it does not change the global cron interval or timezone.

The original list's refresh button updates both native registrations and managed job metadata. The history icon beside it opens the history for all managed jobs. The header icons and full-width creation button at the bottom of the list follow the native Backups layout. Search covers job names, native identifiers, and expressions. Managed rows display their saved name, with a badge for paused, running, or registration error states. Hover over the name to see its native identifier; execution details are available through the row's history button. Renaming a job does not change its identifier or history association. Adding paused rows to the dashboard does not register placeholder jobs in the scheduler or change the native cron API response.

All superusers share the saved jobs and history. Revision checks prevent one administrator from silently overwriting a version another administrator changed. On a conflict, read the current version and reconcile your edits before saving again. The backend refuses edits and deletion while that job is running.

Registration in memory and saving the definition to disk are not a single transaction. A scheduled callback dispatched during an update may be ignored when its revision no longer matches the saved definition. Missed executions are not retried; the manager does not guarantee exactly-once execution. If a job reports a registration error, correct its expression or JavaScript and save it again to retry registration.

If initialization fails because the plugin cannot read or write its storage, the dashboard keeps a startup error reminder for the current instance. Restoring file access does not clear that reminder or automatically restore every saved schedule. Correct the storage problem, then restart PocketBase using your usual method so the plugin can load all saved jobs and register the enabled ones.

## Schedules

Schedules use PocketBase's native five-field format:

```text
minute  hour  day-of-month  month  day-of-week
0-59    0-23  1-31          1-12   0-6
```

Sunday is `0`, and Saturday is `6`. Supported forms include wildcards (`*`), ranges (`1-5`), steps (`*/5` or `1-20/2`), and comma-separated lists (`1,10,20`). Seconds, month names, weekday names, and Sunday as `7` are not supported.

The dashboard provides common schedule presets. You can also enter a custom expression or a native macro: `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, or `@annually`.

| Expression    | Schedule                                   |
| ------------- | ------------------------------------------ |
| `*/5 * * * *` | Every five minutes                         |
| `0 * * * *`   | At the start of every hour                 |
| `0 9 * * 1-5` | At 09:00, Monday through Friday            |
| `0 0 1 * *`   | At midnight on the first day of each month |

PocketBase uses **UTC by default**. If application code changes the scheduler's timezone, that timezone also applies to managed jobs. The browser's timezone does not determine when jobs run, and the plugin does not provide a separate timezone per job.

PocketBase requires **both** the day-of-month and day-of-week fields to match when both are restricted. For example, `0 9 1 * 1` runs at 09:00 only when the first day of the month is a Monday. This differs from cron implementations that treat those two restrictions as alternatives. See the native [schedule parser](https://github.com/pocketbase/pocketbase/blob/v0.40.3/tools/cron/schedule.go) and [scheduler](https://github.com/pocketbase/pocketbase/blob/v0.40.3/tools/cron/cron.go).

## Writing JavaScript routines

Enter the body of a synchronous JavaScript function, not a `cronAdd()` registration or a `.pb.js` hook file. The manager registers the schedule and calls your code. It provides `$app`, read-only job metadata as `job` (`id`, `name`, and `expression`), and `log(message)` for messages included in the execution history. Pass a string, number, or boolean to `log`; format objects as strings yourself when appropriate. The normal PocketBase JavaScript runtime globals, including `__hooks`, remain available.

Start with a routine that only records a message:

```javascript
log("Routine executed successfully.");
```

Save it paused, run it manually, and inspect its history before enabling a schedule. Use the [PocketBase JavaScript documentation](https://pocketbase.io/js-overview/) when writing routines that access records, files, or external services. This is PocketBase's JavaScript runtime, not Node.js or a browser.

Job code runs synchronously with the permissions of the PocketBase process; asynchronous functions and promises are not supported. There is **no sandbox, execution timeout, or cancellation control**. Use only code trusted by the instance's administrators. A long-running or nonterminating routine can keep execution resources occupied. The manager does not wrap your database or external changes in a transaction or roll them back after an error.

Only one execution of a given managed job can run at a time, including manual and scheduled starts. This protection does not serialize different jobs or prevent changes made by other application code. A pause does not cancel a running job, and a restart can interrupt it after some of its side effects have already happened.

## Execution history

The complete history and the history for an individual job share the same drawer. Executions use the dashboard's native grouped accordions, with the job name, timestamp, and status in each summary. Expanded entries show a responsive details table and read-only Error and Logs fields.

The manager saves a running entry before executing code and records completion or failure afterward. History persists across dashboard reloads and instance restarts. The interface refreshes its data by polling; updates are not a WebSocket stream. Messages passed to `log(message)` are captured within the limits below. Avoid logging credentials or sensitive record contents.

Manual execution uses a synchronous HTTP request: the response waits for the routine to finish. A lost connection or client timeout **does not mean the routine was canceled**. Check the history before deciding whether to run it again. Manual requests include an identifier so retrying the same request does not intentionally start another execution while its record remains in retained history. This is bounded deduplication, not a permanent guarantee of exactly-once execution.

When history is read, an entry still recorded as running from an earlier instance startup is marked **Interrupted**. If the entry belongs to the current startup but its execution is no longer active and its result could not be saved, it is marked **Unconfirmed** instead.

Both states leave the completion time empty and the duration unknown (`finished: ""` and `durationMs: null` in the API); the dashboard displays **Unknown** for those values. Neither state proves whether the code succeeded, failed, or completed some or all of its side effects. Inspect the affected data or external system before running the job again. The plugin does not retry these executions automatically.

History covers managed jobs only. The native cron list can trigger other registered routines, but its successful trigger response does not report whether their code finished successfully, and the plugin cannot reconstruct their results. The upstream [cron API](https://github.com/pocketbase/pocketbase/blob/v0.40.3/apis/cron.go) launches native trigger requests asynchronously.

In the unified dashboard list, a managed job's **Run now** button uses the manager's confirmed execution endpoint and records `trigger: "manual"`. Other native jobs retain their original run action. A timer tick or a direct call to the native `/api/crons/{nativeId}` endpoint for a managed job still records `trigger: "schedule"`: the native callback does not distinguish those two sources.

| Limit                           | Value                                                    |
| ------------------------------- | -------------------------------------------------------- |
| Saved managed jobs              | 50                                                       |
| Job name                        | 120 characters; unique among managed jobs, ignoring case |
| Cron expression                 | 128 characters                                           |
| JavaScript source per job       | 32 KiB                                                   |
| Retained execution records      | 200 across all managed jobs                              |
| Captured messages per execution | 10                                                       |
| Length of each captured message | 256 characters                                           |

History is a bounded operational record, not an archival audit log. Keep a separate logging or audit mechanism if your application needs longer retention or stronger delivery guarantees.

## API

Base path: `/api/pb-cron-manager`. All endpoints require native superuser authentication. The frontend uses the existing dashboard session. Mutations accept JSON and are validated by the backend even when called outside the dashboard.

| Method and path          | Purpose                                       | Input                                                      |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------- |
| `GET /jobs`              | Lists job metadata                            | No body                                                    |
| `GET /jobs/{id}`         | Reads a job, including its code               | Job identifier in the path                                 |
| `POST /jobs`             | Creates a managed job                         | `name`, `expression`, `code`, and boolean `enabled`        |
| `PUT /jobs/{id}`         | Updates a managed job                         | All four configuration fields and the last read `revision` |
| `DELETE /jobs/{id}`      | Removes a managed job                         | `confirm: true` and `revision`                             |
| `POST /jobs/{id}/toggle` | Pauses or resumes a job                       | `enabled` and `revision`                                   |
| `POST /jobs/{id}/run`    | Runs saved code once and waits for completion | `confirm: true`, `revision`, and a unique `requestId`      |
| `GET /history`           | Reads retained execution history              | Optional `jobId` query parameter                           |

Use the revision returned by the most recent read. Do not automatically substitute a newer revision after a conflict. A manual `requestId` must contain exactly 32 letters or digits. A completed manual request returns HTTP 200 with a `run` object; inspect that record's status to determine whether execution succeeded. A successful HTTP response is not a guarantee that job code succeeded.

## Compatibility and validation

This release targets the official **PocketBase v0.40.3** executable. The native dashboard extension API is experimental upstream. Compatibility with older versions, custom builds, or builds without the dashboard has not been implemented. Validate a new PocketBase release before upgrading an instance that depends on this plugin.

The plugin does not modify the PocketBase executable, core code, authentication rules, collections, backup behavior, or unrelated cron registrations. Managed JavaScript routines can themselves change application data or behavior according to the code an administrator saves.

The plugin disables caching for its public dashboard assets and the shared `/_/extensions.js` entry point so updates can be reloaded. That entry point also includes other installed dashboard extensions; their own asset cache settings are not changed.

Development includes static review against the target version's source code. **No tests, builds, or server runs were performed.**

Integration references:

- [Native Crons settings page](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/settings/crons/pageCronsSettings.js).
- [Native registered cron list](https://github.com/pocketbase/pocketbase/blob/v0.40.3/ui/src/settings/crons/cronsList.js).
- [Dashboard extension serving](https://github.com/pocketbase/pocketbase/blob/v0.40.3/apis/extensions.go).
- [JavaScript runtime](https://github.com/pocketbase/pocketbase/blob/v0.40.3/plugins/jsvm/jsvm.go).

PocketBase is distributed under the [MIT license, with attribution to Gani Georgiev](https://github.com/pocketbase/pocketbase/blob/v0.40.3/LICENSE.md). That license belongs to the upstream project; this plugin does not include the PocketBase executable or its full source code.

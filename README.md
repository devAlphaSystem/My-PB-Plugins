# PocketBase Plugins

A collection of plugins I created for my personal use, bringing extra tools to the PocketBase admin dashboard while keeping its native look and feel.

For Linux installation, stop PocketBase and run the desired command from your instance's directory or directly inside its `pb_hooks` directory. The installers require Bash, curl, GNU tar, gzip, and GNU coreutils.

The installers select the destination based on the current working directory:

- If the current directory is named `pb_hooks`, install there.
- Otherwise, use its direct child named `pb_hooks` if it exists.
- If that child does not exist, create `pb_hooks` in the current directory and install there.

The installers do not search recursively. The selected `pb_hooks` must be a real directory, not a file or symbolic link, and allow write and traversal access. Creating it also requires write and traversal access to the current directory. The same single command handles all three cases.

## [Hooks Manager](Hooks%20Manager/README.md)

Adds a **Hooks** page to browse, create, edit, and delete hook files. Save drafts before applying changes to `pb_hooks`.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Hooks%20Manager/install.sh | bash'
```

or

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/install.sh | bash -s -- "$@"' -- --hooks-manager
```

## [Cron Manager](Cron%20Manager/README.md)

Extends **Settings > Crons** with tools to create JavaScript jobs, edit schedules, pause or resume jobs, run them manually, and view execution history for managed jobs.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Cron%20Manager/install.sh | bash'
```

or

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/install.sh | bash -s -- "$@"' -- --cron-manager
```

## [Update Notifier](Update%20Notifier/README.md)

Checks the latest official PocketBase release and adds an **Update available: v...** link beside the current version in the dashboard footer. Checks use a shared server cache and the native superuser session.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Update%20Notifier/install.sh | bash'
```

or

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/install.sh | bash -s -- "$@"' -- --update-notifier
```

## [Collections Live](Collections%20Live/README.md)

Keeps the **Collections** record list and its total current using PocketBase realtime events. Changes update the affected rows while preserving the table, loaded records, and selection.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Collections%20Live/install.sh | bash'
```

or

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/install.sh | bash -s -- "$@"' -- --collections-live
```

After installation, start PocketBase and reload the admin dashboard with **Ctrl+Shift+R**. The new plugin's download commands become available after its package is published to `main`.

## Install multiple plugins on Linux

Use the root `install.sh` to install or update any combination of plugins in one command. To select all four:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/install.sh | bash -s -- "$@"' -- --hooks-manager --cron-manager --update-notifier --collections-live
```

| Argument             | Plugin           |
| -------------------- | ---------------- |
| `--hooks-manager`    | Hooks Manager    |
| `--cron-manager`     | Cron Manager     |
| `--update-notifier`  | Update Notifier  |
| `--collections-live` | Collections Live |

Keep the `--` after the closing quote: it lets Bash forward all following plugin flags to the installer. Use `--help` instead of plugin flags to display usage without installing.

The script validates every argument before starting, requires at least one plugin, and ignores repeated flags. It runs the existing standalone installers in the order requested, preserving their destination checks and file handling. Keep PocketBase stopped until the entire command finishes.

If a download or installation fails, the command stops with an error and skips the remaining plugins. Completed installations are not rolled back; the failing plugin may also have replaced some files. Keep PocketBase stopped, resolve the error, and rerun the command.

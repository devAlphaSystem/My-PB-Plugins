# PocketBase Plugins

A collection of plugins I created for my personal use, bringing extra tools to the PocketBase admin dashboard while keeping its native look and feel.

For Linux installation, stop PocketBase and run the desired command from inside your instance's `pb_hooks` directory. The installers require Bash, curl, GNU tar, gzip, and GNU coreutils.

## [Hooks Manager](Hooks%20Manager/README.md)

Adds a **Hooks** page to browse, create, edit, and delete hook files. Save drafts before applying changes to `pb_hooks`.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Hooks%20Manager/install.sh | bash'
```

## [Cron Manager](Cron%20Manager/README.md)

Extends **Settings > Crons** with tools to create JavaScript jobs, edit schedules, pause or resume jobs, run them manually, and view execution history for managed jobs.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Cron%20Manager/install.sh | bash'
```

After installation, start PocketBase and reload the admin dashboard with **Ctrl+Shift+R**.

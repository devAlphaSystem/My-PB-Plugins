#!/usr/bin/env bash

{
    set -euo pipefail

    fail() {
        printf 'Error: %s\n' "$*" >&2
        exit 1
    }

    usage() {
        printf '%s\n' \
            'Usage: bash install.sh [--hooks-manager] [--cron-manager] [--update-notifier]' \
            '' \
            'Select one or more plugins to install or update:' \
            '  --hooks-manager    Install Hooks Manager.' \
            '  --cron-manager     Install Cron Manager.' \
            '  --update-notifier  Install Update Notifier.' \
            '  --help, -h         Show this help without installing.'
    }

    packages=()
    show_help=false
    for argument in "$@"; do
        case "$argument" in
            --hooks-manager) package='Hooks Manager' ;;
            --cron-manager) package='Cron Manager' ;;
            --update-notifier) package='Update Notifier' ;;
            --help|-h) show_help=true; continue ;;
            *) usage >&2; fail "Unknown argument: $argument." ;;
        esac

        if [[ " ${packages[*]} " != *" $package "* ]]; then
            packages+=("$package")
        fi
    done

    if [[ $show_help == true ]]; then
        usage
        exit 0
    fi
    if [[ ${#packages[@]} -eq 0 ]]; then
        usage >&2
        fail 'Select at least one plugin.'
    fi

    for dependency in uname curl bash; do
        command -v "$dependency" >/dev/null 2>&1 || fail "Required command is missing: $dependency."
    done

    [[ $(uname -s) == Linux ]] || fail 'This installer requires Linux.'

    printf 'Keep PocketBase stopped until all selected plugins have finished installing.\n'

    for package in "${packages[@]}"; do
        if ! curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
            "https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/${package// /%20}/install.sh" \
            | bash; then
            fail "$package installation failed. Keep PocketBase stopped, resolve the error, and rerun the command. Previously completed installations were not rolled back."
        fi
    done

    printf 'All selected plugins installed. Start PocketBase using your usual method and reload the dashboard with Ctrl+Shift+R.\n'
}

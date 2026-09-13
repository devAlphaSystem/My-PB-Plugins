#!/usr/bin/env bash

{
    set -euo pipefail

    fail() {
        printf 'Error: %s\n' "$*" >&2
        exit 1
    }

    package='Cron Manager'
    plugin='pb_cron_manager'
    dashboard='/_/#/settings/crons'

    for dependency in uname curl tar gzip mktemp mkdir chmod mv rm; do
        command -v "$dependency" >/dev/null 2>&1 || fail "Required command is missing: $dependency."
    done

    [[ $(uname -s) == Linux ]] || fail 'This installer requires Linux.'

    target_dir=$(pwd -P)
    if [[ ${target_dir##*/} == pb_hooks ]]; then
        [[ ! -L "$PWD" ]] || fail 'Refusing a symbolic link: pb_hooks.'
    else
        target_dir="${target_dir%/}/pb_hooks"
    fi

    [[ ! -L "$target_dir" ]] || fail 'Refusing a symbolic link: pb_hooks.'
    if [[ -e "$target_dir" ]]; then
        [[ -d "$target_dir" ]] || fail 'Expected a directory: pb_hooks.'
    else
        mkdir -m 0755 -- "$target_dir"
    fi
    [[ -w "$target_dir" && -x "$target_dir" ]] || fail 'The current user needs write and traversal permissions on pb_hooks.'

    directories=("$plugin" "$plugin/ui")
    files=("$plugin/api.js" "$plugin/ui/main.js" "$plugin.pb.js")

    for relative_path in "${directories[@]}"; do
        destination="$target_dir/$relative_path"
        [[ ! -L "$destination" ]] || fail "Refusing a symbolic link: $relative_path."
        if [[ -e "$destination" ]]; then
            [[ -d "$destination" && -w "$destination" && -x "$destination" ]] || fail "Expected a writable directory: $relative_path."
        fi
    done

    for relative_path in "${files[@]}"; do
        destination="$target_dir/$relative_path"
        [[ ! -L "$destination" ]] || fail "Refusing a symbolic link: $relative_path."
        [[ ! -e "$destination" || -f "$destination" ]] || fail "Expected a regular file: $relative_path."
    done

    printf 'Installing %s in %s\n' "$package" "$target_dir"
    printf 'PocketBase must already be stopped. Only the three plugin files will be installed or replaced.\n'

    temp_dir=$(mktemp -d "$target_dir/.pb-plugin-install.XXXXXX")
    copy_started=false

    cleanup() {
        local status=$?
        trap - EXIT
        if ! rm -rf -- "$temp_dir"; then
            printf 'Could not remove the temporary directory: %s\n' "$temp_dir" >&2
            if [[ $status -eq 0 ]]; then status=1; fi
        fi
        if [[ $status -eq 0 ]]; then
            printf '%s installed. Start PocketBase using your usual method, reload the dashboard with Ctrl+Shift+R, and open %s.\n' "$package" "$dashboard"
        elif [[ $copy_started == true ]]; then
            printf 'Installation did not finish cleanly. Keep PocketBase stopped, resolve the error, and rerun the installer. Some plugin files may already have been replaced.\n' >&2
        fi
        exit "$status"
    }

    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
        'https://codeload.github.com/devAlphaSystem/My-PB-Plugins/tar.gz/refs/heads/main' \
        --output "$temp_dir/source.tar.gz"

    archive_root="My-PB-Plugins-main/$package/pb_hooks"
    members=()
    for relative_path in "${files[@]}"; do
        members+=("$archive_root/$relative_path")
    done

    tar --extract --gzip --file "$temp_dir/source.tar.gz" --directory "$temp_dir" \
        --no-same-owner --no-same-permissions -- "${members[@]}"

    for relative_path in "${files[@]}"; do
        source_file="$temp_dir/$archive_root/$relative_path"
        [[ -f "$source_file" && ! -L "$source_file" && -s "$source_file" ]] || fail "The download is missing a valid file: $relative_path."
        chmod 0644 -- "$source_file"
    done

    copy_started=true
    for relative_path in "${directories[@]}"; do
        if [[ ! -d "$target_dir/$relative_path" ]]; then
            mkdir -m 0755 -- "$target_dir/$relative_path"
        fi
    done

    # Install the dependencies before the entry hook; preserve all unrelated files.
    for relative_path in "${files[@]}"; do
        mv -fT -- "$temp_dir/$archive_root/$relative_path" "$target_dir/$relative_path"
    done
}

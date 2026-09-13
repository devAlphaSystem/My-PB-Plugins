const hooksApi = "/api/pb-hooks-manager";

let retainedDraft = null;

function warnBeforeUnload(event) {
  if (retainedDraft) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function retainDraft(draft) {
  retainedDraft = draft;
  window.removeEventListener("beforeunload", warnBeforeUnload);
  if (draft) { window.addEventListener("beforeunload", warnBeforeUnload); }
}

app.pb.authStore.onChange((_, record) => {
  if (retainedDraft && retainedDraft.owner !== record?.id) { retainDraft(null); }
});

function pageHooks(route) {
  app.store.title = "Hooks";

  const settings = route.path === "#/settings/hooks";
  const owner = app.pb.authStore.record.id;
  const uniqueId = "hooks_manager_" + app.utils.randomString();
  const requestKeys = {
    list: uniqueId + "_list",
    file: uniqueId + "_file",
    write: uniqueId + "_write",
    status: uniqueId + "_status",
  };
  const draft = !settings && retainedDraft?.owner === owner ? retainedDraft : null;
  const data = store({
    files: [],
    hiddenFiles: [],
    directories: [""],
    search: "",
    ready: false,
    pendingCount: 0,
    batchRevision: "",
    bootId: "",
    waiting: false,
    applyReport: null,
    restartRequired: false,
    maxFileSize: 1048576,
    refreshing: false,
    loading: false,
    busy: false,
    listError: "",
    error: "",
    path: draft?.path || "",
    directory: draft?.directory || "",
    name: draft?.name || "",
    isNew: draft?.isNew || false,
    content: draft?.content || "",
    originalContent: draft?.originalContent || "",
    revision: draft?.revision || "",
    modified: draft?.modified || "",
    size: draft?.size || 0,
    conflict: draft?.conflict || false,
    missing: draft?.missing || false,
    pending: draft?.pending || "",
    diskChanged: draft?.diskChanged || false,
    get currentPath() { return data.isNew ? [data.directory, data.name].filter(Boolean).join("/") : data.path; },
    get hasFile() { return data.isNew || !!data.path; },
    get dirty() { return data.isNew || data.content !== data.originalContent; },
    get isBusy() { return data.busy || data.loading || data.waiting; },
    get visibleFiles() { return data.files.filter((file) => !file.hidden); },
    get currentHidden() { return data.files.some((file) => file.path === data.path && file.hidden); },
    get filteredFiles() {
      const search = data.search.trim().toLowerCase();
      return data.visibleFiles.filter((file) => file.path.toLowerCase().includes(search));
    },
  });

  let alive = true;
  let generation = 0;
  let intervalId;
  let operation = null;

  function isCurrent(token) { return alive && token === generation && app.pb.authStore.record?.id === owner; }

  function rememberDraft() {
    if (settings || !alive || app.pb.authStore.record?.id !== owner) { return; }
    retainDraft(
      data.dirty || data.conflict
        ? {
            owner,
            path: data.path,
            directory: data.directory,
            name: data.name,
            isNew: data.isNew,
            content: data.content,
            originalContent: data.originalContent,
            revision: data.revision,
            modified: data.modified,
            size: data.size,
            conflict: data.conflict,
            missing: data.missing,
            pending: data.pending,
            diskChanged: data.diskChanged,
          }
        : null,
    );
  }

  function cancelReads() {
    app.pb.cancelRequest(requestKeys.list);
    app.pb.cancelRequest(requestKeys.file);
  }

  function acceptFile(file) {
    data.path = file.path;
    data.isNew = false;
    data.content = file.content;
    data.originalContent = file.content;
    data.revision = file.revision;
    data.modified = file.modified;
    data.size = file.size;
    data.conflict = false;
    data.missing = false;
    data.pending = file.pending;
    data.diskChanged = file.diskChanged;
    data.error = "";
    rememberDraft();
  }

  function showError(err, field = "error", notify = true) {
    if (err?.isAbort || !alive) { return; }
    data[field] = err?.response?.message || err?.message || "Failed to read hook files.";
    app.checkApiError(err, notify);
  }

  async function refresh(notify = false, refreshSelected = true) {
    if (data.waiting) return checkOperation();
    if (!alive || document.hidden || data.isBusy || data.refreshing) { return; }
    const token = generation;
    data.refreshing = true;
    try {
      const result = await app.pb.send(hooksApi + "/files", {
        method: "GET",
        requestKey: requestKeys.list,
      });
      if (!isCurrent(token)) { return; }
      if (JSON.stringify(data.files) !== JSON.stringify(result.files)) { data.files = result.files; }
      if (JSON.stringify(data.hiddenFiles) !== JSON.stringify(result.hiddenFiles)) { data.hiddenFiles = result.hiddenFiles; }
      if (JSON.stringify(data.directories) !== JSON.stringify(result.directories)) { data.directories = result.directories; }
      acceptStatus(result);
      data.maxFileSize = result.maxFileSize;
      data.ready = true;
      data.listError = "";

      if (settings) return;
      if (data.currentHidden && !data.dirty && !data.conflict) clearEditor();
      if (!data.hasFile) {
        if (data.error && !notify) return;
        if (data.visibleFiles.length) { await loadFile(data.visibleFiles[0].path); } else if (!data.files.length) { newFile(); }
        return;
      }

      if (refreshSelected && data.path && !data.isNew) {
        try {
          const file = await app.pb.send(hooksApi + "/file", {
            method: "GET",
            query: { path: data.path },
            requestKey: requestKeys.file,
          });
          if (!isCurrent(token)) { return; }
          data.diskChanged = file.diskChanged;
          if (file.revision !== data.revision || file.pending !== data.pending || data.missing) {
            if (data.dirty || data.conflict) {
              data.conflict = true;
              data.missing = false;
              rememberDraft();
            } else { acceptFile(file); }
          }
        } catch (err) {
          if (!isCurrent(token) || err?.isAbort) { return; }
          if (err?.status === 404) {
            data.conflict = true;
            data.missing = true;
            rememberDraft();
          } else if (notify || ![409, 423].includes(err?.status)) { showError(err, "listError", notify); }
        }
      }
    } catch (err) {
      if (isCurrent(token) && (notify || ![409, 423].includes(err?.status))) { showError(err, "listError", notify); }
    } finally {
      if (alive) {
        data.refreshing = false;
        if (token !== generation && !data.hasFile && !data.isBusy && !data.error) refresh();
      }
    }
  }

  function acceptStatus(result) {
    data.pendingCount = result.pendingCount;
    data.batchRevision = result.revision;
    data.restartRequired = result.restartRequired;
    data.bootId = result.bootId;
    data.applyReport = result.apply;
  }

  function completeOperation(result) {
    if (!operation) return false;
    acceptStatus(result);
    if (result.apply?.id === operation.id && ["complete", "partial", "interrupted"].includes(result.apply.status)) {
      operation = null;
      data.waiting = false;
      data.busy = false;
      clearEditor();
      if (result.apply.status === "complete") app.toasts.success("Saved drafts applied to pb_hooks.");
      return true;
    }
    return false;
  }

  async function checkOperation() {
    if (!alive || !operation || document.hidden || data.refreshing) return;
    const token = generation;
    data.refreshing = true;
    try {
      const result = await app.pb.send(hooksApi + "/status", {
        method: "GET",
        requestKey: requestKeys.status,
        signal: AbortSignal.timeout(5000),
      });
      if (isCurrent(token)) completeOperation(result);
    } catch (err) {
      if (isCurrent(token) && [401, 403].includes(err?.status)) {
        data.waiting = false;
        operation = null;
        showError(err);
      }
    } finally {
      if (alive) {
        data.refreshing = false;
        if (operation && Date.now() >= operation.deadline) {
          data.waiting = false;
          operation = null;
          data.error = "The operation could not be confirmed. Check the server, then refresh to review saved drafts and apply progress.";
        }
        if (!operation && !data.hasFile && !data.error) refresh();
      }
    }
  }

  function confirmApply() {
    if (!alive || !data.ready || data.isBusy || data.dirty || data.conflict || !data.pendingCount) return;
    const revision = data.batchRevision;
    const bootId = data.bootId;
    const paths = data.files.filter((file) => file.pending);
    app.modals.confirm(
      t.div(
        null,
        t.p(null, "Apply all " + paths.length + " saved changes to pb_hooks?"),
        t.ul(
          { className: "txt-left" },
          paths.map((file) => t.li(null, file.pending + ": " + file.path)),
        ),
        t.p(null, "On Linux, PocketBase may restart automatically when its file monitor detects these changes. If it does not, restart the instance externally after applying all drafts to load the changes."),
        t.p(null, "If the batch is interrupted, review its progress and apply the remaining drafts again."),
      ),
      async () => {
        if (!alive || data.isBusy || data.dirty || data.conflict) return;
        if (data.batchRevision !== revision || data.bootId !== bootId) {
          app.toasts.error("The instance or saved drafts changed. Review them and confirm again.");
          return;
        }
        const token = ++generation;
        cancelReads();
        data.waiting = true;
        data.error = "";
        data.listError = "";
        operation = { id: app.utils.randomString(32), deadline: Date.now() + 60000 };
        try {
          const result = await app.pb.send(hooksApi + "/apply", {
            method: "POST",
            requestKey: requestKeys.write,
            body: { confirm: true, revision, requestId: operation.id },
            signal: AbortSignal.timeout(15000),
          });
          if (isCurrent(token)) completeOperation(result);
        } catch (err) {
          if (isCurrent(token) && [400, 401, 403, 409, 413, 423].includes(err?.status)) {
            operation = null;
            data.waiting = false;
            showError(err);
          }
        } finally {
          if (alive) {
            if (operation) checkOperation();
            else refresh();
          }
        }
      },
      null,
      { className: "lg", yesButton: "Apply changes", noButton: "Cancel" },
    );
  }

  function confirmDiscard(action) {
    if (!alive || data.isBusy) { return; }
    if (!data.dirty && !data.conflict) { return action(); }
    app.modals.confirm("Discard the unsaved draft for " + (data.currentPath || "this new file") + "?", () => (alive && !data.isBusy ? action() : undefined), null, { yesButton: "Discard draft", noButton: "Keep editing" });
  }

  async function loadFile(path) {
    if (!alive || data.isBusy) { return; }
    const token = ++generation;
    cancelReads();
    data.loading = true;
    data.error = "";
    try {
      const file = await app.pb.send(hooksApi + "/file", {
        method: "GET",
        query: { path },
        requestKey: requestKeys.file,
      });
      if (isCurrent(token)) { acceptFile(file); }
    } catch (err) {
      if (isCurrent(token)) { showError(err); }
    } finally {
      if (isCurrent(token)) { data.loading = false; }
    }
  }

  function clearEditor(refreshFiles = false) {
    ++generation;
    cancelReads();
    data.path = "";
    data.directory = "";
    data.name = "";
    data.isNew = false;
    data.content = "";
    data.originalContent = "";
    data.revision = "";
    data.modified = "";
    data.size = 0;
    data.conflict = false;
    data.missing = false;
    data.pending = "";
    data.diskChanged = false;
    data.error = "";
    rememberDraft();
    if (refreshFiles) refresh();
  }

  function newFile() {
    if (!data.ready) { return; }
    confirmDiscard(() => {
      clearEditor();
      data.isNew = true;
      rememberDraft();
    });
  }

  async function saveFile() {
    if (!alive || data.isBusy || !data.ready || !data.dirty || data.conflict || data.pending === "delete") { return; }
    if (!document.getElementById(uniqueId + "_form").reportValidity()) { return; }
    if (new TextEncoder().encode(data.content).length > data.maxFileSize) {
      data.error = "The file exceeds the " + app.utils.formattedFileSize(data.maxFileSize) + " limit.";
      app.toasts.error(data.error);
      return;
    }
    const token = ++generation;
    cancelReads();
    data.busy = true;
    data.error = "";
    try {
      const file = await app.pb.send(hooksApi + "/file", {
        method: data.isNew ? "POST" : "PUT",
        body: {
          path: data.currentPath,
          content: data.content,
          ...(data.isNew ? {} : { revision: data.revision }),
        },
        requestKey: requestKeys.write,
      });
      if (isCurrent(token)) {
        acceptFile(file);
        app.toasts.success("Draft saved. Use Apply changes to update pb_hooks.");
      }
    } catch (err) {
      if (isCurrent(token) && !err?.isAbort) {
        if (err?.status === 409 && !data.isNew) {
          data.conflict = true;
          rememberDraft();
        }
        showError(err);
      }
    } finally {
      if (isCurrent(token)) {
        data.busy = false;
        refresh();
      }
    }
  }

  function confirmDelete() {
    if (!alive || data.isBusy || !data.ready || data.isNew || !data.path || data.conflict || data.pending === "delete") { return; }
    const path = data.path;
    const revision = data.revision;
    app.modals.confirm(
      t.div({ className: "txt-center" }, t.h6(null, "Stage deletion of " + path + "?"), t.p(null, "An existing file is removed only when you apply. A new file that exists only as a draft is discarded."), data.dirty ? t.p(null, "Your unsaved draft will also be discarded.") : null),
      async () => {
        if (!alive || data.isBusy || !data.ready || data.conflict) { return; }
        const token = ++generation;
        cancelReads();
        data.busy = true;
        try {
          await app.pb.send(hooksApi + "/file", {
            method: "DELETE",
            body: { path, revision },
            requestKey: requestKeys.write,
          });
          if (isCurrent(token)) {
            data.busy = false;
            clearEditor();
            app.toasts.success("Saved drafts updated. Existing hook files are unchanged until you apply.");
            refresh();
          }
        } catch (err) {
          if (isCurrent(token) && !err?.isAbort) {
            if (err?.status === 409 || err?.status === 404) {
              data.conflict = true;
              data.missing = err.status === 404;
              rememberDraft();
            }
            showError(err);
          }
        } finally {
          if (isCurrent(token)) { data.busy = false; }
        }
      },
      null,
      { yesButton: "Stage deletion", noButton: "Cancel" },
    );
  }

  function discardSavedDraft() {
    if (!alive || data.isBusy || !data.pending || data.conflict) return;
    const path = data.path;
    const revision = data.revision;
    app.modals.confirm(
      "Discard the saved draft and any unsaved editing for " + path + "? The current file in pb_hooks will be preserved.",
      async () => {
        if (!alive || data.isBusy || data.path !== path || data.revision !== revision) return;
        const token = ++generation;
        cancelReads();
        data.busy = true;
        try {
          await app.pb.send(hooksApi + "/discard", {
            method: "POST",
            body: { path, revision },
            requestKey: requestKeys.write,
          });
          if (isCurrent(token)) {
            data.busy = false;
            clearEditor();
            app.toasts.success("Saved draft discarded. Files in pb_hooks were preserved.");
            refresh();
          }
        } catch (err) {
          if (isCurrent(token)) showError(err);
        } finally {
          if (alive) data.busy = false;
        }
      },
      null,
      { yesButton: "Discard saved draft", noButton: "Cancel" },
    );
  }

  function onVisibilityChange() {
    if (document.hidden) {
      cancelReads();
      app.pb.cancelRequest(requestKeys.status);
    } else { refresh(); }
  }

  async function setFileHidden(path, hidden) {
    if (!isCurrent(generation) || !data.ready || data.isBusy || !path) return;
    const token = ++generation;
    cancelReads();
    data.busy = true;
    data.error = "";
    try {
      const result = await app.pb.send(hooksApi + "/visibility", {
        method: "POST",
        body: { path, hidden },
        requestKey: requestKeys.write,
      });
      if (isCurrent(token)) {
        acceptStatus(result);
        data.files = data.files.map((file) => (file.path === path ? { ...file, hidden } : file));
        if (!hidden) data.hiddenFiles = data.hiddenFiles.filter((file) => file.path !== path);
        if (hidden && data.path === path) clearEditor();
        app.toasts.success(hidden ? "Hook hidden. Show it again in Settings > Hooks." : "Hook visibility restored.");
      }
    } catch (err) {
      if (isCurrent(token)) showError(err);
    } finally {
      if (alive && app.pb.authStore.record?.id === owner) {
        data.busy = false;
        refresh();
      }
    }
  }

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!document.querySelector('.modal[data-modal-state="open"]')) { saveFile(); }
    }
  }

  const pageProps = {
    pbEvent: settings ? "pageHooksSettings" : "pageHooksManager",
    className: "page",
    onmount: () => {
      refresh();
      intervalId = setInterval(() => refresh(), 3000);
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (!settings) window.addEventListener("keydown", onKeyDown);
    },
    onunmount: () => {
      rememberDraft();
      alive = false;
      ++generation;
      clearInterval(intervalId);
      Object.values(requestKeys).forEach((key) => app.pb.cancelRequest(key));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDown);
    },
  };

  if (settings) {
    return t.div(
      pageProps,
      app.components.pageSidebar(
        { pbEvent: "settingsSidebar", className: "settings-sidebar" },
        t.nav({ className: "sidebar-content scrollable" }, () =>
          Object.entries(app.store.settingsNavGroups).map(([group, links]) =>
            t.details({ className: "nav-group", "html-data-group": group, open: true }, t.summary({ tabIndex: -1, onfocusout: () => false, onclick: () => false, onkeyup: () => false }, group), () =>
              links.map((link) =>
                t.a(
                  {
                    href: () => link.href,
                    target: () => (link.href.startsWith("#/") ? undefined : "_blank"),
                    rel: () => (link.href.startsWith("#/") ? undefined : "noopener noreferrer"),
                    className: (el) => "nav-item " + (link.isActive?.(el) || app.utils.isActivePath(link.href, false) ? "active" : ""),
                  },
                  () => (link.icon ? t.i({ className: link.icon, ariaHidden: true }) : null),
                  t.span({ className: "txt" }, () => link.label),
                ),
              ),
            ),
          ),
        ),
      ),
      t.div(
        { className: "page-content full-height" },
        t.header({ className: "page-header" }, t.nav({ className: "breadcrumbs" }, t.div({ className: "breadcrumb-item" }, "Settings"), t.div({ className: "breadcrumb-item" }, "Hooks"))),
        t.div(
          { className: "wrapper m-b-base" },
          t.div(
            { className: "flex gap-10 m-b-sm" },
            t.div({ className: "txt-lg" }, "Hidden hooks"),
            app.components.refreshButton({
              className: "btn sm transparent secondary circle tooltip-bottom",
              tooltip: "Refresh hidden hooks",
              disabled: () => data.isBusy || data.refreshing,
              onclick: () => refresh(true),
            }),
          ),
          t.div({ className: "alert danger m-b-sm", hidden: () => !data.listError }, () => data.listError),
          t.div({ className: "alert danger m-b-sm", hidden: () => !data.error }, () => data.error),
          t.div(
            { className: "list" },
            t.div({ className: "list-content" }, t.div({ className: "list-item", hidden: () => data.ready || !data.refreshing }, t.div({ className: "skeleton-loader" })), t.div({ className: "list-item", hidden: () => !data.ready || !!data.hiddenFiles.length }, t.div({ className: "content block txt-hint" }, "No hidden hooks found.")), () =>
              data.hiddenFiles.map((file) =>
                t.div(
                  { className: "list-item" },
                  t.i({ className: "ri-file-code-line", ariaHidden: true }),
                  t.div({ className: "content" }, t.span({ className: "txt-ellipsis", title: file.path }, file.path), !file.missing ? t.small({ className: "txt-hint txt-nowrap" }, "(" + app.utils.formattedFileSize(file.size) + ")") : null, file.pending ? t.span({ className: "label sm warning" }, file.pending) : null, file.missing ? t.small({ className: "txt-hint" }, "File no longer exists") : null),
                  t.nav(
                    { className: "actions" },
                    t.button(
                      {
                        type: "button",
                        className: "btn sm circle secondary transparent",
                        ariaLabel: app.attrs.tooltip("Show"),
                        disabled: () => data.isBusy,
                        onclick: () => setFileHidden(file.path, false),
                      },
                      t.i({ className: "ri-eye-line", ariaHidden: true }),
                    ),
                  ),
                ),
              ),
            ),
            t.div({ className: "list-item" }, t.a({ href: "#/hooks", className: "btn secondary block" }, t.i({ className: "ri-code-box-line", ariaHidden: true }), t.span({ className: "txt" }, "Manage hooks"))),
          ),
          t.p({ className: "txt-sm txt-hint m-t-sm" }, "Hidden files keep running normally. Show a file to return it to the Hooks list."),
        ),
        t.footer({ className: "page-footer" }, app.components.credits()),
      ),
    );
  }

  return t.div(
    pageProps,
    app.components.pageSidebar(
      { className: "collections-sidebar" },
      t.div(
        { className: "sidebar-search" },
        t.div(
          { className: "field" },
          t.input({
            type: "search",
            placeholder: "Search hook files...",
            ariaLabel: "Search hook files",
            value: () => data.search,
            oninput: (event) => (data.search = event.target.value),
          }),
        ),
      ),
      t.nav(
        { className: "sidebar-content collections-list scrollable" },
        t.details(
          { className: "nav-group", open: true },
          t.summary({ tabIndex: -1, onfocusout: () => false, onclick: () => false, onkeyup: () => false }, "pb_hooks"),
          () =>
            data.filteredFiles.map((file) =>
              t.button(
                {
                  type: "button",
                  className: () => "nav-item responsive-close " + (!data.isNew && file.path === data.path ? "active" : ""),
                  title: file.path + " (" + app.utils.formattedFileSize(file.size) + ")",
                  disabled: () => data.isBusy,
                  onclick: () => {
                    if (data.isNew || file.path !== data.path) { confirmDiscard(() => loadFile(file.path)); }
                  },
                },
                t.i({ className: "ri-file-code-line", ariaHidden: true }),
                t.span({ className: "txt" }, file.path),
                file.pending ? t.span({ className: "label sm warning" }, file.pending) : null,
              ),
            ),
          t.p({ hidden: () => !data.ready || !!data.filteredFiles.length, className: "txt-hint txt-center" }, () => (data.search ? "No matching files." : "No editable files yet.")),
          t.div({ hidden: () => data.ready || !data.refreshing, className: "txt-center p-sm" }, t.span({ className: "loader sm" })),
        ),
      ),
      t.div(
        { className: "sidebar-content new-collection" },
        t.button(
          {
            type: "button",
            className: "btn outline block",
            disabled: () => data.isBusy || !data.ready,
            onclick: newFile,
          },
          t.i({ className: "ri-add-line", ariaHidden: true }),
          t.span({ className: "txt" }, "New file"),
        ),
      ),
    ),
    t.div(
      { className: "page-content full-height" },
      t.header(
        { className: "page-header" },
        t.nav(
          { className: "breadcrumbs" },
          t.div({ className: "breadcrumb-item" }, "Hooks"),
          t.div({ hidden: () => !data.hasFile, className: "breadcrumb-item" }, () => data.currentPath || "New file"),
        ),
        t.div(
          { className: "page-header-secondary-btns" },
          app.components.refreshButton({
            tooltip: "Refresh files",
            disabled: () => data.isBusy || data.refreshing,
            onclick: () => {
              if (!data.path || data.isNew) return refresh(true);
              confirmDiscard(async () => {
                if (data.missing) return clearEditor(true);
                await loadFile(data.path);
                refresh(true, false);
              });
            },
          }),
          t.button(
            {
              type: "button",
              className: "btn transparent secondary circle",
              hidden: () => !data.hasFile,
              ariaLabel: app.attrs.tooltip("Copy"),
              onclick: () => app.utils.copyToClipboard(data.content),
            },
            t.i({ className: "ri-file-copy-line", ariaHidden: true }),
          ),
          t.button(
            {
              type: "button",
              className: "btn transparent secondary circle",
              hidden: () => !data.path || data.isNew || data.currentHidden,
              ariaLabel: app.attrs.tooltip("Hide"),
              disabled: () => data.isBusy || !data.ready,
              onclick: () => confirmDiscard(() => setFileHidden(data.path, true)),
            },
            t.i({ className: "ri-eye-off-line", ariaHidden: true }),
          ),
          t.button(
            {
              type: "button",
              className: "btn transparent warning circle",
              hidden: () => !data.pending,
              ariaLabel: app.attrs.tooltip("Discard saved draft"),
              disabled: () => data.isBusy || data.conflict,
              onclick: discardSavedDraft,
            },
            t.i({ className: "ri-arrow-go-back-line", ariaHidden: true }),
          ),
        ),
        t.div(
          { className: "page-header-primary-btns" },
          t.button(
            {
              type: "button",
              className: "btn outline",
              disabled: () => !data.ready || data.isBusy || data.dirty || data.conflict || !data.pendingCount,
              title: "Save or discard unsaved editing before applying the saved drafts",
              onclick: confirmApply,
            },
            t.i({ className: "ri-check-line", ariaHidden: true }),
            t.span({ className: "txt" }, () => "Apply changes (" + data.pendingCount + ")"),
          ),
          t.button(
            {
              type: "button",
              className: "btn outline warning",
              hidden: () => !data.hasFile || data.isNew,
              disabled: () => data.isBusy || !data.ready || data.conflict || data.pending === "delete",
              onclick: confirmDelete,
            },
            t.i({ className: "ri-delete-bin-line", ariaHidden: true }),
            t.span({ className: "txt" }, "Stage deletion"),
          ),
          t.button(
            {
              type: "submit",
              "html-form": uniqueId + "_form",
              className: () => "btn " + (data.busy ? "loading" : ""),
              hidden: () => !data.hasFile,
              disabled: () => data.isBusy || !data.ready || !data.dirty || data.conflict || data.pending === "delete",
            },
            t.i({ className: "ri-save-line", ariaHidden: true }),
            t.span({ className: "txt" }, "Save draft"),
          ),
        ),
      ),
      t.div({ className: "alert info m-b-sm", hidden: () => !data.waiting }, t.p({ className: "txt-bold" }, "Waiting for confirmation"), t.p(null, "PocketBase may briefly disconnect. The panel will check the saved operation status when the server is available.")),
      t.div(
        { className: "alert warning m-b-sm", hidden: () => !["partial", "interrupted"].includes(data.applyReport?.status) },
        t.p({ className: "txt-bold" }, "The last apply did not finish"),
        t.p(null, () => (data.applyReport?.completed.length || 0) + " file(s) confirmed. " + data.pendingCount + " saved draft(s) remain."),
        t.p(null, () => data.applyReport?.error || "Review the files and use Apply changes again to continue with the remaining drafts."),
        t.p(null, () => (data.applyReport?.current ? "Last operation: " + data.applyReport.current : "")),
      ),
      t.div({ className: "alert info m-b-sm", hidden: () => !data.restartRequired }, t.p({ className: "txt-bold" }, "Hook files applied"), t.p(null, "If PocketBase has not restarted automatically, restart the instance externally after applying all drafts to load the changes.")),
      t.div(
        { className: "alert danger m-b-sm", hidden: () => !data.listError },
        t.p(null, () => data.listError),
      ),
      t.div(
        { className: "alert danger m-b-sm", hidden: () => !data.error },
        t.p(null, () => data.error),
      ),
      t.div(
        { className: "alert warning m-b-sm", hidden: () => !data.conflict },
        t.p({ className: "txt-bold" }, () => (data.missing ? "File or saved draft removed" : "File or saved draft changed")),
        t.p(null, "Your editor content has been preserved. Copy it before reloading if you need to merge changes."),
        t.button(
          {
            type: "button",
            className: "btn sm outline m-t-sm",
            disabled: () => data.isBusy,
            onclick: () => confirmDiscard(() => (data.missing ? clearEditor(true) : loadFile(data.path))),
          },
          () => (data.missing ? "Discard unsaved editing" : "Reload latest version"),
        ),
      ),
      t.div({ className: "alert warning m-b-sm", hidden: () => !data.diskChanged || !data.pending }, t.p({ className: "txt-bold" }, "The active file changed after this draft was saved"), t.p(null, "Apply will refuse this conflict. Copy the draft, discard the saved draft, then open the active file and merge your changes.")),
      t.form(
        {
          id: uniqueId + "_form",
          style: "display: flex; flex-direction: column; flex: 1 0 auto;",
          hidden: () => !data.hasFile,
          onsubmit: (event) => {
            event.preventDefault();
            saveFile();
          },
        },
        t.div(
          { className: "grid m-b-sm", style: "flex: 0 0 auto;", hidden: () => !data.isNew },
          t.div(
            { className: "col-sm-6" },
            t.div(
              { className: "field" },
              t.label({ htmlFor: uniqueId + "_directory" }, "Directory"),
              app.components.select({
                id: uniqueId + "_directory",
                required: true,
                disabled: () => data.isBusy || !data.ready,
                value: () => data.directory,
                options: () => data.directories.map((value) => ({ value, label: "pb_hooks/" + value })),
                onchange: (selected) => {
                  data.directory = selected[0]?.value || "";
                  rememberDraft();
                },
              }),
            ),
          ),
          t.div(
            { className: "col-sm-6" },
            t.div(
              { className: "field" },
              t.label({ htmlFor: uniqueId + "_name" }, "File name"),
              t.input({
                id: uniqueId + "_name",
                name: "path",
                type: "text",
                placeholder: "example.pb.js",
                required: () => data.isNew,
                disabled: () => !data.isNew || data.isBusy || !data.ready,
                pattern: "[^\\/\\\\]+",
                autocomplete: "off",
                spellcheck: false,
                value: () => data.name,
                oninput: (event) => {
                  data.name = event.target.value;
                  rememberDraft();
                },
              }),
            ),
          ),
        ),
        t.div(
          { className: "field", style: "display: flex; flex-direction: column; flex: 1 0 auto;" },
          t.label(
            { htmlFor: uniqueId + "_content" },
            "Content",
            t.span({ className: "label sm warning", hidden: () => !data.dirty }, "Unsaved changes"),
            t.span({ className: "label sm", hidden: () => !data.pending }, () => (data.pending === "delete" ? "Removal pending" : "Saved draft")),
            t.span({ className: "label sm", hidden: () => !data.currentHidden }, "Hidden"),
          ),
          t.textarea({
            id: uniqueId + "_content",
            name: "content",
            className: "txt-code",
            style: "flex: 1 0 auto; min-height: 150px; max-height: none; resize: none;",
            spellcheck: false,
            autocorrect: false,
            autocomplete: "off",
            autocapitalize: "off",
            disabled: () => data.isBusy || !data.ready || data.pending === "delete",
            placeholder: "Enter the file content...",
            value: () => data.content,
            oninput: (event) => {
              data.content = event.target.value;
              rememberDraft();
            },
          }),
        ),
        t.div(
          { className: "field-help flex flex-nowrap gap-sm m-b-sm", style: "flex: 0 0 auto;" },
          t.span(null, "UTF-8 text · Maximum ", () => app.utils.formattedFileSize(data.maxFileSize), " · Save draft first, then Apply changes to update pb_hooks."),
          t.span(
            { className: "m-l-auto txt-right", hidden: () => data.isNew || !data.modified },
            () => (data.pending ? "Draft saved: " : "File modified: "),
            () => (data.modified ? app.utils.toLocalDatetime(data.modified) : ""),
            " · ",
            () => app.utils.formattedFileSize(data.size),
          ),
        ),
      ),
      t.div(
        {
          className: "txt-center m-auto",
          hidden: () => data.hasFile || !(data.refreshing || data.loading),
          role: "status",
          ariaLabel: "Loading hook files",
        },
        t.span({ className: "loader" }),
      ),
      t.div({ className: "txt-center m-auto", hidden: () => !data.ready || data.hasFile || !data.files.length || !!data.visibleFiles.length }, t.p({ className: "txt-hint" }, "All hook files are hidden."), t.a({ href: "#/settings/hooks", className: "btn secondary" }, "Show hidden hooks")),
      t.footer(
        { className: "page-footer" },
        t.span({ className: "txt" }, "Total: ", () => data.visibleFiles.length),
        app.components.credits(),
      ),
    ),
  );
}

app.store.headerLinks.splice(
  app.store.headerLinks.findIndex((link) => link.href === "#/settings"),
  0,
  {
    href: "#/hooks",
    icon: "ri-code-box-line",
    label: "Hooks",
  },
);
app.routes.superuserOnly("#/hooks", pageHooks);
const hooksSettingsGroup = Object.values(app.store.settingsNavGroups).find((links) => links.some((link) => link.href === "#/settings/backups"));
hooksSettingsGroup.splice(hooksSettingsGroup.findIndex((link) => link.href === "#/settings/backups") + 1, 0, { href: "#/settings/hooks", icon: "ri-code-box-line", label: "Hooks" });
app.routes.superuserOnly("#/settings/hooks", pageHooks);

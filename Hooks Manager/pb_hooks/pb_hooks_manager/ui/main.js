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
  if (draft) {
    window.addEventListener("beforeunload", warnBeforeUnload);
  }
}

app.pb.authStore.onChange((_, record) => {
  if (retainedDraft && retainedDraft.owner !== record?.id) {
    retainDraft(null);
  }
});

function pageHooks(route) {
  const disabledSettings = route.path === "#/settings/hooks-disabled";
  const settings = disabledSettings || route.path === "#/settings/hooks";
  const settingsTitle = disabledSettings ? "Hooks Disabled" : "Hooks Hidden";
  app.store.title = settings ? settingsTitle : "Hooks";
  const owner = app.pb.authStore.record.id;
  const uniqueId = "hooks_manager_" + app.utils.randomString();
  const requestKeys = {
    list: uniqueId + "_list",
    file: uniqueId + "_file",
    write: uniqueId + "_write",
    status: uniqueId + "_status",
    import: uniqueId + "_import",
  };
  const draft = !settings && retainedDraft?.owner === owner ? retainedDraft : null;
  const data = store({
    files: [],
    hiddenFiles: [],
    disabledFiles: [],
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
    maxDrafts: 100,
    maxDraftBytes: 8388608,
    refreshing: false,
    loading: false,
    busy: false,
    importing: false,
    dragging: false,
    error: "",
    recoveryError: "",
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
    get currentPath() {
      return data.isNew ? [data.directory, data.name].filter(Boolean).join("/") : data.path;
    },
    get hasFile() {
      return data.isNew || !!data.path;
    },
    get dirty() {
      return data.isNew || data.content !== data.originalContent;
    },
    get isBusy() {
      return data.busy || data.loading || data.waiting || data.importing;
    },
    get canImport() {
      return data.ready && data.hasFile && !data.isBusy && data.pending !== "delete";
    },
    get visibleFiles() {
      return data.files.filter((file) => !file.hidden);
    },
    get currentHidden() {
      return data.files.some((file) => file.path === data.path && file.hidden);
    },
    get currentDisabled() {
      return data.disabledFiles.some((file) => file.path === data.path) && !data.files.some((file) => file.path === data.path);
    },
    get settingsFiles() {
      return disabledSettings ? data.disabledFiles : data.hiddenFiles;
    },
    get filteredFiles() {
      const search = data.search.trim().toLowerCase();
      return data.visibleFiles.filter((file) => file.path.toLowerCase().includes(search));
    },
  });

  let alive = true;
  let generation = 0;
  let intervalId;
  let operation = null;
  let dragDepth = 0;
  let importModal;

  function isCurrent(token) {
    return alive && token === generation && app.pb.authStore.record?.id === owner;
  }

  function rememberDraft() {
    if (settings || !alive || app.pb.authStore.record?.id !== owner) {
      return;
    }
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
    data.recoveryError = "";
    rememberDraft();
  }

  function showError(err, notify = true, blockEditor = true) {
    if (err?.isAbort || !alive) {
      return;
    }
    if (blockEditor) {
      data.error = err?.response?.message || err?.message || "Failed to read hook files.";
    }
    app.checkApiError(err, notify);
  }

  async function refresh(notify = false, refreshSelected = true) {
    if (data.waiting) return checkOperation();
    if (!alive || document.hidden || data.isBusy || data.refreshing) {
      return;
    }
    const token = generation;
    data.refreshing = true;
    try {
      const result = await app.pb.send(hooksApi + "/files", {
        method: "GET",
        requestKey: requestKeys.list,
      });
      if (!isCurrent(token)) {
        return;
      }
      if (JSON.stringify(data.files) !== JSON.stringify(result.files)) {
        data.files = result.files;
      }
      if (JSON.stringify(data.hiddenFiles) !== JSON.stringify(result.hiddenFiles)) {
        data.hiddenFiles = result.hiddenFiles;
      }
      if (JSON.stringify(data.disabledFiles) !== JSON.stringify(result.disabledFiles)) {
        data.disabledFiles = result.disabledFiles;
      }
      if (JSON.stringify(data.directories) !== JSON.stringify(result.directories)) {
        data.directories = result.directories;
      }
      acceptStatus(result);
      data.maxFileSize = result.maxFileSize;
      data.maxDrafts = result.maxDrafts;
      data.maxDraftBytes = result.maxDraftBytes;
      data.ready = true;
      if (notify) data.recoveryError = "";

      if (settings) return;
      if (data.currentDisabled) {
        if (!data.dirty && !data.conflict) clearEditor();
        else {
          data.conflict = true;
          data.missing = true;
          rememberDraft();
          return;
        }
      }
      if (data.currentHidden && !data.dirty && !data.conflict) clearEditor();
      if (!data.hasFile) {
        if ((data.error || data.recoveryError) && !notify) return;
        if (data.visibleFiles.length) {
          await loadFile(data.visibleFiles[0].path);
        } else if (!data.files.length && !data.disabledFiles.length) {
          newFile();
        }
        return;
      }

      if (refreshSelected && data.path && !data.isNew) {
        try {
          const file = await app.pb.send(hooksApi + "/file", {
            method: "GET",
            query: { path: data.path },
            requestKey: requestKeys.file,
          });
          if (!isCurrent(token)) {
            return;
          }
          data.diskChanged = file.diskChanged;
          if (file.revision !== data.revision || file.pending !== data.pending || data.missing) {
            if (data.dirty || data.conflict) {
              data.conflict = true;
              data.missing = false;
              rememberDraft();
            } else {
              acceptFile(file);
            }
          }
        } catch (err) {
          if (!isCurrent(token) || err?.isAbort) {
            return;
          }
          if (err?.status === 404) {
            data.conflict = true;
            data.missing = true;
            rememberDraft();
          } else if (notify || ![409, 423].includes(err?.status)) {
            showError(err, notify, false);
          }
        }
      }
    } catch (err) {
      if (isCurrent(token) && (notify || ![409, 423].includes(err?.status))) {
        showError(err, notify, false);
      }
    } finally {
      if (alive) {
        data.refreshing = false;
        if (token !== generation && !data.hasFile && !data.isBusy && !data.error && !data.recoveryError) refresh();
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
          data.recoveryError = "The operation could not be confirmed. Check the server, then refresh to review saved drafts and apply progress.";
        }
        if (!operation && !data.hasFile && !data.error && !data.recoveryError) refresh();
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
        data.recoveryError = "";
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
    if (!alive || data.isBusy) {
      return;
    }
    if (!data.dirty && !data.conflict) {
      return action();
    }
    app.modals.confirm("Discard the unsaved draft for " + (data.currentPath || "this new file") + "?", () => (alive && !data.isBusy ? action() : undefined), null, { yesButton: "Discard draft", noButton: "Keep editing" });
  }

  async function loadFile(path) {
    if (!alive || data.isBusy) {
      return;
    }
    const token = ++generation;
    cancelReads();
    data.loading = true;
    data.error = "";
    data.recoveryError = "";
    try {
      const file = await app.pb.send(hooksApi + "/file", {
        method: "GET",
        query: { path },
        requestKey: requestKeys.file,
      });
      if (isCurrent(token)) {
        acceptFile(file);
      }
    } catch (err) {
      if (isCurrent(token)) {
        showError(err);
      }
    } finally {
      if (isCurrent(token)) {
        data.loading = false;
      }
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
    data.recoveryError = "";
    rememberDraft();
    if (refreshFiles) refresh(true);
  }

  function newFile() {
    if (!data.ready) {
      return;
    }
    confirmDiscard(() => {
      clearEditor();
      data.isNew = true;
      rememberDraft();
    });
  }

  function onFileDragOver(event) {
    if (!event.dataTransfer?.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    if (event.type === "dragenter") {
      ++dragDepth;
    }
    data.dragging = isCurrent(generation) && data.canImport && !document.querySelector('.modal[data-modal-state="open"]');
    event.dataTransfer.dropEffect = data.dragging ? "copy" : "none";
  }

  function resetFileDrag() {
    dragDepth = 0;
    data.dragging = false;
  }

  function onFileDragLeave(event) {
    if (!event.dataTransfer?.types.includes("Files")) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      resetFileDrag();
    }
  }

  async function readImportFile(file) {
    if (file.size > data.maxFileSize) {
      throw new Error(file.name + " exceeds the " + app.utils.formattedFileSize(data.maxFileSize) + " limit.");
    }
    const bytes = await file.arrayBuffer();
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (_) {
      throw new Error(file.name + " must use UTF-8 encoding.");
    }
    if (content.includes("\u0000")) {
      throw new Error(file.name + " contains null characters. Only UTF-8 text can be imported.");
    }
    return content;
  }

  function openFolderImport() {
    if (!alive || !data.ready || data.isBusy || importModal) return;
    const token = ++generation;
    cancelReads();
    resetFileDrag();
    data.importing = true;
    const form = store({ folder: "", rows: [], bytes: 0, revision: "", loading: false, saving: false, reviewed: false, recoveryError: "" });
    let selectedFiles = [];
    let modal;
    function valid() {
      return isCurrent(token) && importModal === modal && modal.isConnected;
    }
    async function review() {
      if (!valid() || form.loading || form.saving || !selectedFiles.length) return;
      form.loading = true;
      form.reviewed = false;
      form.recoveryError = "";
      try {
        const result = await app.pb.send(hooksApi + "/import", { method: "POST", body: { files: selectedFiles }, requestKey: requestKeys.import });
        if (!valid()) return;
        form.rows = result.files;
        form.revision = result.revision;
        form.reviewed = true;
      } catch (err) {
        if (valid() && !err?.isAbort) app.checkApiError(err);
      } finally {
        if (valid()) form.loading = false;
      }
    }
    async function selectFolder(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (!valid() || form.loading || form.saving || !files.length) return;
      form.loading = true;
      form.reviewed = false;
      form.rows = [];
      form.recoveryError = "";
      form.folder = "";
      form.bytes = 0;
      selectedFiles = [];
      try {
        if (files.length > data.maxDrafts) throw new Error("Select a folder with at most " + data.maxDrafts + " files.");
        const size = files.reduce((total, file) => total + file.size, 0);
        if (size > data.maxDraftBytes) throw new Error("The folder exceeds the combined " + app.utils.formattedFileSize(data.maxDraftBytes) + " limit.");
        const folder = files[0].webkitRelativePath.split("/")[0];
        const imported = [];
        for (const file of files) {
          const parts = file.webkitRelativePath.split("/");
          if (parts.length < 2 || parts[0] !== folder) throw new Error("Select one folder with its relative file paths. This browser must support folder selection.");
          const content = await readImportFile(file);
          if (!valid()) return;
          imported.push({ path: parts.slice(1).join("/"), content });
        }
        selectedFiles = imported;
        form.folder = folder;
        form.bytes = size;
      } catch (err) {
        if (valid()) app.toasts.error(err?.message || "The folder could not be read.");
      } finally {
        if (valid()) form.loading = false;
      }
      if (valid() && selectedFiles.length) await review();
    }
    async function save() {
      if (!valid() || form.loading || form.saving || !form.reviewed || !form.rows.some((file) => file.operation !== "unchanged")) return;
      form.saving = true;
      form.recoveryError = "";
      const revisions = new Map(form.rows.map((file) => [file.path, file.revision]));
      try {
        const result = await app.pb.send(hooksApi + "/import", {
          method: "POST",
          requestKey: requestKeys.import,
          body: { confirm: true, revision: form.revision, files: selectedFiles.map((file) => ({ ...file, revision: revisions.get(file.path) })) },
        });
        if (!valid()) return;
        acceptStatus(result);
        if (data.isNew && !data.directory && !data.name && !data.content && !data.conflict) clearEditor();
        app.toasts.success(result.savedCount + " draft(s) saved. Use Apply changes to install the folder.");
        app.modals.close(modal, true);
      } catch (err) {
        if (valid()) {
          form.reviewed = false;
          if (!err?.status || err?.isAbort) form.recoveryError = "Saving could not be confirmed. Review the folder again to check the saved drafts before retrying.";
          else app.checkApiError(err);
        }
      } finally {
        if (valid()) form.saving = false;
      }
    }
    const importFormId = uniqueId + "_import_form";
    const folderInputId = uniqueId + "_import_folder";
    const folderInput = t.input({ id: folderInputId, type: "file", multiple: true, hidden: true, "html-webkitdirectory": "", "html-directory": "", disabled: () => form.loading || form.saving, onchange: selectFolder });
    modal = t.div(
      {
        pbEvent: "hooksImportModal",
        className: "modal record-upsert-modal",
        onbeforeclose: (_, forced) => {
          if (!forced && form.saving) return false;
        },
        onafterclose: () => {
          if (importModal === modal) importModal = null;
          modal.remove();
          data.importing = false;
          if (alive) refresh(true);
        },
        onunmount: () => app.pb.cancelRequest(requestKeys.import),
      },
      t.header({ className: "modal-header" }, t.div({ className: "grid" }, t.div({ className: "col-12 flex" }, t.h6({ className: "modal-title" }, t.span(null, "Import "), t.strong(null, "hooks"), t.span(null, " folder"))))),
      t.form(
        {
          id: importFormId,
          className: "modal-content",
          onsubmit: (event) => {
            event.preventDefault();
            save();
          },
        },
        t.div(
          { className: "grid" },
          t.div(
            { className: "col-12" },
            t.div(
              { className: "field-list" },
              t.label({ htmlFor: folderInputId }, t.i({ className: "ri-folder-open-line", ariaHidden: true }), t.span({ className: "txt" }, "Hooks folder")),
              folderInput,
              t.output(
                { className: "field-content" },
                t.div(
                  { className: "list", hidden: () => !form.folder },
                  t.div(
                    { className: "list-item highlight" },
                    t.div(
                      { className: "content gap-10" },
                      t.i({ className: "ri-folder-line", ariaHidden: true }),
                      t.strong(null, () => form.folder),
                      t.small({ className: "txt-hint" }, () => selectedFiles.length + " file(s) · " + app.utils.formattedFileSize(form.bytes)),
                    ),
                  ),
                ),
                t.button({ type: "button", className: "btn sm secondary block", disabled: () => form.loading || form.saving, onclick: () => folderInput.click() }, t.i({ className: "ri-upload-cloud-line", ariaHidden: true }), t.span({ className: "txt" }, "Choose folder")),
              ),
            ),
            t.div({ className: "field-help" }, "Select pb_hooks or another hooks folder. Its contents are merged into pb_hooks, preserving subfolders."),
            t.div({ className: "field-help" }, () => "UTF-8 text · Maximum " + app.utils.formattedFileSize(data.maxFileSize) + " per file · " + data.maxDrafts + " files / " + app.utils.formattedFileSize(data.maxDraftBytes) + " of saved drafts."),
            t.div({ className: "field-help" }, "Supported files: .js, .ts, .mjs, .cjs, .json, .txt, .md, .html and .css."),
          ),
          t.div({ className: "col-12 txt-center", hidden: () => !form.loading, role: "status", ariaLabel: "Reading and reviewing folder" }, t.span({ className: "loader" })),
          t.div(
            { className: "col-12", hidden: () => !form.recoveryError },
            t.div(
              { className: "alert warning" },
              t.div(
                { className: "content" },
                t.p(null, () => form.recoveryError),
              ),
            ),
          ),
          t.div(
            { className: "col-12", hidden: () => !form.reviewed },
            t.p({ className: "txt-hint txt-bold" }, "Detected changes"),
            t.div({ className: "list" }, () => form.rows.map((file) => t.div({ className: "list-item" }, t.span({ className: "label import-change-label " + (file.operation === "create" ? "success" : file.operation === "update" ? "warning" : "") }, file.operation === "create" ? "Added" : file.operation === "update" ? "Changed" : "Unchanged"), t.div({ className: "content" }, t.strong(null, file.path), file.pending && file.operation !== "unchanged" ? t.small({ className: "txt-hint" }, "Replaces saved draft") : null)))),
            t.div({ className: "field-help" }, "Save drafts first, then Apply changes to install the files. Files absent from this folder are preserved."),
          ),
          t.div({ className: "col-12", hidden: () => !data.dirty || (data.isNew && !data.directory && !data.name && !data.content) }, t.div({ className: "alert info" }, t.div({ className: "content" }, t.p(null, "Your unsaved editor content is preserved. Save or discard it before applying the imported drafts.")))),
        ),
      ),
      t.footer({ className: "modal-footer" }, t.button({ type: "button", className: "btn transparent m-r-auto", disabled: () => form.saving, onclick: () => app.modals.close(modal) }, t.span({ className: "txt" }, "Close")), t.button({ type: "button", className: "btn outline", hidden: () => form.reviewed || !form.folder, disabled: () => form.loading || form.saving, onclick: review }, t.span({ className: "txt" }, "Review folder")), t.button({ "html-form": importFormId, type: "submit", className: () => "btn expanded-lg " + (form.saving ? "loading" : ""), disabled: () => !form.reviewed || form.loading || form.saving || !form.rows.some((file) => file.operation !== "unchanged") }, t.span({ className: "txt" }, "Save drafts"))),
    );
    importModal = modal;
    document.body.appendChild(modal);
    app.modals.open(modal);
  }

  async function onFileDrop(event) {
    resetFileDrag();
    const files = event.dataTransfer?.files;
    if (!files?.length) {
      return;
    }
    event.preventDefault();
    if (!isCurrent(generation) || !data.canImport || document.querySelector('.modal[data-modal-state="open"]')) {
      return;
    }
    const token = ++generation;
    cancelReads();
    data.loading = true;
    data.error = "";
    data.recoveryError = "";
    try {
      if (files.length !== 1 || !/\.js$/i.test(files[0].name)) {
        throw new Error("Drop a single .js file.");
      }
      const file = files[0];
      const content = await readImportFile(file);
      if (!isCurrent(token)) {
        return;
      }
      if (data.isNew) {
        data.name = file.name;
      }
      data.content = content;
      rememberDraft();
    } catch (err) {
      if (isCurrent(token)) {
        app.toasts.error(err?.message || "Failed to load the imported file.");
      }
    } finally {
      if (isCurrent(token)) {
        data.loading = false;
      }
    }
  }

  async function saveFile() {
    if (!alive || data.isBusy || !data.ready || !data.dirty || data.conflict || data.pending === "delete") {
      return;
    }
    if (!document.getElementById(uniqueId + "_form").reportValidity()) {
      return;
    }
    if (new TextEncoder().encode(data.content).length > data.maxFileSize) {
      app.toasts.error("The file exceeds the " + app.utils.formattedFileSize(data.maxFileSize) + " limit.");
      return;
    }
    const token = ++generation;
    cancelReads();
    data.busy = true;
    data.error = "";
    data.recoveryError = "";
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
    if (!alive || data.isBusy || !data.ready || data.isNew || !data.path || data.conflict || data.pending === "delete") {
      return;
    }
    const path = data.path;
    const revision = data.revision;
    app.modals.confirm(
      t.div({ className: "txt-center" }, t.h6(null, "Stage deletion of " + path + "?"), t.p(null, "An existing file is removed only when you apply. A new file that exists only as a draft is discarded."), data.dirty ? t.p(null, "Your unsaved draft will also be discarded.") : null),
      async () => {
        if (!alive || data.isBusy || !data.ready || data.conflict) {
          return;
        }
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
          if (isCurrent(token)) {
            data.busy = false;
          }
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
      resetFileDrag();
      cancelReads();
      app.pb.cancelRequest(requestKeys.status);
    } else {
      refresh();
    }
  }

  async function setFileState(path, value, kind = "hidden", revision = "") {
    if (!isCurrent(generation) || !data.ready || data.isBusy || !path) return;
    const activation = kind === "disabled";
    const token = ++generation;
    cancelReads();
    data.busy = true;
    data.error = "";
    data.recoveryError = "";
    try {
      if (activation && !value) {
        const file = await app.pb.send(hooksApi + "/file", {
          method: "GET",
          query: { path, disabled: "true" },
          requestKey: requestKeys.file,
        });
        if (!isCurrent(token)) return;
        revision = file.revision;
      }
      const result = await app.pb.send(hooksApi + (activation ? "/activation" : "/visibility"), {
        method: "POST",
        body: { path, [kind]: value, ...(activation ? { revision } : {}) },
        requestKey: requestKeys.write,
        ...(activation ? { signal: AbortSignal.timeout(15000) } : {}),
      });
      if (isCurrent(token)) {
        acceptStatus(result);
        if (activation) {
          if (value) data.files = data.files.filter((file) => file.path !== path);
          else data.disabledFiles = data.disabledFiles.filter((file) => file.path !== path);
          app.toasts.success(value ? "Hook disabled. Enable it again in Settings > Plugins > Hooks Disabled." : "Hook enabled. Its previous visibility preference was preserved.");
        } else {
          data.files = data.files.map((file) => (file.path === path ? { ...file, hidden: value } : file));
          if (!value) data.hiddenFiles = data.hiddenFiles.filter((file) => file.path !== path);
          app.toasts.success(value ? "Hook hidden. Show it again in Settings > Plugins > Hooks Hidden." : "Hook visibility restored.");
        }
        if (value && data.path === path) clearEditor();
      }
    } catch (err) {
      if (isCurrent(token)) {
        if (activation && !err?.status) {
          data.recoveryError = "The action could not be confirmed. PocketBase may be restarting. Refresh the lists before trying again.";
        } else {
          showError(err);
        }
      }
    } finally {
      if (alive && app.pb.authStore.record?.id === owner) {
        data.busy = false;
        refresh();
      }
    }
  }

  function confirmFileDisabled(path, disabled) {
    if (!isCurrent(generation) || !data.ready || data.isBusy || !path) return;
    if (disabled && (data.pending || data.conflict || data.path !== path)) return;
    const revision = disabled ? data.revision : "";
    app.modals.confirm(
      t.div({ className: "txt-center" }, t.h6(null, (disabled ? "Disable " : "Enable ") + path + "?"), t.p(null, disabled ? "The file will move to pb_hooks.disabled and remain available in Hooks Disabled." : "The file will return to its original path in pb_hooks. Its visibility preference will be preserved."), t.p(null, "This takes effect after PocketBase restarts. If it does not restart automatically, restart the instance externally."), disabled && data.dirty ? t.p(null, "Your unsaved editing will be discarded.") : null),
      () => {
        if (disabled && (data.path !== path || data.revision !== revision || data.pending || data.conflict)) return;
        return setFileState(path, disabled, "disabled", revision);
      },
      null,
      { yesButton: disabled ? "Disable" : "Enable", noButton: "Cancel" },
    );
  }

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!document.querySelector('.modal[data-modal-state="open"]')) {
        saveFile();
      }
    }
  }

  const pageProps = {
    pbEvent: settings ? "pageHooksSettings" : "pageHooksManager",
    className: "page",
    onmount: () => {
      refresh(true);
      intervalId = setInterval(() => refresh(), 3000);
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (!settings) {
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("dragenter", onFileDragOver, true);
        window.addEventListener("dragover", onFileDragOver, true);
        window.addEventListener("dragleave", onFileDragLeave, true);
        window.addEventListener("dragend", resetFileDrag, true);
        window.addEventListener("blur", resetFileDrag);
        window.addEventListener("drop", onFileDrop, true);
      }
    },
    onunmount: () => {
      rememberDraft();
      resetFileDrag();
      alive = false;
      ++generation;
      if (importModal) app.modals.close(importModal, true);
      clearInterval(intervalId);
      Object.values(requestKeys).forEach((key) => app.pb.cancelRequest(key));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dragenter", onFileDragOver, true);
      window.removeEventListener("dragover", onFileDragOver, true);
      window.removeEventListener("dragleave", onFileDragLeave, true);
      window.removeEventListener("dragend", resetFileDrag, true);
      window.removeEventListener("blur", resetFileDrag);
      window.removeEventListener("drop", onFileDrop, true);
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
        t.header({ className: "page-header" }, t.nav({ className: "breadcrumbs" }, t.div({ className: "breadcrumb-item" }, "Settings"), t.div({ className: "breadcrumb-item" }, settingsTitle))),
        t.div(
          { className: "wrapper m-b-base" },
          t.div(
            { className: "flex gap-10 m-b-sm" },
            t.div({ className: "txt-lg" }, disabledSettings ? "Disabled hooks" : "Hidden hooks"),
            app.components.refreshButton({
              className: "btn sm transparent secondary circle tooltip-bottom",
              tooltip: disabledSettings ? "Refresh disabled hooks" : "Refresh hidden hooks",
              disabled: () => data.isBusy || data.refreshing,
              onclick: () => refresh(true),
            }),
          ),
          t.div({ className: "alert warning m-b-sm", hidden: () => !data.recoveryError }, () => data.recoveryError),
          t.div({ className: "alert info m-b-sm", hidden: () => !data.restartRequired }, "Hook files changed. If PocketBase has not restarted automatically, restart the instance externally to load the changes."),
          t.div(
            { className: "list" },
            t.div({ className: "list-content" }, t.div({ className: "list-item", hidden: () => data.ready || !data.refreshing }, t.div({ className: "skeleton-loader" })), t.div({ className: "list-item", hidden: () => !data.ready || !!data.settingsFiles.length }, t.div({ className: "content block txt-hint" }, disabledSettings ? "No disabled hooks found." : "No hidden hooks found.")), () =>
              data.settingsFiles.map((file) =>
                t.div(
                  { className: "list-item" },
                  t.i({ className: "ri-file-code-line", ariaHidden: true }),
                  t.div({ className: "content" }, t.span({ className: "txt-ellipsis", title: file.path }, file.path), !file.missing ? t.small({ className: "txt-hint txt-nowrap" }, "(" + app.utils.formattedFileSize(file.size) + ")") : null, file.pending ? t.span({ className: "label sm warning" }, file.pending) : null, file.disabled && !disabledSettings ? t.span({ className: "label sm" }, "Disabled") : null, file.hidden && disabledSettings ? t.span({ className: "label sm" }, "Hidden") : null, file.missing ? t.small({ className: "txt-hint" }, "File no longer exists") : null),
                  t.nav(
                    { className: "actions" },
                    t.button(
                      {
                        type: "button",
                        className: "btn sm circle secondary transparent",
                        ariaLabel: app.attrs.tooltip(disabledSettings ? "Enable" : "Show"),
                        disabled: () => data.isBusy,
                        onclick: () => (disabledSettings ? confirmFileDisabled(file.path, false) : setFileState(file.path, false)),
                      },
                      t.i({ className: disabledSettings ? "ri-play-circle-line" : "ri-eye-line", ariaHidden: true }),
                    ),
                  ),
                ),
              ),
            ),
            t.div({ className: "list-item" }, t.a({ href: "#/hooks", className: "btn secondary block" }, t.i({ className: "ri-code-box-line", ariaHidden: true }), t.span({ className: "txt" }, "Manage hooks"))),
          ),
          t.p({ className: "txt-sm txt-hint m-t-sm" }, disabledSettings ? "Disabled files are stored in pb_hooks.disabled. Enable a file to restore it, then restart PocketBase if it does not restart automatically." : "Hiding only changes visibility. Show a file to restore its visibility; disabled files must also be enabled in Hooks Disabled."),
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
                    if (data.isNew || file.path !== data.path) {
                      confirmDiscard(() => loadFile(file.path));
                    }
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
        t.button({ type: "button", className: "btn outline block m-t-sm", disabled: () => data.isBusy || !data.ready, onclick: openFolderImport }, t.i({ className: "ri-folder-upload-line", ariaHidden: true }), t.span({ className: "txt" }, "Import folder")),
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
              hidden: () => !data.path || data.isNew || data.currentHidden || data.currentDisabled,
              ariaLabel: app.attrs.tooltip("Hide"),
              disabled: () => data.isBusy || !data.ready,
              onclick: () => confirmDiscard(() => setFileState(data.path, true)),
            },
            t.i({ className: "ri-eye-off-line", ariaHidden: true }),
          ),
          t.button(
            {
              type: "button",
              className: "btn transparent secondary circle",
              hidden: () => !data.path || data.isNew || data.currentDisabled,
              ariaLabel: app.attrs.tooltip("Disable"),
              title: () => (data.pending ? "Apply or discard this saved draft before disabling the file" : "Disable"),
              disabled: () => data.isBusy || !data.ready || !!data.pending || data.conflict,
              onclick: () => confirmFileDisabled(data.path, true),
            },
            t.i({ className: "ri-forbid-line", ariaHidden: true }),
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
      t.div({ className: "alert info m-b-sm", hidden: () => !data.restartRequired }, t.p({ className: "txt-bold" }, "Hook files changed"), t.p(null, "If PocketBase has not restarted automatically, restart the instance externally to load the changes.")),
      t.div(
        { className: "alert warning m-b-sm", hidden: () => !data.recoveryError },
        t.p(null, () => data.recoveryError),
      ),
      t.div(
        { className: "alert warning m-b-sm", hidden: () => !data.conflict },
        t.p({ className: "txt-bold" }, () => (data.currentDisabled ? "Hook disabled" : data.missing ? "File or saved draft removed" : "File or saved draft changed")),
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
            t.span({ className: "label sm", hidden: () => !data.currentDisabled }, "Disabled"),
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
          t.div(
            {
              className: "txt-center",
              role: "status",
              hidden: () => !data.dragging || !data.canImport,
              style: "position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; border: 2px dashed var(--accentColor); border-radius: inherit; background: color-mix(in srgb, var(--surfaceColor), transparent 6%); color: var(--surfaceTxtColor); pointer-events: none; overflow-wrap: anywhere;",
            },
            t.i({ className: "ri-upload-cloud-line", ariaHidden: true, style: "font-size: 48px; color: var(--accentColor);" }),
            t.p({ className: "txt-lg txt-bold" }, "Drop a .js file here"),
            t.p({ className: "txt-hint" }, () => (data.isNew ? "Fill the file name and content in the selected directory." : "Replace all content in " + data.path + ".")),
          ),
        ),
        t.div(
          { className: "field-help flex flex-nowrap gap-sm m-b-sm", style: "flex: 0 0 auto;" },
          t.span(null, "Drop a .js file · UTF-8 text · Maximum ", () => app.utils.formattedFileSize(data.maxFileSize), " · Save draft first, then Apply changes to update pb_hooks."),
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
      t.div({ className: "txt-center m-auto", hidden: () => !data.ready || data.hasFile || (!data.files.length && !data.disabledFiles.length) || !!data.visibleFiles.length }, t.p({ className: "txt-hint" }, "All hook files are hidden or disabled."), t.a({ href: "#/settings/hooks", className: "btn secondary", hidden: () => !data.hiddenFiles.length }, "Show hidden hooks"), t.a({ href: "#/settings/hooks-disabled", className: "btn secondary", hidden: () => !data.disabledFiles.length }, "Enable disabled hooks")),
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
if (!app.store.settingsNavGroups.Plugins) {
  app.store.settingsNavGroups.Plugins = [];
}
const hooksSettingsGroup = app.store.settingsNavGroups.Plugins;
if (!hooksSettingsGroup.some((link) => link.href === "#/settings/hooks")) {
  hooksSettingsGroup.push({ href: "#/settings/hooks", icon: "ri-eye-off-line", label: "Hooks Hidden" });
}
app.routes.superuserOnly("#/settings/hooks", pageHooks);
if (!hooksSettingsGroup.some((link) => link.href === "#/settings/hooks-disabled")) {
  hooksSettingsGroup.push({ href: "#/settings/hooks-disabled", icon: "ri-forbid-line", label: "Hooks Disabled" });
}
app.routes.superuserOnly("#/settings/hooks-disabled", pageHooks);

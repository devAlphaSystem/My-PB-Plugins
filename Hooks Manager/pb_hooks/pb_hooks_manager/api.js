const MAX_FILE_SIZE = 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 20;
const PREFIX = "pb_hooks_manager.";
const EXTENSIONS = /\.(?:js|ts|mjs|cjs|json|txt|md|html|css)$/i;
const MAX_DRAFTS = 100;
const MAX_DRAFT_BYTES = 8 * MAX_FILE_SIZE;
const MAX_STATE_SIZE = 6 * MAX_DRAFT_BYTES + 256 * 1024;

function fail(status, message) { throw new ApiError(status, message); }

function allowedSegment(segment) {
  const lower = segment.toLowerCase();
  return !!segment && segment.length <= 255 && segment[0] !== "." && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(segment) && !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) && lower !== "node_modules" && lower !== "pb_hooks_manager" && lower !== "pb_hooks_manager.pb.js";
}

function validatePath(path) {
  if (typeof path !== "string" || !path || path.length > 1024) { fail(400, "Provide a relative file path inside pb_hooks."); }
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH || !segments.every(allowedSegment) || !EXTENSIONS.test(path)) { fail(400, "Use a supported text file and a relative path without hidden, reserved or plugin names."); }
  return segments;
}

function entryInfo(root, name) {
  const entry = root.fs().readDir(".").find(function (item) { return item.name() === name || (__hooks[0] !== "/" && item.name().toLowerCase() === name.toLowerCase()); });
  return entry ? root.lstat(name) : null;
}

function openParent(root, segments) {
  let current = root;
  try {
    for (let i = 0; i < segments.length - 1; i++) {
      const info = entryInfo(current, segments[i]);
      if (!info || !info.isDir() || info.mode() & (1 << 27)) { fail(400, "The parent directory must already exist and cannot be a symbolic link."); }
      const next = current.openRoot(segments[i]);
      if (current !== root) current.close();
      current = next;
    }
    return current;
  } catch (err) {
    if (current !== root) current.close();
    throw err;
  }
}

function metadata(path, info) {
  return {
    path: path,
    size: info.size(),
    modified: info.modTime().utc().format("2006-01-02T15:04:05.000000000Z"),
  };
}

function readFile(root, name, path, maxSize) {
  maxSize = maxSize || MAX_FILE_SIZE;
  const info = entryInfo(root, name);
  if (!info) fail(404, "The file no longer exists.");
  if (!info.mode().isRegular()) fail(400, "Only regular files can be opened.");
  if (info.size() > maxSize) fail(413, "The file exceeds the supported size limit.");

  const handle = root.open(name);
  let bytes;
  try { bytes = toBytes(handle, maxSize + 1); } finally { handle.close(); }
  if (bytes.length > maxSize) fail(413, "The file exceeds the supported size limit.");
  for (let i = 0; i < bytes.length; i++) {
    const first = bytes[i];
    if (first === 0) fail(415, "Only UTF-8 text without null characters can be edited.");
    if (first < 128) continue;
    const count = first >= 194 && first <= 223 ? 1 : first >= 224 && first <= 239 ? 2 : first >= 240 && first <= 244 ? 3 : -1;
    if (count < 0 || i + count >= bytes.length) fail(415, "The file must use UTF-8 encoding.");
    const second = bytes[i + 1];
    if ((first === 224 && second < 160) || (first === 237 && second > 159) || (first === 240 && second < 144) || (first === 244 && second > 143)) { fail(415, "The file must use UTF-8 encoding."); }
    for (let j = 0; j < count; j++) {
      const next = bytes[++i];
      if (next < 128 || next > 191) fail(415, "The file must use UTF-8 encoding.");
    }
  }
  const content = toString(bytes);
  const result = metadata(path, info);
  result.content = content;
  result.revision = $security.sha256(content);
  return result;
}

function requireRevision(actual, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) { fail(400, "A file revision is required. Open the file again."); }
  if (actual !== expected) fail(409, "The file changed on disk. Reload it before saving or deleting.");
}

function writeFile(root, name, path, content, previous, maxSize) {
  const temporaryDir = ".pb-hooks-write-" + $security.randomString(32);
  root.mkdir(temporaryDir, 0o700);
  const temporaryPath = temporaryDir + "/content";
  let handle;
  let temporaryExists = false;
  let operationError;
  let committed = false;
  try {
    handle = root.create(temporaryPath);
    temporaryExists = true;
    handle.chmod(previous ? root.lstat(name).mode().perm() : 0o600);
    const bytesWritten = handle.writeString(content);
    if (bytesWritten !== toBytes(content).length) fail(500, "The complete file could not be written.");
    handle.sync();
    handle.close();
    handle = null;

    if (previous) {
      requireRevision(readFile(root, name, path, maxSize).revision, previous.revision);
      root.rename(temporaryPath, name);
      temporaryExists = false;
    } else {
      if (entryInfo(root, name)) fail(409, "A file with this name already exists.");
      try { root.link(temporaryPath, name); } catch (err) {
        let exists = false;
        try { exists = !!root.lstat(name); } catch (_) {}
        if (exists) fail(409, "A file with this name already exists.");
        throw err;
      }
    }
    committed = true;
  } catch (err) { operationError = err; } finally {
    try {
      if (handle) handle.close();
    } catch (err) { operationError = operationError || err; }
    try {
      if (temporaryExists) root.chmod(temporaryPath, 0o600);
    } catch (err) { operationError = operationError || err; }
    try {
      if (temporaryExists) root.remove(temporaryPath);
    } catch (err) { operationError = operationError || err; }
    try { root.remove(temporaryDir); } catch (err) { operationError = operationError || err; }
  }
  if (operationError) {
    if (committed) fail(500, "The file was saved, but temporary file cleanup failed. Refresh the file before trying again.");
    throw operationError;
  }
}

function withRoot(e, callback) {
  e.response.header().set("Cache-Control", "no-store");
  let acquired = false;
  e.app.store().setFunc(PREFIX + "busy", function (busy) {
    acquired = !busy;
    return true;
  });
  if (!acquired) fail(423, "Another hooks operation is in progress. Try again.");
  let root;
  let parent;
  let draftsRoot;
  try {
    const name = $filepath.base(__hooks);
    if ($filepath.dir(__hooks) === __hooks) fail(400, "Use a dedicated hooks directory, not a filesystem root.");
    parent = $os.openRoot($filepath.dir(__hooks));
    const hooksInfo = parent.lstat(name);
    if (!hooksInfo || !hooksInfo.isDir() || hooksInfo.mode() & (1 << 27)) { fail(400, "The hooks root must be a real directory so saved drafts stay outside the monitored tree."); }
    root = parent.openRoot(name);
    const draftsName = name + ".drafts";
    let draftsInfo = entryInfo(parent, draftsName);
    if (!draftsInfo) {
      parent.mkdir(draftsName, 0o700);
      draftsInfo = parent.lstat(draftsName);
    }
    if (!draftsInfo.isDir() || draftsInfo.mode() & (1 << 27)) { fail(400, "The draft storage must be a real directory beside the hooks directory."); }
    draftsRoot = parent.openRoot(draftsName);
    const previous = entryInfo(draftsRoot, "state.json") ? readFile(draftsRoot, "state.json", "state.json", MAX_STATE_SIZE) : null;
    const state = previous
      ? JSON.parse(previous.content)
      : {
          version: 1,
          revision: $security.randomString(32),
          drafts: [],
          apply: null,
        };
    if (state.version !== 1 || !Array.isArray(state.drafts) || state.drafts.length > MAX_DRAFTS || typeof state.revision !== "string") { fail(500, "The saved draft state is invalid. Check the draft storage before continuing."); }
    if (state.hiddenPaths === undefined) state.hiddenPaths = [];
    if (!Array.isArray(state.hiddenPaths) || state.hiddenPaths.length > MAX_ENTRIES) { fail(500, "The saved hidden hooks list is invalid. Check the draft storage before continuing."); }
    const hiddenKeys = Object.create(null);
    state.hiddenPaths.forEach(function (path) {
      validatePath(path);
      const key = __hooks[0] === "/" ? path : path.toLowerCase();
      if (hiddenKeys[key]) fail(500, "The saved hidden hooks list contains duplicate paths.");
      hiddenKeys[key] = true;
    });
    const paths = [];
    let draftBytes = 0;
    state.drafts.forEach(function (draft) {
      validatePath(draft.path);
      validateContent(draft.content);
      const key = __hooks[0] === "/" ? draft.path : draft.path.toLowerCase();
      if (paths.indexOf(key) !== -1 || !/^[a-f0-9]{64}$/.test(draft.revision) || (draft.baseRevision !== null && !/^[a-f0-9]{64}$/.test(draft.baseRevision)) || ["write", "delete"].indexOf(draft.operation) === -1 || typeof draft.modified !== "string") { fail(500, "The saved draft state is invalid. Check the draft storage before continuing."); }
      paths.push(key);
      draftBytes += toBytes(draft.content).length;
    });
    if (draftBytes > MAX_DRAFT_BYTES) fail(500, "The saved draft state exceeds the combined content limit.");
    const progressPrevious = entryInfo(draftsRoot, "apply.json") ? readFile(draftsRoot, "apply.json", "apply.json", 256 * 1024) : null;
    if (progressPrevious && !previous) fail(500, "The draft manifest is missing while apply progress exists. Restore the draft storage before continuing.");
    state.apply = progressPrevious ? JSON.parse(progressPrevious.content) : null;
    if (state.apply) {
      if (!Array.isArray(state.apply.completed) || !Number.isInteger(state.apply.total) || state.apply.total < 1 || state.apply.total > MAX_DRAFTS || state.apply.completed.length > state.apply.total || ["applying", "complete", "partial"].indexOf(state.apply.status) === -1) { fail(500, "The saved apply progress is invalid. Check the draft storage before continuing."); }
      state.drafts = state.drafts.filter(function (draft) { return !state.apply.completed.some(function (item) { return item.path === draft.path && item.revision === draft.revision; }); });
      state.drafts.forEach(function (draft) {
        if (state.apply.current === draft.path && state.apply.currentRevision === draft.revision) draft.inFlight = true;
      });
    }
    const context = { root: root, draftsRoot: draftsRoot, state: state, previous: previous, progressPrevious: progressPrevious };
    return callback(context);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, "The filesystem operation failed. Check the PocketBase process permissions and available disk space.");
  } finally {
    try {
      if (draftsRoot) draftsRoot.close();
    } finally {
      try {
        if (root) root.close();
      } finally {
        try {
          if (parent) parent.close();
        } finally { e.app.store().set(PREFIX + "busy", false); }
      }
    }
  }
}

function saveState(context) {
  if (context.state.drafts.length > MAX_DRAFTS) fail(413, "Apply or discard saved drafts before adding more (limit: 100).");
  let size = 0;
  context.state.drafts.forEach(function (draft) { size += toBytes(draft.content).length; });
  if (size > MAX_DRAFT_BYTES) fail(413, "Saved drafts exceed the combined 8 MiB limit.");
  context.state.revision = $security.randomString(32);
  const content = JSON.stringify(Object.assign({}, context.state, { apply: undefined }));
  if (toBytes(content).length > MAX_STATE_SIZE) fail(413, "Saved drafts and hidden hook preferences exceed the storage limit.");
  writeFile(context.draftsRoot, "state.json", "state.json", content, context.previous, MAX_STATE_SIZE);
  context.previous = { revision: $security.sha256(content) };
}

function saveProgress(context) {
  const content = JSON.stringify(context.state.apply);
  writeFile(context.draftsRoot, "apply.json", "apply.json", content, context.progressPrevious, 256 * 1024);
  context.progressPrevious = { revision: $security.sha256(content) };
}

function currentFile(root, path) {
  const segments = validatePath(path);
  const parent = openParent(root, segments);
  try {
    const name = segments[segments.length - 1];
    return entryInfo(parent, name) ? readFile(parent, name, path) : null;
  } finally {
    if (parent !== root) parent.close();
  }
}

function viewFile(context, path) {
  const draft = context.state.drafts.find(function (item) { return item.path === path; });
  let current;
  let unreadable = false;
  try { current = currentFile(context.root, path); } catch (err) {
    if (!draft) throw err;
    unreadable = true;
  }
  if (!draft) {
    if (!current) fail(404, "The file no longer exists.");
    return Object.assign(current, { pending: "", diskChanged: false });
  }
  return {
    path: path,
    content: draft.content,
    revision: draft.revision,
    size: toBytes(draft.content).length,
    modified: draft.modified,
    pending: draft.operation === "delete" ? "delete" : draft.baseRevision === null ? "create" : "update",
    diskChanged: unreadable || ((current ? current.revision : null) !== draft.baseRevision && !(draft.inFlight && appliedOnDisk(draft, current))),
  };
}

function status(e, state) {
  const bootId = e.app.store().get(PREFIX + "bootId");
  const apply = state.apply ? Object.assign({}, state.apply) : null;
  if (apply && apply.status === "applying") { apply.status = apply.completed.length === apply.total && !apply.current ? "complete" : "interrupted"; }
  return {
    bootId: bootId,
    revision: state.revision,
    pendingCount: state.drafts.length,
    apply: apply,
    restartRequired: e.app.store().get(PREFIX + "restartRequired") === true,
  };
}

function validateContent(content) {
  if (typeof content !== "string") fail(400, "File content must be a string.");
  if (toBytes(content).length > MAX_FILE_SIZE) fail(413, "Files must be at most 1 MiB.");
  if (content.indexOf("\u0000") !== -1) fail(415, "Only UTF-8 text without null characters can be saved.");
  try { encodeURIComponent(content); } catch (_) { fail(415, "The content contains invalid Unicode characters."); }
}

exports.list = function (e) {
  return withRoot(e, function (context) {
    const root = context.root;
    const files = [];
    const directories = [""];
    let entriesCount = 0;
    function visit(directory, prefix, depth) {
      const entries = directory.fs().readDir(".");
      for (const entry of entries) {
        if (++entriesCount > MAX_ENTRIES) fail(413, "The hooks directory contains too many entries to display (limit: 10000).");
        const name = entry.name();
        if (!allowedSegment(name)) continue;
        const info = directory.lstat(name);
        if (info.mode() & (1 << 27)) continue;
        const path = prefix ? prefix + "/" + name : name;
        if (info.isDir()) {
          if (depth >= MAX_DEPTH - 1) continue;
          directories.push(path);
          const child = directory.openRoot(name);
          try { visit(child, path, depth + 1); } finally { child.close(); }
        } else if (info.mode().isRegular() && EXTENSIONS.test(name)) { files.push(metadata(path, info)); }
      }
    }
    visit(root, "", 0);
    context.state.drafts.forEach(function (draft) {
      let item = files.find(function (file) { return file.path === draft.path; });
      if (!item) {
        item = { path: draft.path, size: 0, modified: draft.modified };
        files.push(item);
      }
      item.pending = draft.operation === "delete" ? "delete" : draft.baseRevision === null ? "create" : "update";
      item.size = toBytes(draft.content).length;
      item.modified = draft.modified;
    });
    files.sort(function (a, b) { return a.path.localeCompare(b.path); });
    const filesByPath = Object.create(null);
    files.forEach(function (file) { filesByPath[__hooks[0] === "/" ? file.path : file.path.toLowerCase()] = file; });
    const hiddenFiles = context.state.hiddenPaths.map(function (path) {
      const file = filesByPath[__hooks[0] === "/" ? path : path.toLowerCase()];
      if (file) {
        file.hidden = true;
        return file;
      }
      return { path: path, hidden: true, missing: true };
    });
    hiddenFiles.sort(function (a, b) { return a.path.localeCompare(b.path); });
    directories.sort();
    return e.json(
      200,
      Object.assign(status(e, context.state), {
        files: files,
        hiddenFiles: hiddenFiles,
        directories: directories,
        maxFileSize: MAX_FILE_SIZE,
      }),
    );
  });
};

exports.file = function (e) {
  const method = e.request.method;
  const readOnly = method === "GET";
  const body = readOnly ? null : e.requestInfo().body;
  if (!readOnly && (!body || typeof body !== "object" || Array.isArray(body))) { fail(400, "Provide a JSON object with the file fields."); }
  const path = readOnly ? e.request.url.query().get("path") : body.path;
  validatePath(path);

  return withRoot(e, function (context) {
    if (readOnly) return e.json(200, viewFile(context, path));
    let draft = context.state.drafts.find(function (item) { return item.path === path; });
    if (draft && draft.inFlight) fail(409, "An interrupted apply needs review. Apply again or discard this saved draft first.");
    const current = currentFile(context.root, path);
    if (method === "POST") {
      const duplicate = context.state.drafts.some(function (item) { return __hooks[0] === "/" ? item.path === path : item.path.toLowerCase() === path.toLowerCase(); });
      if (current || duplicate) fail(409, "A file or saved draft with this name already exists.");
    } else {
      const previous = draft || current;
      if (!previous) fail(404, "The file or saved draft no longer exists.");
      requireRevision(previous.revision, body.revision);
    }
    if (method !== "DELETE") validateContent(body.content);
    if (!draft) {
      draft = { path: path, baseRevision: current ? current.revision : null };
      context.state.drafts.push(draft);
    }
    const cancelled = method === "DELETE" && draft.baseRevision === null;
    if (cancelled) { context.state.drafts = context.state.drafts.filter(function (item) { return item !== draft; }); } else {
      draft.operation = method === "DELETE" ? "delete" : "write";
      draft.content = method === "DELETE" ? (draft.content === undefined ? current.content : draft.content) : body.content;
      draft.revision = $security.sha256($security.randomString(32));
      draft.modified = new Date().toISOString();
    }
    saveState(context);
    if (method === "DELETE") return e.json(200, { staged: !cancelled, cancelled: cancelled });
    return e.json(method === "POST" ? 201 : 200, viewFile(context, path));
  });
};

exports.discard = function (e) {
  const body = e.requestInfo().body;
  if (!body || typeof body !== "object") fail(400, "Provide the saved draft path and revision.");
  validatePath(body.path);
  return withRoot(e, function (context) {
    const draft = context.state.drafts.find(function (item) { return item.path === body.path; });
    if (!draft) fail(404, "The saved draft no longer exists.");
    requireRevision(draft.revision, body.revision);
    context.state.drafts = context.state.drafts.filter(function (item) { return item !== draft; });
    saveState(context);
    return e.json(200, { discarded: true });
  });
};

exports.status = function (e) { return withRoot(e, function (context) { return e.json(200, status(e, context.state)); }); };

exports.visibility = function (e) {
  const body = e.requestInfo().body;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.hidden !== "boolean") { fail(400, "Provide the hook path and a boolean hidden value."); }
  validatePath(body.path);
  return withRoot(e, function (context) {
    const paths = context.state.hiddenPaths;
    const index = paths.findIndex(function (path) { return __hooks[0] === "/" ? path === body.path : path.toLowerCase() === body.path.toLowerCase(); });
    if (body.hidden && index === -1) {
      viewFile(context, body.path);
      if (paths.length >= MAX_ENTRIES) fail(413, "Show hidden hooks before hiding more files (limit: 10000).");
      paths.push(body.path);
      saveState(context);
    } else if (!body.hidden && index !== -1) {
      paths.splice(index, 1);
      saveState(context);
    }
    return e.json(200, status(e, context.state));
  });
};

function appliedOnDisk(draft, current) { return draft.operation === "delete" ? !current : !!current && current.revision === $security.sha256(draft.content); }

function checkBase(draft, current) {
  if (draft.inFlight && appliedOnDisk(draft, current)) return;
  if ((current ? current.revision : null) !== draft.baseRevision) { fail(409, "The file changed on disk: " + draft.path + ". Review it and discard the saved draft before saving a new version."); }
}

exports.apply = function (e) {
  const body = e.requestInfo().body;
  if (!body || body.confirm !== true || typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{12,128}$/.test(body.requestId)) { fail(400, "Confirm the apply request and provide its identifier."); }
  return withRoot(e, function (context) {
    const state = context.state;
    if (state.apply && state.apply.id === body.requestId) return e.json(200, status(e, state));
    if (body.revision !== state.revision) fail(409, "The saved drafts changed. Refresh and review them before applying.");
    if (!state.drafts.length) fail(400, "There are no saved drafts to apply.");
    state.drafts.forEach(function (draft) { checkBase(draft, currentFile(context.root, draft.path)); });
    saveState(context);
    state.apply = {
      id: body.requestId,
      bootId: e.app.store().get(PREFIX + "bootId"),
      status: "applying",
      total: state.drafts.length,
      completed: [],
      current: "",
      currentRevision: "",
      error: "",
    };
    saveProgress(context);
    try {
      while (state.drafts.length) {
        const draft = state.drafts[0];
        const current = currentFile(context.root, draft.path);
        checkBase(draft, current);
        const recovered = draft.inFlight && appliedOnDisk(draft, current);
        draft.inFlight = true;
        state.apply.current = draft.path;
        state.apply.currentRevision = draft.revision;
        saveProgress(context);
        if (!recovered) {
          const segments = validatePath(draft.path);
          const parent = openParent(context.root, segments);
          try {
            const name = segments[segments.length - 1];
            if (draft.operation === "delete") {
              requireRevision(readFile(parent, name, draft.path).revision, draft.baseRevision);
              parent.remove(name);
            } else { writeFile(parent, name, draft.path, draft.content, current); }
          } finally {
            if (parent !== context.root) parent.close();
          }
        }
        e.app.store().set(PREFIX + "restartRequired", true);
        state.apply.completed.push({ path: draft.path, revision: draft.revision });
        state.apply.current = "";
        state.apply.currentRevision = "";
        state.drafts.shift();
        saveProgress(context);
      }
      saveState(context);
      state.apply.status = "complete";
      saveProgress(context);
      return e.json(200, status(e, state));
    } catch (err) {
      state.apply.status = "partial";
      state.apply.error = err instanceof ApiError ? err.message : "A filesystem operation failed. Check permissions and disk space.";
      try { saveProgress(context); } catch (_) { fail(500, "Apply was interrupted and its final progress could not be saved. Refresh and review the remaining drafts before retrying."); }
      return e.json(200, status(e, state));
    }
  });
};

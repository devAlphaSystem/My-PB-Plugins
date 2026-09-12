const PREFIX = "pb_cron_manager.";
const MAX_JOBS = 50;
const MAX_CODE_BYTES = 32 * 1024;
const HISTORY_LIMIT = 200;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9]{20}$/;
const REVISION_PATTERN = /^[a-zA-Z0-9]{32}$/;

function fail(status, message) { throw new ApiError(status, message); }

function nativeId(id) { return PREFIX + id; }
function runningKey(id) { return PREFIX + "running." + id; }

function withStorage(app, callback) {
  let acquired = false;
  const deadline = Date.now() + 2000;
  do {
    app.store().setFunc(PREFIX + "storageBusy", function (busy) {
      if (busy) return busy;
      acquired = true;
      return true;
    });
    if (!acquired) sleep(10);
  } while (!acquired && Date.now() < deadline);
  if (!acquired) fail(423, "Cron Manager is updating its storage. Try again shortly.");

  let parent;
  let root;
  try {
    parent = $os.openRoot(app.dataDir());
    const name = "pb_cron_manager";
    if (!parent.fs().readDir(".").some(function (entry) { return entry.name() === name; })) { parent.mkdir(name, 0o700); }
    const info = parent.lstat(name);
    if (!info.isDir() || info.mode() & (1 << 27)) { fail(500, "Cron Manager storage must be a real directory, not a symbolic link."); }
    root = parent.openRoot(name);
    return callback({ app: app, root: root });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail(500, "Cron Manager could not access its storage. Check permissions, disk space, and saved JSON files.");
  } finally {
    try {
      if (root) root.close();
    } finally {
      try {
        if (parent) parent.close();
      } finally { app.store().set(PREFIX + "storageBusy", false); }
    }
  }
}

function readJson(context, name, empty) {
  if (!context.root.fs().readDir(".").some(function (entry) { return entry.name() === name; })) return empty;
  const info = context.root.lstat(name);
  if (!info.mode().isRegular() || info.size() > MAX_JSON_BYTES) fail(500, "Cron Manager storage contains an invalid or oversized file.");
  const file = context.root.open(name);
  try {
    const bytes = toBytes(file, MAX_JSON_BYTES + 1);
    if (bytes.length > MAX_JSON_BYTES) fail(500, "Cron Manager storage exceeds its size limit.");
    return JSON.parse(toString(bytes));
  } finally { file.close(); }
}

function writeJson(context, name, value) {
  const content = JSON.stringify(value);
  if (toBytes(content).length > MAX_JSON_BYTES) fail(413, "Cron Manager storage exceeds its size limit.");
  const temporary = ".write-" + $security.randomString(32);
  let file;
  let committed = false;
  try {
    file = context.root.create(temporary);
    file.chmod(0o600);
    if (file.writeString(content) !== toBytes(content).length) fail(500, "Cron Manager could not finish writing its storage.");
    file.sync();
    file.close();
    file = null;
    context.root.rename(temporary, name);
    committed = true;
  } finally {
    try {
      if (file) file.close();
    } finally {
      if (!committed) {
        try { context.root.remove(temporary); } catch (_) {}
      }
    }
  }
}

function validateConfig(value) {
  if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || typeof value.expression !== "string" || !value.expression.trim() || value.expression.length > 128 || typeof value.code !== "string" || !value.code.trim() || toBytes(value.code).length > MAX_CODE_BYTES || value.code.indexOf("\0") !== -1 || typeof value.enabled !== "boolean") { fail(400, "Provide a name (up to 120 characters), cron expression, enabled state, and JavaScript code (up to 32 KiB)."); }
  return {
    name: value.name.trim(),
    expression: value.expression.trim(),
    code: value.code,
    enabled: value.enabled,
  };
}

function compileCode(code) {
  try { return new Function("$app", "job", "log", '"use strict";\n' + code); } catch (_) { fail(400, "The job contains invalid JavaScript. Use a synchronous function body without imports or top-level await."); }
}

function registry(context) {
  const state = readJson(context, "jobs.json", { version: 1, jobs: [] });
  if (state.version !== 1 || !Array.isArray(state.jobs) || state.jobs.length > MAX_JOBS) fail(500, "The saved jobs registry is invalid.");
  const ids = [];
  state.jobs = state.jobs.map(function (job) {
    if (!job || !ID_PATTERN.test(job.id) || !REVISION_PATTERN.test(job.revision) || ids.indexOf(job.id) !== -1 || typeof job.created !== "string" || typeof job.updated !== "string") fail(500, "The saved jobs registry is invalid.");
    ids.push(job.id);
    try {
      return Object.assign(validateConfig(job), {
        id: job.id,
        revision: job.revision,
        created: job.created,
        updated: job.updated,
      });
    } catch (_) { fail(500, "A saved job has invalid fields. Check jobs.json before continuing."); }
  });
  return state;
}

function history(context) {
  const state = readJson(context, "history.json", { version: 1, items: [] });
  if (state.version !== 1 || !Array.isArray(state.items) || state.items.length > HISTORY_LIMIT) fail(500, "The saved execution history is invalid.");
  let changed = false;
  state.items.forEach(function (run) {
    if (!run || !REVISION_PATTERN.test(run.id) || !ID_PATTERN.test(run.jobId) || !["running", "success", "error", "interrupted", "unconfirmed", "skipped"].includes(run.status) || !Array.isArray(run.logs) || run.logs.length > 10 || !run.logs.every(function (line) { return typeof line === "string" && line.length <= 256; })) { fail(500, "The saved execution history contains an invalid entry."); }
    if (run.status === "running") {
      if (run.bootId !== context.app.store().get(PREFIX + "bootId")) {
        run.status = "interrupted";
        run.error = "The instance restarted before the result was recorded. Effects may already have occurred; this job was not retried.";
        changed = true;
      } else if (context.app.store().get(runningKey(run.jobId)) !== run.id) {
        run.status = "unconfirmed";
        run.error = "The execution is no longer active, but its result could not be recorded. Effects may have occurred; check before running it again.";
        changed = true;
      }
    }
  });
  if (changed) saveHistory(context, state);
  return state;
}

function saveHistory(context, state) {
  while (state.items.length > HISTORY_LIMIT) {
    const index = state.items.findIndex(function (item) { return item.status !== "running"; });
    if (index === -1) fail(503, "The execution history has too many running jobs.");
    state.items.splice(index, 1);
  }
  writeJson(context, "history.json", state);
}

function findJob(state, id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) fail(404, "Cron job not found.");
  const job = state.jobs.find(function (item) { return item.id === id; });
  if (!job) fail(404, "Cron job not found.");
  return job;
}

function checkRevision(job, revision) {
  if (typeof revision !== "string" || revision !== job.revision) fail(409, "This job changed. Reopen it before making another change.");
}

function register(job) {
  const handler = "function () { require(__hooks + '/pb_cron_manager/api.js').execute($app, " + JSON.stringify(job.id) + ", " + JSON.stringify(job.revision) + "); }";
  try { cronAdd(nativeId(job.id), job.expression, handler); } catch (_) { fail(400, "Invalid cron expression. Use five numeric fields or a supported PocketBase cron macro."); }
  if (!job.enabled) cronRemove(nativeId(job.id));
}

function restoreRegistration(app, previous, id) {
  try {
    if (previous) register(previous);
    else cronRemove(nativeId(id));
  } catch (_) {
    cronRemove(nativeId(id));
    app.store().set(PREFIX + "registrationError." + id, "The schedule could not be restored. Edit and save this job again.");
  }
}

function commitJob(context, state, job, previous) {
  compileCode(job.code);
  register(job);
  if (previous) state.jobs[state.jobs.indexOf(previous)] = job;
  else state.jobs.push(job);
  try { writeJson(context, "jobs.json", state); } catch (err) {
    restoreRegistration(context.app, previous, job.id);
    throw err;
  }
  context.app.store().set(PREFIX + "registrationError." + job.id, "");
  return job;
}

function viewJob(app, job, records, includeCode) {
  const result = Object.assign({}, job, {
    nativeId: nativeId(job.id),
    running: !!app.store().get(runningKey(job.id)),
    lastRun: records.slice().reverse().find(function (run) { return run.jobId === job.id; }) || null,
    registrationError: app.store().get(PREFIX + "registrationError." + job.id) || "",
  });
  if (!includeCode) delete result.code;
  return result;
}

exports.initialize = function (app) {
  withStorage(app, function (context) {
    const state = registry(context);
    history(context);
    state.jobs.forEach(function (job) {
      try {
        compileCode(job.code);
        register(job);
        app.store().set(PREFIX + "registrationError." + job.id, "");
      } catch (_) {
        cronRemove(nativeId(job.id));
        app.store().set(PREFIX + "registrationError." + job.id, "This job could not be registered. Edit its expression or JavaScript and save it again.");
      }
    });
  });
};

exports.list = function (e) {
  const result = withStorage(e.app, function (context) {
    const state = registry(context);
    const records = history(context).items;
    return {
      jobs: state.jobs.map(function (job) { return viewJob(e.app, job, records, false); }).sort(function (a, b) { return a.name.localeCompare(b.name); }),
      limits: { maxJobs: MAX_JOBS, maxCodeBytes: MAX_CODE_BYTES, historyLimit: HISTORY_LIMIT },
      startupError: e.app.store().get(PREFIX + "startupError") || "",
    };
  });
  return e.json(200, result);
};

exports.read = function (e) {
  const result = withStorage(e.app, function (context) { return viewJob(e.app, findJob(registry(context), e.request.pathValue("id")), history(context).items, true); });
  return e.json(200, result);
};

exports.save = function (e, create) {
  const body = e.requestInfo().body;
  const values = validateConfig(body);
  compileCode(values.code);
  const result = withStorage(e.app, function (context) {
    const state = registry(context);
    const previous = create ? null : findJob(state, e.request.pathValue("id"));
    if (previous) {
      checkRevision(previous, body.revision);
      if (e.app.store().get(runningKey(previous.id))) fail(409, "Wait for the running job to finish before editing it.");
    } else if (state.jobs.length >= MAX_JOBS) fail(413, "Cron Manager supports up to 50 jobs.");
    if (state.jobs.some(function (job) { return job !== previous && job.name.toLowerCase() === values.name.toLowerCase(); })) fail(409, "A managed job already uses that name.");
    const now = new Date().toISOString();
    const job = Object.assign({}, values, {
      id: previous ? previous.id : $security.randomStringWithAlphabet(20, "abcdefghijklmnopqrstuvwxyz0123456789"),
      revision: $security.randomString(32),
      created: previous ? previous.created : now,
      updated: now,
    });
    const records = history(context).items;
    commitJob(context, state, job, previous);
    return viewJob(e.app, job, records, true);
  });
  return e.json(create ? 201 : 200, result);
};

exports.toggle = function (e) {
  const body = e.requestInfo().body;
  if (!body || typeof body.enabled !== "boolean") fail(400, "Provide the desired enabled state.");
  const result = withStorage(e.app, function (context) {
    const state = registry(context);
    const previous = findJob(state, e.request.pathValue("id"));
    checkRevision(previous, body.revision);
    const job = Object.assign({}, previous, { enabled: body.enabled, revision: $security.randomString(32), updated: new Date().toISOString() });
    const records = history(context).items;
    commitJob(context, state, job, previous);
    return viewJob(e.app, job, records, true);
  });
  return e.json(200, result);
};

exports.remove = function (e) {
  const body = e.requestInfo().body;
  if (!body || body.confirm !== true) fail(400, "Confirm the deletion of this job.");
  withStorage(e.app, function (context) {
    const state = registry(context);
    const job = findJob(state, e.request.pathValue("id"));
    checkRevision(job, body.revision);
    if (e.app.store().get(runningKey(job.id))) fail(409, "Wait for the running job to finish before deleting it.");
    state.jobs.splice(state.jobs.indexOf(job), 1);
    writeJson(context, "jobs.json", state);
    cronRemove(nativeId(job.id));
    e.app.store().remove(PREFIX + "registrationError." + job.id);
  });
  return e.json(200, { deleted: true });
};

exports.history = function (e) {
  const id = e.request.url.query().get("jobId");
  if (id && !ID_PATTERN.test(id)) fail(400, "Invalid job identifier.");
  const items = withStorage(e.app, function (context) { return history(context).items.filter(function (run) { return !id || run.jobId === id; }).reverse(); });
  return e.json(200, { items: items, limit: HISTORY_LIMIT });
};

function beginRun(app, id, revision, trigger, requestId) {
  return withStorage(app, function (context) {
    const records = history(context);
    if (requestId) {
      const existing = records.items.find(function (run) { return run.id === requestId; });
      if (existing) {
        if (existing.jobId !== id || existing.trigger !== "manual") fail(409, "This request identifier belongs to another execution.");
        return { run: existing, execute: false };
      }
    }
    const state = registry(context);
    const job = state.jobs.find(function (item) { return item.id === id; });
    if (trigger === "schedule" && (!job || !job.enabled || job.revision !== revision)) return null;
    if (!job) fail(404, "Cron job not found.");
    checkRevision(job, revision);
    const busy = !!app.store().get(runningKey(id));
    if (busy && trigger === "manual") fail(409, "This job is already running. Check its execution history.");
    const now = new Date().toISOString();
    const run = {
      id: requestId || $security.randomString(32),
      jobId: job.id,
      jobName: job.name,
      trigger: trigger,
      status: busy ? "skipped" : "running",
      started: now,
      finished: busy ? now : "",
      durationMs: busy ? 0 : null,
      logs: [],
      error: busy ? "The previous execution is still running." : "",
      bootId: app.store().get(PREFIX + "bootId"),
      revision: job.revision,
    };
    records.items.push(run);
    saveHistory(context, records);
    if (!busy) app.store().set(runningKey(id), run.id);
    return { run: run, job: job, execute: !busy };
  });
}

function executeRun(app, ticket) {
  if (!ticket || !ticket.execute) return ticket ? ticket.run : null;
  const run = ticket.run;
  const start = Date.now();
  try {
    const fn = compileCode(ticket.job.code);
    const log = function (message) {
      if (!["string", "number", "boolean"].includes(typeof message)) throw new Error("log() accepts a string, number, or boolean.");
      if (run.logs.length < 10) run.logs.push(String(message).slice(0, 256));
    };
    const job = Object.freeze({ id: ticket.job.id, name: ticket.job.name, expression: ticket.job.expression });
    const result = fn(app, job, log);
    if (result && typeof result.then === "function") throw new Error("Jobs must finish synchronously; returning a Promise is not supported.");
    run.status = "success";
  } catch (err) {
    run.status = "error";
    run.error = String(err && err.message ? err.message : "Job execution failed.").slice(0, 1000);
  } finally {
    run.finished = new Date().toISOString();
    run.durationMs = Math.max(0, Date.now() - start);
    try {
      withStorage(app, function (context) {
        const records = history(context);
        const index = records.items.findIndex(function (item) { return item.id === run.id && item.jobId === run.jobId; });
        if (index === -1) fail(500, "The execution history entry is missing. Check the saved history before retrying.");
        records.items[index] = run;
        saveHistory(context, records);
      });
    } finally { app.store().setFunc(runningKey(run.jobId), function (current) { return current === run.id ? "" : current; }); }
  }
  return run;
}

exports.execute = function (app, id, revision) { return executeRun(app, beginRun(app, id, revision, "schedule", null)); };

exports.run = function (e) {
  const body = e.requestInfo().body;
  if (!body || body.confirm !== true || typeof body.requestId !== "string" || !REVISION_PATTERN.test(body.requestId)) fail(400, "Confirm execution and provide a unique 32-character request identifier.");
  const ticket = beginRun(e.app, e.request.pathValue("id"), body.revision, "manual", body.requestId);
  return e.json(200, { run: executeRun(e.app, ticket) });
};

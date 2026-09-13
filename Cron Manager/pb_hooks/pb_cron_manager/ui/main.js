const cronApi = "/api/pb-cron-manager";
const cronSession = store({ draft: null });

function warnCronDraft(event) {
  if (cronSession.draft) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function retainCronDraft(draft) {
  cronSession.draft = draft;
  window.removeEventListener("beforeunload", warnCronDraft);
  if (draft) window.addEventListener("beforeunload", warnCronDraft);
}

app.pb.authStore.onChange((_, record) => {
  if (cronSession.draft && cronSession.draft.owner !== record?.id) retainCronDraft(null);
});

function cronStatus(status) {
  const styles = { success: "success", error: "danger", interrupted: "warning", unconfirmed: "warning", running: "warning" };
  const labels = { success: "Success", error: "Error", interrupted: "Interrupted", unconfirmed: "Unconfirmed", running: "Running", skipped: "Skipped" };
  return t.span({ className: "label " + (styles[status] || "") }, labels[status] || status);
}

function managedCrons(list, header, nativeRefresh) {
  const owner = app.pb.authStore.record?.id;
  const prefix = "cron_manager_" + app.utils.randomString();
  const modals = new Set();
  const requestKeys = new Set();
  const data = store({
    jobs: [],
    ready: false,
    loading: false,
    busy: "",
    search: "",
    error: "",
    actionError: "",
    startupError: "",
    limits: { maxJobs: 50, maxCodeBytes: 32768, historyLimit: 200 },
  });
  let alive = true;
  let epoch = 0;
  let interval;
  let unsubscribe;
  let listObserver;
  let listWatcher;
  const decoratedRows = new WeakMap();
  const extraRows = new Map();

  function current() { return alive && app.pb.authStore.isValid && app.pb.authStore.record?.id === owner; }

  async function request(path, options, key) {
    requestKeys.add(key);
    try { return await app.pb.send(cronApi + path, { ...options, requestKey: key }); } finally { requestKeys.delete(key); }
  }

  function errorMessage(error, mutation = false) {
    if (!error?.status && mutation) return "The request result is unknown. Check the jobs and execution history before trying again.";
    if (error?.status === 409) return error?.response?.message || "This job changed in another session. Reload its latest version before making changes.";
    if (error?.status === 423) return "Cron Manager is busy. Please try again shortly.";
    if (error?.status === 404) return "This job no longer exists. Refresh the list to continue.";
    return error?.response?.message || "Unable to complete the request.";
  }

  function report(error, message) {
    if (error?.isAbort || !current()) return;
    if (error?.status) app.checkApiError(error, false);
    if (current()) app.toasts.error(message);
  }

  async function refresh(notify = false) {
    if (!current() || document.hidden || data.loading) return;
    const version = epoch;
    data.loading = true;
    try {
      const result = await request("/jobs", { method: "GET" }, prefix + "_list");
      if (!current() || version !== epoch) return;
      const registrations = (jobs) => JSON.stringify(jobs.map((job) => [job.nativeId, job.enabled, job.expression]));
      const registrationsChanged = data.ready && registrations(result.jobs) !== registrations(data.jobs);
      if (JSON.stringify(result.jobs) !== JSON.stringify(data.jobs)) data.jobs = result.jobs;
      data.limits = result.limits;
      data.startupError = result.startupError || "";
      data.error = "";
      data.ready = true;
      if (registrationsChanged) nativeRefresh.click();
    } catch (error) {
      if (!current() || version !== epoch || error?.isAbort || (!notify && error?.status === 423)) return;
      data.error = errorMessage(error);
      if (notify || error?.status === 401) report(error, "Unable to refresh managed jobs.");
    } finally {
      data.loading = false;
      if (current() && version !== epoch) refresh();
    }
  }

  function mountModal(modal) {
    modals.add(modal);
    document.body.appendChild(modal);
    app.modals.open(modal);
  }

  function closeModal(modal) {
    modals.delete(modal);
    modal.remove();
  }

  async function mutate(job, action) {
    if (!current() || data.busy) return false;
    data.busy = job.id;
    ++epoch;
    try {
      const body = { revision: job.revision };
      if (action === "toggle") body.enabled = !job.enabled;
      else body.confirm = true;
      if (action === "run") body.requestId = app.utils.randomString(32);
      const result = await request(
        "/jobs/" + encodeURIComponent(job.id) + (action === "delete" ? "" : "/" + action),
        {
          method: action === "delete" ? "DELETE" : "POST",
          body,
        },
        prefix + "_mutation",
      );
      if (!current()) return;
      data.actionError = "";
      if (action === "run") {
        if (result.run.status === "success") app.toasts.success("Cron completed successfully.");
        else app.toasts.info("Check execution history for this cron's result.");
      } else { app.toasts.success(action === "delete" ? "Cron deleted." : job.enabled ? "Cron paused." : "Cron resumed."); }
    } catch (error) {
      if (!current() || error?.isAbort) return;
      data.actionError = errorMessage(error, true);
      report(error, "The cron action could not be confirmed.");
      return false;
    } finally {
      ++epoch;
      data.busy = "";
      refresh();
    }
  }

  function confirmAction(job, action) {
    if (!current() || data.busy) return;
    app.modals.confirm(
      t.div(null, t.h6(null, action === "delete" ? "Delete this cron?" : "Run this cron now?"), t.p(null, job.name), t.p({ className: "txt-sm txt-hint" }, action === "delete" ? "Its schedule and JavaScript will be removed. Existing execution history will remain available." : "The saved JavaScript will execute immediately, including when the schedule is paused.")),
      () => {
        if (action === "run") {
          mutate(job, action);
          return;
        }
        return mutate(job, action);
      },
      null,
      { yesButton: action === "delete" ? "Delete cron" : "Run now", noButton: "Cancel" },
    );
  }

  function openEditor(jobId = "", resume = false) {
    if (!current() || data.busy) return;
    const retained = cronSession.draft?.owner === owner ? cronSession.draft : null;
    if (retained && !resume) {
      app.modals.confirm(
        "Discard your unsaved cron changes?",
        () => {
          retainCronDraft(null);
          openEditor(jobId);
        },
        null,
        { yesButton: "Discard changes", noButton: "Keep editing" },
      );
      return;
    }

    const draft = resume ? retained : null;
    const uid = prefix + "_editor_" + app.utils.randomString();
    const defaults = { name: "", expression: "*/5 * * * *", code: "log('Job completed.');", enabled: false };
    const form = store({
      id: draft?.id || jobId,
      revision: draft?.revision || "",
      values: draft?.values || defaults,
      original: draft?.original || JSON.stringify(defaults),
      loading: !!jobId && !draft,
      saving: false,
      error: "",
      conflict: false,
      uncertain: !!draft?.uncertain,
      running: false,
      registrationError: "",
      get dirty() { return JSON.stringify(form.values) !== form.original; },
      get codeBytes() { return new TextEncoder().encode(form.values.code).length; },
      get canSave() { return !form.loading && !form.saving && !form.conflict && !form.uncertain && !form.running && !data.busy && (!form.id || form.dirty || !!form.registrationError) && form.codeBytes <= data.limits.maxCodeBytes; },
    });
    let mounted = true;
    let modal;
    let jobWatcher;

    function valid() { return current() && mounted && modal?.isConnected; }
    function remember() {
      if (!valid()) return;
      retainCronDraft(
        form.dirty || form.uncertain
          ? {
              owner,
              id: form.id,
              revision: form.revision,
              values: { ...form.values },
              original: form.original,
              uncertain: form.uncertain,
            }
          : null,
      );
    }
    function change(key, value) {
      form.values[key] = value;
      remember();
    }
    function accept(job) {
      form.id = job.id;
      form.revision = job.revision;
      form.running = !!job.running;
      form.registrationError = job.registrationError || "";
      form.values = { name: job.name, expression: job.expression, code: job.code, enabled: job.enabled };
      form.original = JSON.stringify(form.values);
      form.conflict = false;
      form.uncertain = false;
      form.error = "";
      remember();
    }
    function synchronizeJobState() {
      if (!valid() || !form.id || !form.revision || form.loading || form.saving || !data.ready) return;
      const job = data.jobs.find((item) => item.id === form.id);
      form.running = !!job?.running;
      form.registrationError = job?.registrationError || "";
      if (!job || job.revision !== form.revision) {
        form.conflict = true;
        form.error = job ? "This job changed in another session. Your editor content has been preserved. Copy it before reloading to merge changes." : "This job no longer exists. Your editor content has been preserved.";
      }
    }
    async function load() {
      if (!valid() || !form.id || form.saving) return;
      form.loading = true;
      ++epoch;
      try {
        const job = await request("/jobs/" + encodeURIComponent(form.id), { method: "GET" }, uid + "_read");
        if (valid()) accept(job);
      } catch (error) {
        if (valid() && !error?.isAbort) {
          form.error = errorMessage(error);
          form.conflict = true;
          report(error, "Unable to open this cron.");
        }
      } finally {
        form.loading = false;
        ++epoch;
        refresh();
      }
    }
    function resetForm() {
      if (!valid() || form.loading || form.saving || form.uncertain || form.running || data.busy) return;
      form.values = JSON.parse(form.original);
      if (!form.conflict) form.error = "";
      remember();
    }
    async function save(close = true) {
      if (!valid() || !form.canSave || !document.getElementById(uid)?.reportValidity()) return;
      form.saving = true;
      data.busy = form.id || uid;
      ++epoch;
      form.uncertain = true;
      remember();
      try {
        const body = { ...form.values };
        if (form.id) body.revision = form.revision;
        const job = await request(
          "/jobs" + (form.id ? "/" + encodeURIComponent(form.id) : ""),
          {
            method: form.id ? "PUT" : "POST",
            body,
          },
          uid + "_write",
        );
        if (!valid()) return;
        accept(job);
        app.toasts.success("Cron saved. The schedule is updated immediately.");
        if (close) app.modals.close(modal, true);
      } catch (error) {
        if (!valid() || error?.isAbort) return;
        form.uncertain = !error?.status;
        form.conflict = error?.status === 404;
        form.error = errorMessage(error, true);
        remember();
        report(error, "The cron could not be saved.");
      } finally {
        ++epoch;
        form.saving = false;
        data.busy = "";
        refresh();
      }
    }

    const presets = [
      { value: "* * * * *", label: "Every minute" },
      { value: "*/5 * * * *", label: "Every 5 minutes" },
      { value: "0 * * * *", label: "Every hour" },
      { value: "0 0 * * *", label: "Every day at 00:00" },
      { value: "0 0 * * 1", label: "Every Monday at 00:00" },
      { value: "0 0 1 * *", label: "First day of the month at 00:00" },
    ];

    modal = t.div(
      {
        className: "modal record-upsert-modal",
        onbeforeopen: () => {
          jobWatcher = watch(() => data.jobs, synchronizeJobState);
          if (form.loading) load();
          else synchronizeJobState();
        },
        onkeydown: (event) => {
          if ((event.ctrlKey || event.metaKey) && event.code === "KeyS" && app.modals.getTop() === modal) {
            event.preventDefault();
            save(false);
          }
        },
        onbeforeclose: (_, forced) => {
          if (forced) {
            remember();
            return;
          }
          if (form.saving) return false;
          if (form.dirty || form.uncertain) {
            app.modals.confirm(
              "Discard your unsaved cron changes?",
              () => {
                form.original = JSON.stringify(form.values);
                form.uncertain = false;
                retainCronDraft(null);
                app.modals.close(modal, true);
              },
              null,
              { yesButton: "Discard changes", noButton: "Keep editing" },
            );
            return false;
          }
        },
        onafterclose: () => closeModal(modal),
        onunmount: () => {
          remember();
          mounted = false;
          jobWatcher?.unwatch();
          app.pb.cancelRequest(uid + "_read");
          app.pb.cancelRequest(uid + "_write");
        },
      },
      t.header(
        { className: "modal-header" },
        t.div(
          { className: "grid" },
          t.div(
            { className: "col-12 flex" },
            t.h6(
              { className: "modal-title" },
              t.span(null, () => (form.id ? "Edit " : "Create ")),
              t.strong(null, "cron"),
            ),
          ),
        ),
      ),
      t.form(
        {
          id: uid,
          className: "modal-content",
          onsubmit: (event) => {
            event.preventDefault();
            save();
          },
        },
        t.div({ className: "txt-center", hidden: () => !form.loading }, t.span({ className: "loader" })),
        t.div({ className: "alert danger m-b-sm", hidden: () => !form.error }, () => form.error),
        t.div({ className: "alert warning m-b-sm", hidden: () => !form.registrationError }, () => form.registrationError),
        t.div({ className: "alert warning m-b-sm", hidden: () => !form.uncertain || form.saving }, "Saving is paused because the previous request was not acknowledged. Close this editor and inspect the jobs list before creating or saving another job."),
        t.div({ className: "alert warning m-b-sm", hidden: () => !form.running }, "This cron is running. Editing will become available when execution finishes."),
        t.button(
          {
            type: "button",
            className: "btn sm outline m-b-sm",
            hidden: () => !form.conflict || !form.id,
            disabled: () => form.loading || form.saving,
            onclick: () => app.modals.confirm("Reload this cron and discard the editor changes?", load, null, { yesButton: "Reload", noButton: "Cancel" }),
          },
          "Reload latest version",
        ),
        t.div(
          { className: "grid", inert: () => form.loading || form.saving || form.running },
          t.div({ className: "col-12" }, t.div({ className: "field" }, t.label({ htmlFor: uid + "_name" }, t.i({ className: app.fieldTypes.text.icon, ariaHidden: true }), t.span({ className: "txt" }, "Name")), t.input({ id: uid + "_name", name: "name", type: "text", required: true, maxLength: 120, spellcheck: false, value: () => form.values.name, oninput: (event) => change("name", event.target.value) }))),
          t.div(
            { className: "col-12" },
            t.div(
              { className: "fields" },
              t.div({ className: "field" }, t.label({ htmlFor: uid + "_expression" }, t.i({ className: "ri-time-line", ariaHidden: true }), t.span({ className: "txt" }, "Cron expression")), t.input({ id: uid + "_expression", name: "expression", type: "text", required: true, maxLength: 128, className: "txt-code", placeholder: "*/5 * * * *", spellcheck: false, autocomplete: "off", value: () => form.values.expression, oninput: (event) => change("expression", event.target.value) })),
              t.div({ className: "delimiter" }),
              t.div(
                { className: "field" },
                t.label({ htmlFor: uid + "_preset" }, t.i({ className: app.fieldTypes.select.icon, ariaHidden: true }), t.span({ className: "txt" }, "Schedule presets")),
                app.components.select({
                  id: uid + "_preset",
                  placeholder: "Choose a preset",
                  options: presets,
                  value: () => (presets.some((preset) => preset.value === form.values.expression) ? form.values.expression : ""),
                  onchange: (selected) => {
                    if (selected[0]) change("expression", selected[0].value);
                  },
                }),
              ),
            ),
            t.div({ className: "field-help" }, "Five fields: minute, hour, day of month, month, day of week. Uses the scheduler timezone (UTC by default). When both day fields are restricted, both must match."),
          ),
          t.div({ className: "col-12" }, t.div({ className: "field" }, t.input({ id: uid + "_enabled", name: "enabled", type: "checkbox", className: "switch", checked: () => form.values.enabled, onchange: (event) => change("enabled", event.target.checked) }), t.label({ htmlFor: uid + "_enabled" }, "Enable schedule"))),
          t.div({ className: "col-12" }, t.hr({ className: "m-0" })),
          t.div(
            { className: "col-12" },
            t.div({ className: "field" }, t.label({ htmlFor: uid + "_code" }, t.i({ className: app.fieldTypes.json.icon, ariaHidden: true }), t.span({ className: "txt" }, "JavaScript")), t.textarea({ id: uid + "_code", name: "code", className: "txt-code", required: true, style: "min-height: 300px; max-height: none;", spellcheck: false, autocorrect: false, autocomplete: "off", autocapitalize: "off", value: () => form.values.code, oninput: (event) => change("code", event.target.value) })),
            t.div(
              { className: "field-help" },
              "Use $app, job and log(message). __hooks and PocketBase JSVM globals are available. Code runs synchronously; async functions and promises are not supported. There is no hard execution timeout.",
              t.div({ className: "m-t-5" }, () => app.utils.formattedFileSize(form.codeBytes) + " / " + app.utils.formattedFileSize(data.limits.maxCodeBytes)),
            ),
          ),
        ),
      ),
      t.footer(
        { className: "modal-footer" },
        t.button({ type: "button", className: "btn transparent m-r-auto", disabled: () => form.saving, onclick: () => app.modals.close(modal) }, t.span({ className: "txt" }, "Close")),
        t.div(
          { className: "btns" },
          t.button(
            { "html-form": uid, type: "submit", className: () => "btn expanded-lg " + (form.saving ? "loading" : ""), disabled: () => !form.canSave },
            t.span({ className: "txt" }, () => (form.id ? "Save changes" : "Create")),
          ),
          t.button({ type: "button", className: "btn p-5", title: "Save options", disabled: () => !form.canSave, "html-popovertarget": uid + "_save_options" }, t.i({ className: "ri-arrow-up-s-line", ariaHidden: true })),
          t.div(
            { id: uid + "_save_options", className: "dropdown nowrap", popover: "auto" },
            t.button(
              {
                type: "button",
                className: "dropdown-item",
                disabled: () => !form.canSave,
                onclick: (event) => {
                  event.target.closest(".dropdown").hidePopover();
                  save(false);
                },
              },
              t.span({ className: "txt" }, "Save and continue"),
              t.small({ className: "txt-hint" }, "(Ctrl+S)"),
            ),
            t.hr(),
            t.button(
              {
                type: "button",
                className: "dropdown-item",
                disabled: () => !form.canSave,
                onclick: (event) => {
                  event.target.closest(".dropdown").hidePopover();
                  resetForm();
                },
              },
              t.span({ className: "txt" }, "Reset form"),
            ),
          ),
        ),
      ),
    );
    mountModal(modal);
  }

  function openHistory(job = null) {
    if (!current()) return;
    const uid = prefix + "_history_" + app.utils.randomString();
    const history = store({ items: [], loading: false, ready: false, error: "", limit: data.limits.historyLimit });
    const openRuns = new Set();
    let mounted = true;
    let timer;
    let modal;

    async function load(notify = false) {
      if (!current() || !mounted || !modal?.isConnected || history.loading || document.hidden) return;
      history.loading = true;
      try {
        const result = await request("/history", { method: "GET", query: job ? { jobId: job.id } : {} }, uid);
        if (!current() || !mounted || !modal.isConnected) return;
        if (JSON.stringify(result.items) !== JSON.stringify(history.items)) history.items = result.items;
        history.limit = result.limit;
        history.ready = true;
        history.error = "";
      } catch (error) {
        if (!current() || !mounted || !modal.isConnected || error?.isAbort || (!notify && error?.status === 423)) return;
        history.error = errorMessage(error);
        if (notify || error?.status === 401) report(error, "Unable to refresh execution history.");
      } finally { history.loading = false; }
    }
    function visible() {
      if (!document.hidden) load();
    }

    modal = t.div(
      {
        className: "modal record-upsert-modal",
        onbeforeopen: () => {
          load();
          timer = setInterval(load, 5000);
          document.addEventListener("visibilitychange", visible);
        },
        onafterclose: () => closeModal(modal),
        onunmount: () => {
          mounted = false;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", visible);
          app.pb.cancelRequest(uid);
        },
      },
      t.header({ className: "modal-header" }, t.h6({ className: "modal-title" }, "Execution history"), app.components.refreshButton({ className: "btn sm circle transparent secondary m-l-auto", disabled: () => history.loading, onclick: () => load(true) })),
      t.div(
        { className: "modal-content" },
        t.div(
          { className: "block m-b-base" },
          t.p({ className: "txt-sm txt-hint" }, job ? job.name : "All managed jobs, including deleted jobs."),
          t.p({ className: "txt-sm txt-hint" }, () => "Up to " + history.limit + " recent executions are retained globally. Times are displayed in your local timezone."),
        ),
        t.div({ className: "alert danger m-b-sm", hidden: () => !history.error }, () => history.error),
        t.div({ className: "txt-center", hidden: () => history.ready || !history.loading }, t.span({ className: "loader" })),
        t.div({ className: "list", hidden: () => !history.ready || !!history.items.length }, t.div({ className: "list-item" }, t.div({ className: "content txt-hint" }, "No executions found."))),
        t.div({ className: "block" }, () =>
          history.items.map((run) =>
            t.details(
              {
                rid: JSON.stringify(run),
                className: "accordion",
                name: uid,
                open: openRuns.has(run.id),
                ontoggle: (event) => {
                  if (event.target.open) openRuns.add(run.id);
                  else openRuns.delete(run.id);
                },
              },
              t.summary({ className: "flex-wrap" }, t.span({ className: "txt txt-ellipsis", title: run.jobName }, run.jobName), t.div({ className: "flex flex-wrap gap-10 m-l-auto" }, t.small({ className: "txt-hint" }, app.utils.toLocalDatetime(run.started)), cronStatus(run.status))),
              t.div(
                { className: "grid sm" },
                t.div(
                  { className: "col-12" },
                  t.table(
                    { className: "responsive-table" },
                    t.tbody(
                      null,
                      [
                        ["Trigger", run.trigger === "manual" ? "Manual" : "Scheduler / native trigger"],
                        ["Duration", run.status === "running" ? "In progress" : run.durationMs == null ? "Unknown" : run.durationMs + " ms"],
                        ["Finished", run.finished ? app.utils.toLocalDatetime(run.finished) : run.status === "running" ? "Pending" : "Unknown"],
                        ["Job ID", run.jobId],
                      ].map(([label, value]) => t.tr(null, t.th({ scope: "row", className: "min-width" }, label), t.td(null, value))),
                    ),
                  ),
                ),
                t.div({ className: "col-12", hidden: !run.error }, t.div({ className: "field" }, t.label({ htmlFor: uid + "_error_" + run.id }, "Error"), t.textarea({ id: uid + "_error_" + run.id, className: "txt-code", readOnly: true, value: run.error || "", rows: 3 }))),
                t.div({ className: "col-12" }, t.div({ className: "field" }, t.label({ htmlFor: uid + "_logs_" + run.id }, "Logs"), t.textarea({ id: uid + "_logs_" + run.id, className: "txt-code", readOnly: true, value: run.logs.join("\n"), placeholder: "No log messages.", rows: 6 }))),
              ),
            ),
          ),
        ),
      ),
      t.footer({ className: "modal-footer" }, t.button({ type: "button", className: "btn transparent", onclick: () => app.modals.close(modal) }, "Close")),
    );
    mountModal(modal);
  }

  function actionButton(label, icon, disabled, onclick) {
    return t.button(
      {
        type: "button",
        className: "btn sm circle secondary transparent",
        ariaLabel: app.attrs.tooltip(label),
        disabled,
        onclick,
      },
      t.i({ className: icon, ariaHidden: true }),
    );
  }

  function decorateRow(row, id) {
    if (decoratedRows.has(row)) return;
    const content = row.querySelector(":scope > .content");
    const actions = row.querySelector(":scope > .actions");
    const identifier = content?.querySelector(":scope > .cron-id");
    if (!content || !actions || !identifier) return;
    const nativeId = identifier.textContent;
    const job = () => data.jobs.find((item) => item.id === id);
    const status = () => {
      const item = job();
      if (!item) return "";
      return item.registrationError ? "Registration error" : item.running ? "Running" : item.enabled ? "" : "Paused";
    };

    decoratedRows.set(row, nativeId);
    identifier.replaceWith(
      t.span(
        {
          "html-data-cron-manager-ui": "",
          className: "cron-id txt-code txt-ellipsis",
          title: () => [job()?.name, nativeId].filter(Boolean).join("\n"),
        },
        () => job()?.name || "",
      ),
    );
    content.appendChild(
      t.span(
        {
          "html-data-cron-manager-ui": "",
          className: "label sm txt-ellipsis",
          hidden: () => !status(),
          title: () => job()?.registrationError || status(),
        },
        status,
      ),
    );

    actions.dataset.cronManagerUi = "";
    actions.replaceChildren(
      actionButton(
        "Edit",
        "ri-edit-line",
        () => !!data.busy || !job() || !!job()?.running,
        () => {
          if (job()) openEditor(id);
        },
      ),
      actionButton(
        () => (job()?.enabled ? "Pause schedule" : "Resume schedule"),
        () => (job()?.enabled ? "ri-pause-line" : "ri-play-line"),
        () => !!data.busy || !job(),
        () => {
          if (job()) mutate(job(), "toggle");
        },
      ),
      actionButton(
        "Run now",
        "ri-play-large-line",
        () => !!data.busy || !job() || !!job()?.running,
        () => {
          if (job()) confirmAction(job(), "run");
        },
      ),
      actionButton(
        () => {
          const run = job()?.lastRun;
          return "Execution history" + (run ? "\nLast run: " + app.utils.toLocalDatetime(run.started) + " (" + run.status + ")" : "");
        },
        "ri-history-line",
        () => !job(),
        () => {
          if (job()) openHistory(job());
        },
      ),
      actionButton(
        "Delete",
        "ri-delete-bin-line",
        () => !!data.busy || !job() || !!job()?.running,
        () => {
          if (job()) confirmAction(job(), "delete");
        },
      ),
    );
  }

  function syncList() {
    if (!current() || !list.isConnected) return;
    listObserver?.disconnect();
    try {
      const jobs = new Map(data.jobs.map((job) => [job.nativeId, job]));
      const nativeIds = new Set();
      const rows = Array.from(list.querySelectorAll(":scope > .list-item"));
      for (const row of rows) {
        if (row.hasAttribute("data-cron-manager-extra")) continue;
        const id = decoratedRows.get(row) || row.querySelector(":scope > .content > .cron-id")?.textContent;
        if (!id) continue;
        nativeIds.add(id);
        if (jobs.has(id)) decorateRow(row, jobs.get(id).id);
      }

      for (const [id, row] of extraRows) {
        if (!jobs.has(id) || nativeIds.has(id) || row.parentElement !== list) {
          row.remove();
          extraRows.delete(id);
        }
      }
      for (const [id, job] of jobs) {
        if (nativeIds.has(id) || extraRows.has(id)) continue;
        const row = t.div(
          { className: "list-item", "html-data-cron-manager-extra": id },
          t.div({ className: "content" }, t.span({ className: "cron-id txt-code txt-ellipsis", title: id }, id)),
          t.small({ className: "cron-expression txt-hint txt-nowrap txt-code" }, () => data.jobs.find((item) => item.nativeId === id)?.expression || ""),
          t.nav({ className: "actions" }),
        );
        decorateRow(row, job.id);
        extraRows.set(id, row);
      }
      for (const row of extraRows.values()) {
        if (row.parentElement !== list) list.insertBefore(row, newCronRow);
      }

      const search = data.search.trim().toLowerCase();
      let visibleRows = 0;
      const emptyRows = [];
      let hasSkeleton = false;
      for (const row of list.querySelectorAll(":scope > .list-item")) {
        if (row === newCronRow) continue;
        const id = decoratedRows.get(row) || row.querySelector(":scope > .content > .cron-id")?.textContent;
        if (!id) {
          if (row.querySelector(".skeleton-loader")) hasSkeleton = true;
          else emptyRows.push(row);
          continue;
        }
        const actions = row.querySelector(":scope > .actions");
        if (actions) {
          const actionCount = String(actions.childElementCount);
          if (!actions.classList.contains("autohide") || row.style.getPropertyValue("--cron-manager-action-count") !== actionCount) {
            const expression = row.querySelector(":scope > .cron-expression");
            actions.style.transition = "none";
            if (expression) expression.style.transition = "none";
            actions.classList.add("autohide");
            row.style.setProperty("--cron-manager-action-count", actionCount);
            row.getBoundingClientRect();
            actions.style.removeProperty("transition");
            if (expression) expression.style.removeProperty("transition");
          }
        }
        const job = jobs.get(id);
        const text = [id, job?.name, job?.expression, row.querySelector(":scope > .cron-expression")?.textContent].filter(Boolean).join(" ").toLowerCase();
        const hidden = (decoratedRows.has(row) && !job) || !text.includes(search);
        if (row.hidden !== hidden) row.hidden = hidden;
        if (!hidden) ++visibleRows;
      }
      for (const row of emptyRows) {
        const hidden = visibleRows > 0 || hasSkeleton;
        if (row.hidden !== hidden) row.hidden = hidden;
        const content = row.querySelector(":scope > .content");
        const message = search ? "No matching cron jobs." : "No cron jobs found.";
        if (content && content.textContent !== message) content.textContent = message;
      }
    } finally {
      if (current())
        listObserver?.observe(list, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["hidden"],
        });
    }
  }

  const historyButton = actionButton("Execution history", "ri-history-line", false, () => openHistory());
  const newCronRow = t.div({ className: "list-item", "html-data-cron-manager-ui": "" }, t.button({ type: "button", className: "btn secondary block", disabled: () => !data.ready || !!data.busy || data.jobs.length >= data.limits.maxJobs, onclick: () => openEditor() }, t.i({ className: "ri-add-line", ariaHidden: true }), t.span({ className: "txt" }, "New cron")));

  function nativeRefreshClicked() { refresh(true); }
  function visible() {
    if (!document.hidden) refresh();
  }
  function cleanup() {
    if (!alive) return;
    alive = false;
    ++epoch;
    clearInterval(interval);
    listObserver?.disconnect();
    listWatcher?.unwatch();
    unsubscribe?.();
    nativeRefresh.removeEventListener("click", nativeRefreshClicked);
    document.removeEventListener("visibilitychange", visible);
    requestKeys.forEach((key) => app.pb.cancelRequest(key));
    modals.forEach((modal) => app.modals.close(modal, true));
    extraRows.forEach((row) => row.remove());
    extraRows.clear();
    historyButton.remove();
    newCronRow.remove();
  }

  return t.div(
    {
      className: "m-b-sm",
      pbEvent: "cronManager",
      onmount: () => {
        header.classList.add("flex-wrap");
        header.appendChild(historyButton);
        list.appendChild(newCronRow);
        nativeRefresh.addEventListener("click", nativeRefreshClicked);
        listObserver = new MutationObserver((changes) => {
          const ownUi = "[data-cron-manager-ui], [data-cron-manager-extra]";
          if (
            changes.some((change) => {
              const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
              return !target?.closest(ownUi);
            })
          )
            syncList();
        });
        listWatcher = watch(() => [data.jobs, data.search, data.ready], syncList);
        refresh();
        interval = setInterval(refresh, 5000);
        document.addEventListener("visibilitychange", visible);
        unsubscribe = app.pb.authStore.onChange((_, record) => {
          if (record?.id !== owner) cleanup();
        });
      },
      onunmount: cleanup,
    },
    t.style(
      null,
      `
      @media (hover: hover) {
        [data-pb="cronManager"] + .list > .list-item > .cron-expression {
          transform: translateX(0);
          transition: transform var(--animationSpeed);
        }
        [data-pb="cronManager"] + .list > .list-item:has(> .actions.autohide:not([hidden])):not(:hover, :focus-visible, :focus-within, :active) > .cron-expression {
          /* Native actions use square buttons, 10px gaps and a -5px right margin. */
          transform: translateX(calc((var(--smBtnHeight) + 10px) * var(--cron-manager-action-count) - 5px));
        }
        [data-pb="cronManager"] + .list > .list-item > .actions.autohide {
          pointer-events: none;
        }
        [data-pb="cronManager"] + .list > .list-item:is(:hover, :focus-visible, :focus-within, :active) > .actions.autohide {
          pointer-events: auto;
        }
      }
    `,
    ),
    t.div(
      { className: "alert danger m-b-sm", hidden: () => !data.startupError },
      t.p({ className: "txt-bold" }, "Some managed jobs could not be registered"),
      t.p(null, () => data.startupError),
    ),
    t.div({ className: "alert warning m-b-sm", hidden: () => !data.error }, () => data.error),
    t.div(
      { className: "alert warning m-b-sm", hidden: () => !data.actionError },
      t.p(null, () => data.actionError),
      t.button(
        {
          type: "button",
          className: "btn sm secondary",
          onclick: () => { data.actionError = ""; },
        },
        "Dismiss",
      ),
    ),
    t.p({ className: "txt-sm txt-hint", hidden: () => !data.busy }, "An action is in progress. Running jobs may continue if you leave this page."),
    t.button({ type: "button", className: "btn sm outline m-b-sm", hidden: () => cronSession.draft?.owner !== owner, disabled: () => !!data.busy, onclick: () => openEditor("", true) }, "Resume unsaved cron"),
    t.div(
      { className: "field m-b-sm" },
      t.label({ htmlFor: prefix + "_search" }, "Search cron jobs"),
      t.input({
        id: prefix + "_search",
        type: "search",
        placeholder: "Name, ID or expression...",
        value: () => data.search,
        oninput: (event) => { data.search = event.target.value; },
      }),
    ),
  );
}

document.addEventListener("mount:pageCronsSettings", (event) => {
  const page = event.detail;
  const content = page.querySelector(":scope > .page-content");
  const registeredJobs = content?.querySelector(":scope > .wrapper");
  const list = registeredJobs?.querySelector(":scope > .list");
  const header = registeredJobs?.querySelector(":scope > .flex");
  const refreshButton = header?.querySelector("button");
  if (!list || !header || !refreshButton || content.querySelector('[data-pb="cronManager"]')) return;
  header.querySelector(".txt-lg").textContent = "App cron jobs";
  const help = registeredJobs.querySelector(":scope > .txt-sm");
  if (help?.firstChild?.nodeType === 3) help.firstChild.textContent = "Jobs can be created here or registered programmatically with ";
  registeredJobs.insertBefore(managedCrons(list, header, refreshButton), list);
});

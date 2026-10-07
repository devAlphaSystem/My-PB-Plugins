const pageSessions = new WeakMap();
const listControllers = new WeakMap();
const pageSize = 40;
const highlightDuration = 1500;

function attachCounter(page) {
  let session = pageSessions.get(page);
  if (!session) {
    const original = page.querySelector(":scope > .page-content > .page-footer > .total-count");
    if (!original) return;
    session = { state: store({ total: 0, status: "connecting" }), controller: null };
    pageSessions.set(page, session);
    const labels = { connecting: "Connecting", syncing: "Syncing", live: "Live", offline: "Offline", error: "Sync error", polling: "Auto" };
    original.replaceWith(t.span({ className: "total-count", "html-data-pb-live-total": "" }, "Total: ", () => session.state.total, t.span({ className: "txt-hint m-l-10", textContent: () => labels[session.state.status] || "Live" })));
  }
  for (const el of page.querySelectorAll("[data-pb-live-list]")) {
    const controller = listControllers.get(el);
    if (controller) {
      session.controller = controller;
      controller.session = session;
      session.state.total = controller.data.total;
      session.state.status = controller.data.status;
    }
  }
}

document.addEventListener("mount:pageCollections", (e) =>
  queueMicrotask(() => {
    if (e.detail.isConnected) attachCounter(e.detail);
  }),
);
document.addEventListener("unmount:pageCollections", (e) => {
  const session = pageSessions.get(e.detail);
  if (session) session.controller = null;
  pageSessions.delete(e.detail);
});

app.components.recordsList = function (propsArg = {}) {
  const uniqueId = "collections_live_" + app.utils.randomString();
  const props = store({
    collection: {},
    filter: "",
    sort: "",
    reset: undefined,
    suggestReset: false,
    rid: undefined,
    id: undefined,
    hidden: undefined,
    className: "",
    onchange: () => {},
    onselect: () => {},
    onSuggestResetChange: () => {},
  });
  const watchers = app.utils.extendStore(props, propsArg);
  const data = store({
    records: {},
    ids: [],
    selected: {},
    columns: {},
    highlights: {},
    limit: pageSize,
    total: 0,
    hasMore: false,
    status: "connecting",
    deleting: false,
    get busy() {
      return data.status === "connecting" || data.status === "syncing";
    },
    get selectedCount() {
      return Object.keys(data.selected).length;
    },
    get allSelected() {
      return !!data.ids.length && data.ids.every((id) => !!data.selected[id]);
    },
  });
  const rowCache = new Map();
  const rowLifecycle = new WeakSet();
  const highlightTimers = new Map();
  let hasSnapshot = false;
  let loadedLimit = pageSize;
  let alive = false;
  let element;
  let sync;
  const controller = { data, session: null };

  function records() {
    return data.ids.map((id) => data.records[id]).filter(Boolean);
  }

  function query() {
    const collection = props.collection;
    const fields = collection?.fields || [];
    let sort = props.sort || undefined;
    const match = sort?.match(/^([\+\-])?(\w+)$/);
    const sortField = match && fields.find((f) => !f.hidden && f.name === match[2]);
    if (!sortField) sort = collection?.type !== "view" ? "-@rowid" : undefined;
    else if (sortField.type === "relation") {
      const related = app.store.collections.find((c) => c.id === sortField.collectionId);
      const presentable = related?.fields.filter((f) => f.presentable).sort((a, b) => (a.type === "file" ? 1 : 0) - (b.type === "file" ? 1 : 0)) || [];
      sort = presentable.map((f) => (match[1] || "") + match[2] + "." + f.name).join(",");
      if (!sort) {
        const fallback = app.utils.fallbackPresentableProps.find((name) => related?.fields.some((f) => f.name === name));
        sort = fallback ? (match[1] || "") + match[2] + "." + fallback : undefined;
      }
    }
    return {
      collectionId: collection?.id,
      name: collection?.name,
      type: collection?.type,
      filter: app.utils.normalizeSearchFilter(
        props.filter,
        fields.filter((f) => !f.hidden).map((f) => f.name),
      ),
      sort,
      expand:
        fields
          .filter((f) => !f.hidden && f.type === "relation")
          .map((f) => f.name)
          .join(",") || undefined,
      limit: data.limit,
    };
  }

  function patchRecord(target, source, eager = true) {
    let changed = false;
    const collection = app.store.collections.find((c) => c.id === source.collectionId);
    for (const field of collection?.fields || []) {
      if (field.type === "relation" && JSON.stringify(target[field.name]) !== JSON.stringify(source[field.name])) {
        if (target.expand && field.name in target.expand) {
          delete target.expand[field.name];
          changed = true;
        }
      }
    }
    for (const key of Object.keys(target)) {
      if (key !== "expand" && !(key in source)) {
        delete target[key];
        changed = true;
      }
    }
    for (const key of Object.keys(source)) {
      if (key === "expand") continue;
      if (JSON.stringify(target[key]) !== JSON.stringify(source[key])) {
        target[key] = source[key] === undefined ? undefined : JSON.parse(JSON.stringify(source[key]));
        changed = true;
      }
    }
    for (const field of collection?.fields || []) {
      if (eager && !field.hidden && field.type === "relation" && target.expand && field.name in target.expand && !(field.name in (source.expand || {}))) {
        delete target.expand[field.name];
        changed = true;
      }
    }
    for (const [field, value] of Object.entries(source.expand || {})) {
      target.expand = target.expand || {};
      const existing = target.expand[field];
      if (value && !Array.isArray(value) && existing?.id === value.id) {
        changed = patchRecord(existing, value, false) || changed;
      } else if (Array.isArray(value) && Array.isArray(existing) && value.length === existing.length && value.every((record, index) => record.id === existing[index]?.id)) {
        for (let index = 0; index < value.length; index++) changed = patchRecord(existing[index], value[index], false) || changed;
      } else if (JSON.stringify(existing) !== JSON.stringify(value)) {
        target.expand[field] = JSON.parse(JSON.stringify(value));
        changed = true;
      }
    }
    return changed;
  }

  function clearHighlight(id) {
    clearTimeout(highlightTimers.get(id));
    highlightTimers.delete(id);
    delete data.highlights[id];
  }

  function highlightRecord(id, kind) {
    clearTimeout(highlightTimers.get(id));
    data.highlights[id] = kind;
    highlightTimers.set(
      id,
      setTimeout(() => clearHighlight(id), highlightDuration),
    );
  }

  function applySnapshot(snapshot) {
    if (!alive) return;
    const visible = new Set(snapshot.ids);
    const observedRange = new Set(snapshot.ids.slice(0, loadedLimit));
    const anchor = element && Array.from(element.querySelectorAll("tbody tr[data-record-id]")).find((row) => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top);
    const anchorId = anchor?.dataset.recordId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : 0;
    for (const record of snapshot.records) {
      if (data.records[record.id]) {
        const changed = patchRecord(data.records[record.id], record);
        if (hasSnapshot && changed) highlightRecord(record.id, "updated");
      } else {
        data.records[record.id] = JSON.parse(JSON.stringify(record));
        if (hasSnapshot && observedRange.has(record.id)) highlightRecord(record.id, "entered");
      }
    }
    for (const id of Object.keys(data.records)) {
      if (!visible.has(id)) {
        clearHighlight(id);
        delete data.records[id];
        rowCache.delete(id);
      }
    }
    const selected = {};
    for (const id of Object.keys(data.selected)) {
      if (visible.has(id) && data.records[id]) selected[id] = data.records[id];
    }
    if (JSON.stringify(Object.keys(selected)) !== JSON.stringify(Object.keys(data.selected))) data.selected = selected;
    if (JSON.stringify(data.ids) !== JSON.stringify(snapshot.ids)) data.ids = snapshot.ids.slice();
    if (snapshot.total !== undefined) data.total = snapshot.total;
    if (snapshot.hasMore !== undefined) data.hasMore = snapshot.hasMore;
    loadedLimit = snapshot.limit;
    hasSnapshot = true;
    props.onSuggestResetChange?.(false);
    if (controller.session?.controller === controller) controller.session.state.total = data.total;
    if (anchorId && visible.has(anchorId))
      queueMicrotask(() => {
        if (!alive) return;
        const row = rowCache.get(anchorId)?.element;
        if (row?.isConnected) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchorOffset;
      });
  }

  const syncOptions = {
    getQuery: query,
    getRecords: records,
    applySnapshot,
    setStatus: (status) => {
      if (!alive) return;
      data.status = status;
      if (controller.session?.controller === controller) controller.session.state.status = status;
    },
    onError: (error, notify = true) => {
      if (!alive || error?.isAbort) return;
      app.checkApiError(error, notify);
    },
  };

  function startSync() {
    if (!alive || sync) return;
    syncOptions.setStatus("connecting");
    import(app.pb.buildURL("/_/extensions/pb-collections-live/sync.js"))
      .then(({ createSync }) => {
        if (!alive || sync) return;
        sync = createSync(syncOptions);
        sync.start();
      })
      .catch((error) => {
        syncOptions.setStatus("error");
        syncOptions.onError(error);
      });
  }

  function hidden(field) {
    return typeof data.columns[field.id] === "undefined" ? !!field.hidden : !data.columns[field.id];
  }

  function fields() {
    return (props.collection?.fields || []).filter((f) => app.fieldTypes[f.type]?.view && !(props.collection?.name === "_superusers" && f.name === "verified"));
  }

  function preserveRowLifecycle(node) {
    if (!rowLifecycle.has(node)) {
      rowLifecycle.add(node);
      const mount = node.onmount;
      const unmount = node.onunmount;
      if (mount)
        node.onmount = () => {
          if (!node.isConnected) return;
          mount.call(node, node);
          preserveRowLifecycle(node);
        };
      if (unmount)
        node.onunmount = () => {
          if (node.isConnected) preserveRowLifecycle(node);
          else unmount.call(node, node);
        };
    }
    for (const child of node.childNodes || []) preserveRowLifecycle(child);
    return node;
  }

  function selectAll(checked) {
    const selected = {};
    if (checked) for (const record of records()) selected[record.id] = record;
    data.selected = selected;
  }

  function selectRecord(record, event) {
    const selected = Object.assign({}, data.selected);
    if (event.target.__shiftKey) {
      event.target.__shiftKey = false;
      app.utils.bulkSelectRange(records(), selected, record, event.target.checked);
    }
    if (event.target.checked) selected[record.id] = record;
    else delete selected[record.id];
    data.selected = selected;
  }

  function downloadSelected() {
    const selected = JSON.parse(JSON.stringify(Object.values(data.selected)));
    if (!selected.length) return;
    for (const record of selected) delete record.expand;
    app.utils.downloadJSON(selected.length === 1 ? selected[0] : selected, selected.length === 1 ? props.collection.name + "_" + selected[0].id + ".json" : selected.length + "_" + props.collection.name + "_records.json");
  }

  async function deleteSelected() {
    if (data.deleting) return;
    const collectionId = props.collection.id;
    const ids = Object.keys(data.selected);
    data.deleting = true;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        await Promise.all(ids.slice(i, i + 100).map((id) => app.pb.collection(collectionId).delete(id)));
      }
      if (alive && props.collection.id === collectionId) selectAll(false);
      app.toasts.success(`Successfully deleted ${ids.length} ${ids.length === 1 ? "record" : "records"}.`);
    } catch (error) {
      app.checkApiError(error);
    } finally {
      data.deleting = false;
      if (alive && props.collection.id === collectionId) sync?.refresh();
    }
  }

  function columnsButton() {
    const dropdown = t.div({ className: "dropdown sm nowrap records-list-columns-dropdown gap-0", popover: "auto" }, () =>
      fields()
        .filter((field) => !field.primaryKey && !(props.collection?.type === "auth" && field.name === "tokenKey"))
        .map((field) =>
          t.div(
            { rid: field.id, className: "dropdown-item" },
            t.div(
              { className: "field" },
              t.input({
                id: uniqueId + "_column_" + field.id,
                type: "checkbox",
                className: "switch sm",
                checked: () => !hidden(field),
                onchange: (e) => {
                  data.columns[field.id] = e.target.checked;
                },
              }),
              t.label({ htmlFor: uniqueId + "_column_" + field.id }, () => field.name),
            ),
          ),
        ),
    );
    return t.button({ type: "button", title: "Toggle columns", className: "btn sm secondary transparent circle", popoverTargetElement: dropdown }, t.i({ className: "ri-more-2-line", ariaHidden: true }), dropdown);
  }

  function row(id) {
    const schema = props.collection.id + "/" + JSON.stringify(props.collection.fields);
    const cached = rowCache.get(id);
    if (cached?.schema === schema) return cached.element;
    const record = data.records[id];
    const result = t.tr(
      {
        rid: props.collection.id + "/" + id + "/" + schema,
        "html-data-record-id": id,
        "html-data-pb-live-highlight": () => data.highlights[id],
        tabIndex: 0,
        className: "handle",
        onclick: (e) => {
          e.preventDefault();
          props.onselect(record);
        },
        onkeypress: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onselect(record);
          }
        },
      },
      t.td(
        { className: "col-bulk-select", onclick: (e) => e.stopPropagation(), onkeypress: (e) => e.stopPropagation() },
        t.div(
          { className: "field" },
          t.input({ id: uniqueId + id, type: "checkbox", checked: () => !!data.selected[id], onchange: (e) => selectRecord(record, e) }),
          t.label({
            htmlFor: uniqueId + id,
            onclick: (e) => {
              e.preventDefault();
              const input = document.getElementById(e.target.htmlFor);
              if (input) {
                input.__shiftKey = e.shiftKey;
                input.click();
              }
            },
          }),
        ),
      ),
      ...fields().map((field) =>
        t.td(
          { "html-data-name": field.name, hidden: () => hidden(field), className: "col-field-type-" + field.type + " col-field-name-" + field.name },
          app.fieldTypes[field.type].view({
            short: true,
            get record() {
              return record;
            },
            get field() {
              return field;
            },
          }),
        ),
      ),
      t.td({ className: "col-meta" }, t.i({ className: "ri-arrow-right-line m-r-10", ariaHidden: true })),
    );
    preserveRowLifecycle(result);
    rowCache.set(id, { schema, element: result });
    return result;
  }

  element = t.div(
    {
      pbEvent: "recordsList",
      "html-data-pb-live-list": "",
      rid: props.rid,
      id: () => props.id,
      hidden: () => props.hidden,
      className: () => "page-table-wrapper " + props.className,
      onmount: (el) => {
        if (alive) return;
        alive = true;
        listControllers.set(el, controller);
        const page = el.closest('[data-pb="pageCollections"]');
        if (page) attachCounter(page);
        watchers.push(
          watch(
            () => JSON.stringify([props.collection?.id, props.collection?.name, props.collection?.type, props.collection?.fields, props.filter, props.sort]),
            (_, old) => {
              if (old === undefined) return;
              hasSnapshot = false;
              for (const id of highlightTimers.keys()) clearHighlight(id);
              const changedCollection = records().some((record) => record.collectionId !== props.collection?.id);
              if (changedCollection) {
                data.ids = [];
                data.records = {};
                data.selected = {};
                rowCache.clear();
              }
              data.limit = pageSize;
              sync?.queryChanged();
            },
          ),
        );
        watchers.push(
          watch(
            () => props.collection?.id,
            (id) => {
              data.columns = app.utils.getLocalHistory(app.consts.COLUMNS_STORAGE_PREFIX + id, {});
            },
          ),
        );
        watchers.push(
          watch(
            () => JSON.stringify(data.columns),
            (_, old) => {
              if (old !== undefined && props.collection?.id) app.utils.saveLocalHistory(app.consts.COLUMNS_STORAGE_PREFIX + props.collection.id, data.columns);
            },
          ),
        );
        let resetInitialized = false;
        watchers.push(
          watch(
            () => props.reset,
            (value, old) => {
              if (resetInitialized && value !== old) sync ? sync.refresh() : startSync();
              resetInitialized = true;
            },
          ),
        );
        startSync();
      },
      onunmount: (el) => {
        if (!alive) return;
        alive = false;
        sync?.dispose();
        for (const id of highlightTimers.keys()) clearHighlight(id);
        watchers.forEach((w) => w?.unwatch());
        if (controller.session?.controller === controller) controller.session.controller = null;
        controller.session = null;
        listControllers.delete(el);
        rowCache.clear();
      },
    },
    t.style({
      textContent: `
      [data-pb-live-list] > .records-table > tbody > tr[data-pb-live-highlight] {
        --pbCollectionsLiveHighlightColor: var(--surfaceInfoColor);
        background-color: var(--pbCollectionsLiveHighlightColor);
      }
      [data-pb-live-list] > .records-table > tbody > tr[data-pb-live-highlight="entered"] {
        --pbCollectionsLiveHighlightColor: var(--surfaceSuccessColor);
      }
      [data-pb-live-list] > .records-table > tbody > tr[data-pb-live-highlight] > td {
        background-color: var(--pbCollectionsLiveHighlightColor);
      }
    `,
    }),
    t.table(
      { pbEvent: "recordsListTable", className: () => "records-table responsive-table" + (data.ids.length > pageSize ? " optimize" : "") },
      t.thead(
        { className: "sticky" },
        t.tr(
          null,
          t.th({ className: "col-bulk-select" }, t.div({ className: "field" }, t.input({ id: "all_" + uniqueId, type: "checkbox", disabled: () => !data.ids.length, checked: () => data.allSelected, onchange: (e) => selectAll(e.target.checked) }), t.label({ htmlFor: "all_" + uniqueId }))),
          () =>
            fields().map((field) =>
              t.th(
                {
                  rid: field.id + "/" + field.name,
                  hidden: () => hidden(field),
                  className: () => "sort-handle col-field-type-" + field.type + " col-field-name-" + field.name + (props.sort === "-" + field.name ? " desc" : props.sort === field.name || props.sort === "+" + field.name ? " asc" : ""),
                  onclick: () => {
                    props.sort = props.sort === "-" + field.name ? field.name : "-" + field.name;
                    props.onchange(props.filter, props.sort);
                  },
                },
                t.div({ className: "inline-flex gap-5" }, t.i({ ariaHidden: true, className: field.primaryKey ? "ri-key-line" : app.fieldTypes[field.type]?.icon || app.utils.fallbackFieldIcon }), t.span({ className: "txt", textContent: () => field.name })),
              ),
            ),
          t.th({ className: "col-meta" }, columnsButton()),
        ),
      ),
      t.tbody(
        null,
        () =>
          data.ids.length
            ? data.ids.map(row)
            : t.tr(
                { rid: "empty" },
                t.td(
                  { colSpan: 99, style: "height:59px" },
                  t.div(
                    { className: "sticky-content txt-center txt-hint" },
                    t.span({ className: "skeleton-loader", hidden: () => !data.busy }),
                    t.div({ className: "txt-bold", hidden: () => data.busy }, "No records found."),
                    t.button({ type: "button", className: "btn secondary expanded-lg m-t-10", hidden: () => data.busy || !!props.filter || props.collection?.type === "view", onclick: () => app.modals.openRecordUpsert(props.collection) }, t.i({ className: "ri-add-line", ariaHidden: true }), t.span({ className: "txt" }, "New record")),
                    t.button(
                      {
                        type: "button",
                        className: "btn secondary expanded-lg m-t-10",
                        hidden: () => data.busy || !props.filter,
                        onclick: () => {
                          props.filter = "";
                          props.onchange(props.filter, props.sort);
                        },
                      },
                      "Clear search",
                    ),
                  ),
                ),
              ),
        t.tr(
          { hidden: () => !data.hasMore },
          t.td(
            { colSpan: 99 },
            t.button(
              {
                type: "button",
                className: () => "btn lg secondary load-more-btn" + (data.busy ? " transparent loading" : ""),
                disabled: () => data.busy,
                onclick: () => {
                  data.limit += pageSize;
                  sync?.loadMore();
                },
              },
              "Load more",
            ),
          ),
        ),
      ),
    ),
    t.div(
      { className: "bulkbar-wrapper" },
      t.div(
        { className: "bulkbar records-bulkbar", hidden: () => !data.selectedCount },
        t.span(
          { className: "txt" },
          "Selected ",
          t.strong(null, () => data.selectedCount),
          () => (data.selectedCount === 1 ? " record" : " records"),
        ),
        t.button({ type: "button", className: "btn sm secondary pill m-r-auto", onclick: () => selectAll(false) }, "Reset"),
        t.button({ type: "button", className: "btn sm pill outline danger", hidden: () => props.collection?.type === "view", disabled: () => data.deleting, onclick: () => app.modals.confirm("Do you really want to delete the selected records?", deleteSelected) }, t.i({ className: "ri-delete-bin-line", ariaHidden: true }), t.span({ className: "txt" }, "Delete")),
        t.button({ type: "button", className: "btn sm secondary pill", onclick: downloadSelected }, t.i({ className: "ri-download-line", ariaHidden: true }), t.span({ className: "txt" }, "JSON")),
      ),
    ),
  );
  return element;
};

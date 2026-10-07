const eventDelay = 120;
const pollDelay = 10000;
const maxPageSize = 1000;
const recordBatchSize = 64;

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordChanged(previous, next) {
  return Object.keys(next).some((key) => key !== "expand" && !valuesEqual(previous[key], next[key]));
}

function queryKey(query, includeLimit = true) {
  return JSON.stringify([query.collectionId, query.name, query.type, query.filter || "", query.sort || "", query.expand || "", includeLimit ? query.limit : null]);
}

function relationSources(query) {
  const collections = app.store?.collections || [];
  const source = collections.find((collection) => collection.id === query.collectionId);
  const found = new Map();
  const visited = new Set([query.collectionId]);
  const pending = source ? [{ collection: source, depth: 0 }] : [];

  while (pending.length) {
    const { collection, depth } = pending.shift();
    if (depth >= 6) continue;
    for (const field of collection.fields || []) {
      if (field.type !== "relation" || visited.has(field.collectionId)) continue;
      visited.add(field.collectionId);
      const related = collections.find((candidate) => candidate.id === field.collectionId);
      if (!related) continue;
      found.set(related.id, related);
      pending.push({ collection: related, depth: depth + 1 });
    }
  }

  if ((query.filter || "").includes("@collection.")) {
    for (const collection of collections) {
      if (collection.id !== query.collectionId) found.set(collection.id, collection);
    }
  }
  return [...found.values()];
}

function dependsOn(record, collectionId, recordId, visited = new Set()) {
  if (!record || visited.has(record)) return false;
  visited.add(record);
  if (record.collectionId === collectionId && record.id === recordId) return true;
  const collection = app.store?.collections?.find((candidate) => candidate.id === record.collectionId);
  for (const field of collection?.fields || []) {
    if (field.type !== "relation" || field.collectionId !== collectionId) continue;
    const value = record[field.name];
    if (value === recordId || (Array.isArray(value) && value.includes(recordId))) return true;
  }
  for (const expanded of Object.values(record.expand || {})) {
    const children = Array.isArray(expanded) ? expanded : [expanded];
    if (children.some((child) => dependsOn(child, collectionId, recordId, visited))) return true;
  }
  return false;
}

export function createSync({ getQuery, getRecords, applySnapshot, setStatus, onError }) {
  const prefix = "collections_live_" + app.utils.randomString();
  const requestKeys = new Set();
  let alive = true;
  let started = false;
  let generation = 0;
  let requestSequence = 0;
  let timer;
  let pollTimer;
  let running = false;
  let initialized = false;
  let failedSources = 0;
  let sources = [];
  let relatedIds = new Set();
  let viewDependencies = false;
  let queue = emptyQueue();

  function emptyQueue() {
    return { full: false, structural: false, notify: false, ids: new Set(), waiters: [] };
  }

  function readQuery() {
    const query = getQuery();
    if (!query?.collectionId) return null;
    const limit = Number(query.limit);
    return { ...query, limit: Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 40) };
  }

  function current(version, key) {
    if (!alive || !started || version !== generation) return false;
    const query = readQuery();
    return !!query && queryKey(query) === key;
  }

  function currentSource(version, key) {
    const query = readQuery();
    return alive && started && version === generation && !!query && queryKey(query, false) === key;
  }

  function status(value) {
    if (alive) setStatus?.(value);
  }

  function report(error, notify = true) {
    if (!alive || error?.isAbort) return;
    status(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    onError?.(error, notify);
  }

  function cancelRequests() {
    for (const key of requestKeys) app.pb.cancelRequest(key);
    requestKeys.clear();
  }

  async function list(query, page, perPage, options) {
    const key = prefix + "_" + ++requestSequence;
    requestKeys.add(key);
    try {
      return await app.pb.collection(query.collectionId).getList(page, perPage, { ...options, requestKey: key });
    } finally {
      requestKeys.delete(key);
    }
  }

  async function readWindow(query, version, key) {
    const wanted = query.limit + 1;
    const pageSize = Math.min(maxPageSize, wanted);
    const ids = [];
    let total;
    for (let page = 1; ids.length < wanted; page++) {
      const result = await list(query, page, pageSize, {
        filter: query.filter || undefined,
        sort: query.sort || undefined,
        fields: "id",
        skipTotal: page !== 1,
      });
      if (!current(version, key)) return null;
      if (page === 1) total = result.totalItems;
      ids.push(...result.items.map((record) => record.id));
      if (result.items.length < pageSize) break;
    }
    return {
      ids: [...new Set(ids.slice(0, query.limit))],
      total: total >= 0 ? total : undefined,
      hasMore: ids.length > query.limit || total > query.limit,
      limit: query.limit,
    };
  }

  async function readRecords(query, ids, version, key) {
    const records = [];
    for (let offset = 0; offset < ids.length; offset += recordBatchSize) {
      const batch = ids.slice(offset, offset + recordBatchSize);
      const filter = batch.map((id) => app.pb.filter("id = {:id}", { id })).join(" || ");
      const result = await list(query, 1, batch.length, {
        filter,
        expand: query.expand || undefined,
        skipTotal: true,
      });
      if (!current(version, key)) return null;
      records.push(...result.items);
    }
    return records;
  }

  function hasQueuedWork() {
    return queue.full || queue.structural || queue.ids.size > 0 || queue.waiters.length > 0;
  }

  function schedule(delay = eventDelay) {
    if (!alive || !started) return;
    if (timer !== undefined) {
      if (delay > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, delay);
  }

  function enqueue({ full = false, structural = false, ids = [], notify = false } = {}, immediate = false) {
    if (!alive || !started || !readQuery()) return Promise.resolve(false);
    queue.full ||= full;
    queue.structural ||= structural || full;
    queue.notify ||= notify;
    for (const id of ids) queue.ids.add(id);
    const promise = new Promise((resolve) => queue.waiters.push(resolve));
    schedule(immediate ? 0 : eventDelay);
    return promise;
  }

  async function flush() {
    if (!alive || running || !hasQueuedWork()) return;
    const query = readQuery();
    if (!query) return;
    const version = generation;
    const key = queryKey(query);
    const job = queue;
    queue = emptyQueue();
    running = true;
    status("syncing");
    let applied = false;
    try {
      let snapshot;
      const previous = getRecords();
      if (job.structural) {
        snapshot = await readWindow(query, version, key);
        if (!snapshot) return;
      } else {
        snapshot = { ids: previous.map((record) => record.id), limit: query.limit };
      }
      const existing = new Set(previous.map((record) => record.id));
      const requested = snapshot.ids.filter((id) => job.full || job.ids.has(id) || !existing.has(id));
      let records = await readRecords(query, requested, version, key);
      if (!records || !current(version, key)) return;
      let missing = requested.filter((id) => !records.some((record) => record.id === id));

      if (missing.length) {
        snapshot = await readWindow(query, version, key);
        if (!snapshot) return;
        const available = new Map(records.map((record) => [record.id, record]));
        const additional = snapshot.ids.filter((id) => !available.has(id) && (job.full || job.ids.has(id) || !existing.has(id)));
        const fetched = await readRecords(query, additional, version, key);
        if (!fetched || !current(version, key)) return;
        for (const record of fetched) available.set(record.id, record);
        missing = additional.filter((id) => !available.has(id));
        snapshot.ids = snapshot.ids.filter((id) => !missing.includes(id));
        records = [...available.values()].filter((record) => snapshot.ids.includes(record.id));
        if (missing.length) enqueue({ structural: true });
      }

      if (!current(version, key)) return;
      applySnapshot({ ...snapshot, records });
      initialized = true;
      applied = true;
      status(failedSources ? "error" : query.type === "view" || viewDependencies ? "polling" : app.pb.realtime.isConnected === false ? "offline" : "live");
    } catch (error) {
      if (current(version, key)) report(error, job.notify);
    } finally {
      running = false;
      for (const resolve of job.waiters) resolve(applied);
      if (hasQueuedWork()) schedule(0);
    }
  }

  function immutableOrder(sort) {
    return !sort || sort.split(",").every((part) => ["@rowid", "id"].includes(part.replace(/^[+-]/, "")));
  }

  function orderChanged(query, previous, next) {
    for (const part of (query.sort || "").split(",")) {
      const field = part.replace(/^[+-]/, "");
      if (!field || field === "@rowid" || field === "id") continue;
      if (field === "@random") return true;
      const top = field.split(".")[0];
      if (!(top in next) || !valuesEqual(previous[top], next[top])) return true;
    }
    return false;
  }

  function notify(action, record) {
    const query = readQuery();
    if (!alive || !started || !query || !record?.id || !["create", "update", "delete"].includes(action)) return;
    const sameCollection = record.collectionId === query.collectionId || record.collectionName === query.name;
    if (sameCollection) {
      const previous = getRecords().find((candidate) => candidate.id === record.id);
      const affected = getRecords().filter((candidate) => candidate.id !== record.id && dependsOn(candidate, query.collectionId, record.id));
      if (action === "update" && previous && !affected.length && !recordChanged(previous, record)) return;
      if (action === "update" && !previous && !affected.length && !query.filter && immutableOrder(query.sort)) return;
      const structural = action !== "update" || !!query.filter || (query.sort || "").includes(".") || (!previous && !immutableOrder(query.sort)) || (!!previous && orderChanged(query, previous, record));
      enqueue({ structural, ids: [...(action === "delete" ? [] : [record.id]), ...affected.map((candidate) => candidate.id)] });
      return;
    }

    const source = app.store?.collections?.find((candidate) => [candidate.id, candidate.name].includes(record.collectionId) || candidate.name === record.collectionName);
    const sourceId = source?.id || record.collectionId;
    if (!relatedIds.has(sourceId)) return;
    const affected = getRecords().filter((candidate) => dependsOn(candidate, sourceId, record.id));
    const structural = !!query.filter || (query.sort || "").includes(".");
    if (structural || affected.length) enqueue({ structural, ids: affected.map((candidate) => candidate.id) });
  }

  const documentEvents = {
    "record:create": (event) => notify("create", event.detail),
    "record:update": (event) => notify("update", event.detail),
    "record:delete": (event) => notify("delete", event.detail),
    visibilitychange: () => {
      if (!document.hidden) enqueue({ full: true }, true);
    },
  };
  const windowEvents = {
    offline: () => status("offline"),
    online: () => enqueue({ full: true }, true),
  };

  async function closeSources() {
    const closing = sources;
    sources = [];
    await Promise.all(
      closing.map(async (source) => {
        source.closed = true;
        try {
          if (source.unsubscribe) await source.unsubscribe();
          else await app.pb.realtime.unsubscribe(source.topic);
        } catch (error) {
          if (alive && !error?.isAbort) onError?.(error, false);
        }
      }),
    );
  }

  async function subscribe(topic, callback, version, key) {
    const source = { topic, closed: false, unsubscribe: null };
    sources.push(source);
    try {
      const unsubscribe = await app.pb.realtime.subscribe(topic, callback);
      source.unsubscribe = unsubscribe;
      if (source.closed || !currentSource(version, key)) await unsubscribe();
    } catch (error) {
      try {
        await app.pb.realtime.unsubscribe(topic);
      } catch {}
      if (currentSource(version, key)) {
        failedSources++;
        report(error);
      }
    }
  }

  async function openSources(query, version, key) {
    const related = relationSources(query);
    relatedIds = new Set(related.map((collection) => collection.id));
    viewDependencies = related.some((collection) => collection.type === "view");
    if (query.type === "view") return;
    const marker = encodeURIComponent(JSON.stringify({ query: { pb_collections_live: prefix + "_" + version } }));
    const connected = "PB_CONNECT?options=" + marker;
    const subscriptions = [
      subscribe(
        connected,
        () => {
          if (currentSource(version, key) && initialized) enqueue({ full: true }, true);
        },
        version,
        key,
      ),
    ];
    const ids = new Set([query.collectionId, ...related.filter((collection) => collection.type !== "view").map((collection) => collection.id)]);
    for (const id of ids) {
      const topic = id + "/*?options=" + marker;
      subscriptions.push(
        subscribe(
          topic,
          (event) => {
            if (currentSource(version, key)) notify(event.action, event.record);
          },
          version,
          key,
        ),
      );
    }
    await Promise.all(subscriptions);
  }

  function clearQueue() {
    clearTimeout(timer);
    timer = undefined;
    for (const resolve of queue.waiters) resolve(false);
    queue = emptyQueue();
  }

  async function queryChanged() {
    if (!alive || !started) return false;
    const version = ++generation;
    initialized = false;
    failedSources = 0;
    clearQueue();
    cancelRequests();
    await closeSources();
    const query = readQuery();
    if (!query || !alive || version !== generation) return false;
    const key = queryKey(query);
    status(query.type === "view" ? "polling" : "connecting");
    await openSources(query, version, queryKey(query, false));
    if (!current(version, key)) return false;
    return enqueue({ full: true, notify: true }, true);
  }

  async function start() {
    if (!alive) return false;
    if (started) return refresh();
    started = true;
    for (const [event, handler] of Object.entries(documentEvents)) document.addEventListener(event, handler);
    if (typeof window !== "undefined") {
      for (const [event, handler] of Object.entries(windowEvents)) window.addEventListener(event, handler);
    }
    pollTimer = setInterval(() => {
      if (!alive || document.hidden || running || hasQueuedWork()) return;
      const query = readQuery();
      if (!query) return;
      if (query.type === "view" || viewDependencies) enqueue({ full: true }, true);
      else if (!failedSources && app.pb.realtime.isConnected === false) status("offline");
    }, pollDelay);
    return queryChanged();
  }

  function refresh() {
    if (failedSources) return queryChanged();
    return enqueue({ full: true, notify: true }, true);
  }

  function loadMore() {
    return enqueue({ structural: true, notify: true }, true);
  }

  async function dispose() {
    if (!alive) return;
    alive = false;
    generation++;
    clearQueue();
    clearInterval(pollTimer);
    cancelRequests();
    for (const [event, handler] of Object.entries(documentEvents)) document.removeEventListener(event, handler);
    if (typeof window !== "undefined") {
      for (const [event, handler] of Object.entries(windowEvents)) window.removeEventListener(event, handler);
    }
    await closeSources();
  }

  return { start, refresh, queryChanged, loadMore, notify, dispose };
}

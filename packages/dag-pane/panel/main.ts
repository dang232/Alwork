// DAG side-pane guest entry (project-ide todo 13).
//
// Third-party SDK guest (`omo-dag-pane`, never the builtin prefix): an
// iframe panel plus `connectHost` that renders bridge snapshots as run
// graphs with node details, and steers/cancels the live session through
// its own host-spawned service (`serviceRequest`), which wraps the
// adapter-A bridge from todo 6. Hosted by the Electron desktop shell's
// webview only — never web, VS Code, or mobile.
//
// Styling follows the host theme: kit primitives plus `var(--oc-*)`
// tokens, no literal colors. Strings come from the package dictionaries
// keyed by `ready.locale`.
import { connectHost, type HostClient, type JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { mountBadge } from '@openchamber/sdk/ui';
import { mountBanner } from '@openchamber/sdk/ui';
import { mountButton } from '@openchamber/sdk/ui';
import { mountEmpty } from '@openchamber/sdk/ui';
import { mountSelect } from '@openchamber/sdk/ui';
import { mountSpinner } from '@openchamber/sdk/ui';
import { mountTextField } from '@openchamber/sdk/ui';

import { isWireRecord, parseSnapshotDoc, wireString, type DagRunView, type DagNodeView, type DagRunWave } from './dag-view.ts';
import { stringsFor, type DagPaneStrings } from './strings.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 132;
const NODE_HEIGHT = 46;
const COLUMN_GAP = 44;
const ROW_GAP = 18;
const POLL_MS = 4000;
const WRAPPER_STORAGE_KEY = 'wrapperEntry';

type ServiceAnswer = { status: number; body: JsonValue | undefined };

const stateTone = (state: string): 'success' | 'info' | 'neutral' | 'error' => {
  if (state === 'completed') {
    return 'success';
  }
  if (state === 'running') {
    return 'info';
  }
  if (state === 'failed' || state === 'error') {
    return 'error';
  }
  return 'neutral';
};

const stateColorVar = (state: string): string => {
  if (state === 'completed') {
    return 'var(--oc-success)';
  }
  if (state === 'running') {
    return 'var(--oc-primary)';
  }
  if (state === 'failed' || state === 'error') {
    return 'var(--oc-error)';
  }
  return 'var(--oc-muted)';
};

const el = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
};

const text = (tag: string, className: string, value: string): HTMLElement => {
  const node = el(tag, className);
  node.textContent = value;
  return node;
};

const svgEl = (tag: string, attrs: Record<string, string>): SVGElement => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
};

/** Columns of node ids: waves when the run carries them, else one column in node order. */
const columnsForRun = (run: DagRunView): string[][] => {
  const known = new Set(run.nodes.map((node) => node.id));
  const waves: DagRunWave[] = run.waves;
  if (waves.length > 0) {
    const columns = [...waves]
      .sort((a, b) => a.index - b.index)
      .map((wave) => wave.nodeIds.filter((id) => known.has(id)))
      .filter((column) => column.length > 0);
    if (columns.length > 0) {
      const placed = new Set(columns.flat());
      const missing = run.nodes.map((node) => node.id).filter((id) => !placed.has(id));
      if (missing.length > 0) {
        columns.push(missing);
      }
      return columns;
    }
  }
  return [run.nodes.map((node) => node.id)];
};

export const startDagPane = (host: HostClient, doc: Document = document): void => {
  const root = doc.getElementById('app');
  if (!root) {
    return;
  }
  let strings: DagPaneStrings = stringsFor('en');
  let sessionId: string | null = null;
  let sessions: string[] = [];
  let connected = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let selectedNodeId: string | null = null;
  let wrapperEntry = '';

  const header = el('header', 'dag-header');
  const titleNode = text('h1', 'dag-title', '');
  const controls = el('div', 'dag-controls');
  const sessionSlot = el('div', 'dag-session-slot');
  const refreshSlot = el('div', 'dag-refresh-slot');
  controls.append(sessionSlot, refreshSlot);
  header.append(titleNode, controls);

  const noticeSlot = el('div', 'dag-notice-slot');
  const content = el('main', 'dag-content');
  const steerBar = el('div', 'dag-steer-bar');
  const steerFieldSlot = el('div', 'dag-steer-field');
  const steerButtons = el('div', 'dag-steer-buttons');
  steerBar.append(steerFieldSlot, steerButtons);
  const wrapperRow = el('div', 'dag-wrapper-row');
  const wrapperFieldSlot = el('div', 'dag-wrapper-field');
  wrapperRow.append(wrapperFieldSlot);

  root.append(header, noticeSlot, content, steerBar, wrapperRow);

  let selectHandle: ReturnType<typeof mountSelect> | null = null;
  let wrapperField: ReturnType<typeof mountTextField> | null = null;
  let sectionHandles: { dispose(): void }[] = [];
  let noticeHandle: { dispose(): void } | null = null;

  const clearSection = (): void => {
    for (const handle of sectionHandles.splice(0)) {
      handle.dispose();
    }
    content.replaceChildren();
  };

  const showNotice = (kind: 'banner' | 'none', options?: { tone?: 'info' | 'warning' | 'error' | 'success'; title?: string; body?: string }): void => {
    noticeHandle?.dispose();
    noticeHandle = null;
    noticeSlot.replaceChildren();
    if (kind === 'banner' && options?.title) {
      noticeHandle = mountBanner(noticeSlot, {
        tone: options.tone ?? 'info',
        title: options.title,
        body: options.body,
      });
    }
  };

  const serviceCall = async (
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: JsonValue,
  ): Promise<ServiceAnswer> => {
    const answer = await host.serviceRequest({
      method,
      path,
      query,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: JsonValue | undefined;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      parsed = undefined;
    }
    return { status: answer.status, body: parsed };
  };

  const paintSessions = (): void => {
    selectHandle?.dispose();
    selectHandle = null;
    sessionSlot.replaceChildren();
    if (sessions.length === 0) {
      return;
    }
    selectHandle = mountSelect(sessionSlot, {
      label: strings.session,
      value: sessionId,
      options: sessions.map((id) => ({ id, label: id })),
      onChange: (id) => {
        sessionId = id;
        selectedNodeId = null;
        void refresh();
      },
    });
  };

  const paintGraph = (run: DagRunView): void => {
    const byId = new Map(run.nodes.map((node) => [node.id, node]));
    const columns = columnsForRun(run);
    const rows = Math.max(...columns.map((column) => column.length));
    const width = columns.length * (NODE_WIDTH + COLUMN_GAP) + COLUMN_GAP;
    const height = rows * (NODE_HEIGHT + ROW_GAP) + ROW_GAP;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': run.name,
    });
    svg.classList.add('dag-graph');
    const positions = new Map<string, { x: number; y: number }>();
    columns.forEach((column, columnIndex) => {
      column.forEach((id, rowIndex) => {
        positions.set(id, {
          x: COLUMN_GAP + columnIndex * (NODE_WIDTH + COLUMN_GAP),
          y: ROW_GAP + rowIndex * (NODE_HEIGHT + ROW_GAP),
        });
      });
    });
    for (const edge of run.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) {
        continue;
      }
      svg.append(svgEl('line', {
        x1: String(from.x + NODE_WIDTH),
        y1: String(from.y + NODE_HEIGHT / 2),
        x2: String(to.x),
        y2: String(to.y + NODE_HEIGHT / 2),
        stroke: 'var(--oc-border)',
        'stroke-width': '2',
      }));
    }
    for (const [id, position] of positions) {
      const node = byId.get(id);
      if (!node) {
        continue;
      }
      const group = svgEl('g', { class: 'dag-node', 'data-node-id': id, tabindex: '0', role: 'button' });
      const selected = selectedNodeId === id;
      group.append(svgEl('rect', {
        x: String(position.x),
        y: String(position.y),
        width: String(NODE_WIDTH),
        height: String(NODE_HEIGHT),
        rx: 'var(--oc-radius)',
        fill: selected ? 'var(--oc-selection)' : 'var(--oc-elevated)',
        stroke: selected ? 'var(--oc-primary)' : 'var(--oc-border)',
        'stroke-width': selected ? '2.5' : '1.5',
      }));
      group.append(svgEl('circle', {
        cx: String(position.x + 14),
        cy: String(position.y + NODE_HEIGHT / 2),
        r: '5',
        fill: stateColorVar(node.state),
      }));
      const label = svgEl('text', {
        x: String(position.x + 26),
        y: String(position.y + 20),
        fill: selected ? 'var(--oc-selection-fg)' : 'var(--oc-fg)',
        'font-size': '12',
        'font-weight': '600',
      });
      label.textContent = node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label;
      const state = svgEl('text', {
        x: String(position.x + 26),
        y: String(position.y + 35),
        fill: selected ? 'var(--oc-selection-fg)' : 'var(--oc-muted)',
        'font-size': '10',
      });
      state.textContent = node.state;
      group.append(label, state);
      const pick = (): void => {
        selectedNodeId = id;
        paintContent(currentRuns);
      };
      group.addEventListener('click', pick);
      group.addEventListener('keydown', (event) => {
        if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          pick();
        }
      });
      svg.append(group);
    }
    content.append(svg);
  };

  let currentRuns: DagRunView[] = [];

  const paintDetails = (run: DagRunView): void => {
    const node: DagNodeView | undefined = run.nodes.find((entry) => entry.id === (selectedNodeId ?? run.nodes.find((entry_) => entry_.state === 'running')?.id ?? run.nodes[0]?.id));
    if (!node) {
      return;
    }
    if (!selectedNodeId) {
      selectedNodeId = node.id;
    }
    const card = el('section', 'dag-details');
    card.append(text('h2', 'dag-details-title', strings.details));
    const rows: [string, string][] = [
      ['id', node.id],
      ['label', node.label],
      ['state', node.state],
      ['attempt', String(node.attempt)],
      ['prompt', node.prompt],
      ['depends_on', node.dependsOn.join(', ') || '—'],
      ['started', node.startedAt ?? '—'],
      ['completed', node.completedAt ?? '—'],
    ];
    const list = el('dl', 'dag-details-list');
    for (const [term, value] of rows) {
      list.append(text('dt', 'dag-details-term', term), text('dd', 'dag-details-value', value));
    }
    card.append(list);
    content.append(card);
  };

  const paintContent = (runs: DagRunView[]): void => {
    clearSection();
    currentRuns = runs;
    if (runs.length === 0) {
      sectionHandles.push(mountEmpty(content, { title: strings.emptyTitle, body: strings.emptyBody }));
      return;
    }
    for (const run of runs) {
      const head = el('div', 'dag-run-head');
      head.append(text('h2', 'dag-run-name', run.name));
      const badgeSlot = el('span', 'dag-run-badge');
      head.append(badgeSlot);
      content.append(head);
      const badge = mountBadge(badgeSlot, { label: run.status, tone: stateTone(run.status) });
      sectionHandles.push(badge);
      const counts = text(
        'p',
        'dag-run-counts',
        `pending ${run.counts.pending} · running ${run.counts.running} · completed ${run.counts.completed}`,
      );
      content.append(counts);
      paintGraph(run);
      paintDetails(run);
    }
  };

  const refresh = async (): Promise<void> => {
    clearSection();
    if (!sessionId) {
      sectionHandles.push(mountSpinner(content, {}));
      let statusAnswer: ServiceAnswer;
      try {
        statusAnswer = await serviceCall('GET', '/status');
      } catch {
        sectionHandles.push(mountEmpty(content, { title: strings.emptyTitle, body: strings.emptyBody }));
        return;
      }
      const body = isWireRecord(statusAnswer.body) ? statusAnswer.body : {};
      const listed = Array.isArray(body.sessions)
        ? body.sessions.map((entry) => wireString(entry)).filter((entry): entry is string => entry !== null)
        : [];
      sessions = listed;
      sessionId = listed[0] ?? null;
      paintSessions();
    }
    if (!sessionId) {
      clearSection();
      sectionHandles.push(mountEmpty(content, { title: strings.emptyTitle, body: strings.emptyBody }));
      return;
    }
    let answer: ServiceAnswer;
    try {
      answer = await serviceCall('GET', '/snapshot', { sessionId });
    } catch {
      clearSection();
      sectionHandles.push(mountBanner(content, {
        tone: 'error',
        title: strings.errorTitle,
        body: undefined,
        action: { label: strings.retry, onClick: () => void refresh() },
      }));
      return;
    }
    if (answer.status === 404) {
      clearSection();
      sectionHandles.push(mountEmpty(content, { title: strings.emptyTitle, body: strings.emptyBody }));
      return;
    }
    const outcome = parseSnapshotDoc(answer.body);
    if (!outcome.ok) {
      clearSection();
      sectionHandles.push(mountBanner(content, {
        tone: 'error',
        title: strings.errorTitle,
        body: outcome.error.field,
        action: { label: strings.retry, onClick: () => void refresh() },
      }));
      return;
    }
    paintContent(outcome.view.runs);
  };

  const stopPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = (): void => {
    stopPolling();
    pollTimer = setInterval(() => {
      if (connected) {
        void refresh();
      }
    }, POLL_MS);
  };

  const paintChrome = (): void => {
    titleNode.textContent = strings.title;
    paintSessions();
    refreshSlot.replaceChildren();
    mountButton(refreshSlot, { label: strings.refresh, variant: 'outline', size: 'sm', onClick: () => void refresh() });
    steerFieldSlot.replaceChildren();
    mountTextField(steerFieldSlot, {
      placeholder: strings.steerPlaceholder,
      value: '',
      onChange: () => {},
    });
    steerButtons.replaceChildren();
    mountButton(steerButtons, {
      label: strings.steer,
      variant: 'default',
      size: 'sm',
      onClick: () => void steer(),
    });
    mountButton(steerButtons, {
      label: strings.cancel,
      variant: 'destructive',
      size: 'sm',
      onClick: () => void cancel(),
    });
    wrapperFieldSlot.replaceChildren();
    wrapperField = mountTextField(wrapperFieldSlot, {
      label: strings.wrapperLabel,
      helper: strings.wrapperHelper,
      value: wrapperEntry,
      mono: true,
      onChange: (value) => {
        wrapperEntry = value;
        void host.storage.set(WRAPPER_STORAGE_KEY, value);
      },
    });
  };

  const steer = async (): Promise<void> => {
    const message = (steerFieldValue()).trim();
    if (!message || !sessionId) {
      return;
    }
    try {
      const trimmedEntry = wrapperEntry.trim();
      const steerBody = trimmedEntry
        ? { message, sessionId, entry: trimmedEntry }
        : { message, sessionId };
      const answer = await serviceCall('POST', '/steer', undefined, steerBody);
      if (answer.status >= 400) {
        const code = isWireRecord(answer.body) ? wireString(answer.body.code) ?? 'request_failed' : 'request_failed';
        await host.toast({ kind: 'error', message: `${strings.steer}: ${code}` });
        return;
      }
      await host.toast({ kind: 'success', message: `${strings.steer}: ${sessionId}` });
      void refresh();
    } catch {
      await host.toast({ kind: 'error', message: `${strings.steer}: disconnected` });
    }
  };

  const steerFieldValue = (): string => {
    const input = steerFieldSlot.querySelector('input');
    return input instanceof HTMLInputElement ? input.value : '';
  };

  const cancel = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    try {
      const answer = await serviceCall('POST', '/cancel', undefined, { sessionId, reason: 'pane cancel' });
      if (answer.status >= 400) {
        const code = isWireRecord(answer.body) ? wireString(answer.body.code) ?? 'request_failed' : 'request_failed';
        await host.toast({ kind: 'error', message: `${strings.cancel}: ${code}` });
        return;
      }
      await host.toast({ kind: 'success', message: `${strings.cancel}: ${sessionId}` });
      void refresh();
    } catch {
      await host.toast({ kind: 'error', message: `${strings.cancel}: disconnected` });
    }
  };

  void host.onReady((context) => {
    strings = stringsFor(context.locale);
    applyHostReady(context, doc.documentElement);
    void host.storage.get(WRAPPER_STORAGE_KEY).then((stored) => {
      const entry = wireString(stored ?? undefined);
      if (entry !== null) {
        wrapperEntry = entry;
        wrapperField?.update({ value: entry });
      }
    }).catch(() => {});
    paintChrome();
    void refresh();
    startPolling();
  });

  void host.onConnection((connection) => {
    connected = connection.connected;
    if (!connected) {
      stopPolling();
      showNotice('banner', { tone: 'warning', title: strings.offlineTitle, body: strings.offlineBody });
    } else {
      showNotice('none');
      startPolling();
      void refresh();
    }
  });

  void host.onSession(() => {
    selectedNodeId = null;
    void refresh();
  });
};

const boot = (): void => {
  let framed = false;
  try {
    framed = window.parent !== window.self;
  } catch {
    framed = false;
  }
  if (!framed) {
    document.getElementById('app')?.replaceChildren(
      (() => {
        const note = document.createElement('p');
        note.textContent = 'omo-dag-pane loads only as a guest iframe.';
        return note;
      })(),
    );
    return;
  }
  const host = connectHost();
  startDagPane(host);
};

boot();

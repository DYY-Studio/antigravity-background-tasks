// Frontend controller for the Background Tasks side panel.
// Uses strict DOM construction (createElement / textContent / replaceChildren)
// without innerHTML to prevent XSS.

(() => {
  const POLL_MS = 2500;
  const TICK_MS = 1000;
  const PAGE_SIZE = 35;

  const params = new URLSearchParams(window.location.search);
  const conversationId =
    (window.sidecar && window.sidecar.conversationId) ||
    params.get('conversationId') ||
    '';
  const doFetch =
    window.sidecar && typeof window.sidecar.fetch === 'function'
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch.bind(window);

  const mainEl = document.getElementById('main');

  let report = null;
  let lastRenderSig = '';
  let lastError = '';
  let activeFilter = 'all';
  let searchQuery = '';
  let hideCompletedTimers = false;
  let visibleLimit = PAGE_SIZE;

  const expandedCmds = new Set();
  const openLogs = new Set();
  const logStateMap = new Map(); // taskKey -> { content, totalBytes, truncated, loading, filter, follow }

  // --- Formatting helpers ---------------------------------------------------

  function fmtDuration(ms) {
    if (ms === null || ms === undefined || ms < 0) return '—';
    const sec = ms / 1000;
    if (sec < 1) return `${Math.max(100, Math.round(ms))}ms`;
    if (sec < 10) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
    const total = Math.floor(sec);
    if (total < 60) return `${total}s`;
    if (total < 3600) {
      const m = Math.floor(total / 60);
      const s = total % 60;
      return s ? `${m}m ${s}s` : `${m}m`;
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function fmtTime(ms) {
    if (!ms) return '';
    try {
      const d = new Date(ms);
      return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  }

  function kindLabel(task) {
    if (task.kind === 'schedule') {
      return task.subkind === 'cron' ? 'CRON' : 'TIMER';
    }
    if (task.isDaemon || task.kind === 'daemon') {
      return 'DAEMON';
    }
    return 'CMD';
  }

  function stateLabel(task) {
    if (task.state === 'running') return 'RUNNING';
    if (task.state === 'completed') return 'DONE';
    if (task.state === 'canceled') return 'CANCELED';
    if (task.state === 'failed') {
      return task.exitCode !== null && task.exitCode !== undefined
        ? `EXIT ${task.exitCode}`
        : 'FAILED';
    }
    return String(task.state || 'PENDING').toUpperCase();
  }

  function taskKey(task) {
    return `${task.conversationId}:${task.stepIndex}`;
  }

  // --- Safe DOM builder -----------------------------------------------------

  function el(tag, attrs = null, children = null) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'className') {
          node.className = String(v);
        } else if (k === 'textContent') {
          node.textContent = String(v);
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          node.setAttribute(k, '');
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (children !== null && children !== undefined) {
      const list = Array.isArray(children) ? children : [children];
      for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
          node.appendChild(document.createTextNode(String(child)));
        } else if (child instanceof Node) {
          node.appendChild(child);
        }
      }
    }
    return node;
  }

  async function copyText(text, btn) {
    if (!text) return;
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Failed';
    }
    setTimeout(() => {
      btn.textContent = orig;
    }, 1200);
  }

  async function updateHookConfig(patch) {
    if (report && report.hookConfig) {
      report.hookConfig = { ...report.hookConfig, ...patch };
      render();
    }
    try {
      const res = await doFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.hookConfig && report) {
          report.hookConfig = data.hookConfig;
          lastRenderSig = JSON.stringify({ ...report, updatedAt: '' });
          render();
        }
      }
    } catch {
      // Next poll will resync hookConfig from backend.
    }
  }

  // --- Log loading & updating -----------------------------------------------

  function getOrInitLogState(key) {
    if (!logStateMap.has(key)) {
      logStateMap.set(key, {
        content: '',
        totalBytes: 0,
        truncated: false,
        loading: false,
        loadedOnce: false,
        filter: '',
        follow: true,
      });
    }
    return logStateMap.get(key);
  }

  function filterLogLines(content, query) {
    if (!content) return '';
    if (!query) return content;
    const q = query.toLowerCase();
    return content
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }

  function updateLogDom(key) {
    const pre = document.querySelector(`pre[data-log-pre="${CSS.escape(key)}"]`);
    const meta = document.querySelector(`span[data-log-meta="${CSS.escape(key)}"]`);
    const st = logStateMap.get(key);
    if (!st) return;

    if (meta) {
      const truncText = st.truncated ? ' (tail)' : '';
      meta.textContent = st.loading && !st.loadedOnce
        ? 'Loading…'
        : `${fmtBytes(st.totalBytes)}${truncText}`;
    }
    if (pre) {
      if (st.loading && !st.loadedOnce) {
        pre.textContent = 'Loading task log…';
        return;
      }
      const rendered = filterLogLines(st.content, st.filter);
      pre.textContent = rendered || (st.filter ? '(No matching log lines)' : '(No log output)');
      if (st.follow) {
        pre.scrollTop = pre.scrollHeight;
      }
    }
  }

  async function fetchLogForTask(task) {
    const key = taskKey(task);
    const st = getOrInitLogState(key);
    if (st.loading) return;
    st.loading = true;
    updateLogDom(key);

    try {
      const qs = new URLSearchParams({
        conversationId: task.conversationId,
        stepIndex: String(task.stepIndex),
      });
      const res = await doFetch(`/api/log?${qs.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (!data.error) {
          const nextContent = data.content || '';
          const nextBytes = Number(data.totalBytes || 0);
          const changed = !st.loadedOnce || nextContent !== st.content || nextBytes !== st.totalBytes;
          st.content = nextContent;
          st.totalBytes = nextBytes;
          st.truncated = Boolean(data.truncated);
          st.loadedOnce = true;
          st.loading = false;
          if (changed) updateLogDom(key);
          return;
        }
      }
    } catch {
      // Keep last known log content on transient error.
    }
    st.loading = false;
    updateLogDom(key);
  }

  // --- Filtering logic ------------------------------------------------------

  function matchesFilter(task) {
    if (activeFilter === 'running' && task.state !== 'running') return false;
    if (activeFilter === 'command' && task.kind !== 'command') return false;
    if (activeFilter === 'daemon' && !(task.isDaemon || task.kind === 'daemon')) return false;
    if (activeFilter === 'schedule' && task.kind !== 'schedule') return false;
    if (activeFilter === 'completed' && task.state !== 'completed') return false;
    if (activeFilter === 'failed' && task.state !== 'failed' && task.state !== 'canceled') return false;

    if (
      hideCompletedTimers &&
      (activeFilter === 'all' || activeFilter === 'completed') &&
      task.kind === 'schedule' &&
      task.state === 'completed'
    ) {
      return false;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const hay = `${task.summary} ${task.description} #${task.stepIndex} ${task.subagentRole || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  // --- Component builders ---------------------------------------------------

  function buildTaskCard(task, isGlobalCrossConv = false) {
    const key = taskKey(task);
    const isRunning = task.state === 'running';
    const isFailed = task.state === 'failed';
    const cardClass = `task-card${isRunning ? ' running' : ''}${isFailed ? ' failed' : ''}`;

    const children = [];

    if (isGlobalCrossConv) {
      const openBtn = el(
        'button',
        {
          type: 'button',
          className: 'btn-xs',
          title: 'Switch main chat window to this conversation',
          onClick: () => {
            if (window.sidecar?.ui?.toggleConversation) {
              window.sidecar.ui.toggleConversation(task.conversationId);
            }
          },
        },
        'Open ↗'
      );
      children.push(
        el('div', { className: 'card-conv' }, [
          el('span', {
            className: 'conv-title',
            title: task.conversationTitle || task.conversationId,
            textContent: task.conversationTitle || `Conversation ${task.conversationId.slice(0, 8)}`,
          }),
          task.workspaceName
            ? el('span', { className: 'ws-tag', textContent: task.workspaceName })
            : null,
          openBtn,
        ])
      );
    }

    const kLabel = kindLabel(task);
    const kindBadgeClass =
      task.kind === 'schedule'
        ? 'badge kind-schedule'
        : task.isDaemon || task.kind === 'daemon'
        ? 'badge kind-daemon'
        : 'badge';

    const sLabel = stateLabel(task);
    const stateBadgeClass = `badge state-${task.state}`;

    children.push(
      el('div', { className: 'card-head' }, [
        el('div', { className: 'card-title-wrap' }, [
          el('span', { className: `state-dot ${task.state}` }),
          el('span', {
            className: 'card-title',
            title: task.summary,
            textContent: task.summary,
          }),
        ]),
        el('div', { className: 'badges' }, [
          task.subagentRole
            ? el('span', {
                className: 'badge',
                title: `Subagent: ${task.subagentRole}`,
                textContent: task.subagentRole.slice(0, 14),
              })
            : null,
          el('span', { className: kindBadgeClass, textContent: kLabel }),
          el('span', { className: stateBadgeClass, textContent: sLabel }),
        ]),
      ])
    );

    const now = Date.now();
    const elapsedMs = isRunning && task.startedAtMs ? Math.max(0, now - task.startedAtMs) : task.durationMs;
    const durSpan = el('span', {
      className: isRunning ? 'dur-live num' : 'num',
      'data-live-start': isRunning && task.startedAtMs ? String(task.startedAtMs) : null,
      textContent: fmtDuration(elapsedMs),
    });

    const copyCmdBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-xs',
        title: 'Copy command or schedule description',
        onClick: (e) => copyText(task.description, e.currentTarget),
      },
      'Copy Cmd'
    );

    children.push(
      el('div', { className: 'card-meta num' }, [
        el('div', { className: 'meta-left' }, [
          el('span', { textContent: `#${task.stepIndex}` }),
          task.startedAtMs ? el('span', { textContent: `· ${fmtTime(task.startedAtMs)}` }) : null,
          el('span', null, ['· ', durSpan]),
          task.logBytes > 0 ? el('span', { textContent: `· ${fmtBytes(task.logBytes)}` }) : null,
        ]),
        task.description ? copyCmdBtn : null,
      ])
    );

    if (task.description) {
      const isCmdExpanded = expandedCmds.has(key);
      const cmdBox = el(
        'div',
        {
          className: `cmd-box mono${isCmdExpanded ? ' expanded' : ''}`,
          title: 'Click to toggle full command / prompt',
          textContent: task.description,
          onClick: () => {
            if (expandedCmds.has(key)) {
              expandedCmds.delete(key);
              cmdBox.classList.remove('expanded');
            } else {
              expandedCmds.add(key);
              cmdBox.classList.add('expanded');
            }
          },
        }
      );
      children.push(cmdBox);
    }

    // Expandable Log Drawer
    const isLogOpen = openLogs.has(key);
    const logSt = getOrInitLogState(key);

    const logSummary = el('summary', null, [
      el('div', { className: 'sum-left' }, [
        el('span', { className: 'sum-caret', textContent: '▶' }),
        el('span', { className: 'sum-label', textContent: isRunning ? 'Live Log' : 'Output Log' }),
        task.snippet
          ? el('span', { className: 'sum-snippet mono', textContent: task.snippet.replace(/\n/g, ' ↵ ') })
          : el('span', { className: 'sum-snippet', textContent: task.hasLog ? 'Click to view output' : 'No log file' }),
      ]),
      el('span', {
        className: 'num',
        'data-log-meta': key,
        textContent: logSt.loadedOnce ? fmtBytes(logSt.totalBytes) : (task.logBytes ? fmtBytes(task.logBytes) : ''),
      }),
    ]);

    const filterInput = el('input', {
      type: 'search',
      placeholder: 'Filter log lines…',
      value: logSt.filter,
      onInput: (e) => {
        logSt.filter = e.currentTarget.value;
        updateLogDom(key);
      },
    });

    const followCheckbox = el('input', {
      type: 'checkbox',
      checked: logSt.follow ? 'checked' : null,
      onChange: (e) => {
        logSt.follow = Boolean(e.currentTarget.checked);
        if (logSt.follow) updateLogDom(key);
      },
    });

    const refreshLogBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-xs',
        onClick: () => fetchLogForTask(task),
      },
      'Refresh'
    );

    const copyLogBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-xs',
        onClick: (e) => copyText(filterLogLines(logSt.content || task.snippet || '', logSt.filter), e.currentTarget),
      },
      'Copy Log'
    );

    const renderedText = logSt.loadedOnce
      ? filterLogLines(logSt.content, logSt.filter) || (logSt.filter ? '(No matching log lines)' : '(No log output)')
      : task.snippet || 'Loading task log…';

    const logPre = el('pre', {
      className: 'log-pre mono',
      'data-log-pre': key,
      textContent: renderedText,
    });

    const detailsEl = el(
      'details',
      {
        className: 'log-drawer',
        open: isLogOpen ? 'open' : null,
        onToggle: (e) => {
          if (e.currentTarget.open) {
            openLogs.add(key);
            fetchLogForTask(task);
          } else {
            openLogs.delete(key);
          }
        },
      },
      [
        logSummary,
        el('div', { className: 'log-body' }, [
          el('div', { className: 'log-toolbar' }, [
            filterInput,
            el('label', { className: 'toggle-label', title: 'Auto-scroll to bottom on update' }, [
              followCheckbox,
              'Follow',
            ]),
            refreshLogBtn,
            copyLogBtn,
          ]),
          logPre,
        ]),
      ]
    );

    children.push(detailsEl);
    return el('div', { className: cardClass }, children);
  }

  // --- Full panel render ----------------------------------------------------

  function render() {
    if (!report) {
      mainEl.replaceChildren(
        el('p', { className: 'empty', textContent: lastError ? `Error: ${lastError}` : 'Loading background tasks…' })
      );
      return;
    }

    const counts = report.counts || {
      all: 0,
      running: 0,
      command: 0,
      daemon: 0,
      schedule: 0,
      completed: 0,
      failed: 0,
      globalRunning: 0,
    };
    const totalRunning = (counts.running || 0) + (counts.globalRunning || 0);

    // Preserve active search input focus across background refreshes.
    const activeSearchFocused = document.activeElement?.id === 'task-search-input';
    const selStart = activeSearchFocused ? document.activeElement.selectionStart : null;
    const selEnd = activeSearchFocused ? document.activeElement.selectionEnd : null;

    const nodes = [];

    // 1. Header
    const liveClass = lastError ? 'live err' : totalRunning > 0 ? 'live active' : 'live on';
    const statParts = [];
    if (totalRunning > 0) statParts.push(`${totalRunning} running`);
    statParts.push(`${counts.all || 0} in session`);

    nodes.push(
      el('div', { className: 'top' }, [
        el('div', { className: 'title-wrap' }, [
          el('span', { className: liveClass }),
          el('span', { className: 'panel-title', textContent: 'Background Tasks' }),
          el('span', { className: 'summary-stat num', textContent: `· ${statParts.join(' · ')}` }),
        ]),
        el(
          'button',
          {
            type: 'button',
            onClick: () => poll(true),
          },
          'Refresh'
        ),
      ])
    );

    if (lastError) {
      nodes.push(el('div', { className: 'notice error', textContent: lastError }));
    }
    if (Array.isArray(report.warnings) && report.warnings.length > 0) {
      for (const w of report.warnings) {
        nodes.push(el('div', { className: 'notice', textContent: w }));
      }
    }

    // 1b. Hook Monitor Settings Bar
    const hc = report.hookConfig || { postInvocation: 'both', stop: true, antiPoll: true };
    const postScopes = [
      { id: 'off', label: 'Off', title: 'Disable PostInvocation reminder' },
      { id: 'command', label: 'Cmd', title: 'Remind only for non-daemon background commands' },
      { id: 'subagent', label: 'Subagent', title: 'Remind only for running subagents' },
      { id: 'both', label: 'Both', title: 'Remind for both background commands and subagents' },
    ];
    const scopePills = postScopes.map((opt) =>
      el(
        'button',
        {
          type: 'button',
          className: `pill${hc.postInvocation === opt.id ? ' active' : ''}`,
          title: opt.title,
          onClick: () => updateHookConfig({ postInvocation: opt.id }),
        },
        opt.label
      )
    );
    const antiPollCheckbox = el('input', {
      type: 'checkbox',
      checked: hc.antiPoll !== false ? 'checked' : null,
      onChange: (e) => updateHookConfig({ antiPoll: Boolean(e.currentTarget.checked) }),
    });
    const stopCheckbox = el('input', {
      type: 'checkbox',
      checked: hc.stop ? 'checked' : null,
      onChange: (e) => updateHookConfig({ stop: Boolean(e.currentTarget.checked) }),
    });
    nodes.push(
      el('div', { className: 'hook-bar' }, [
        el('div', { className: 'hook-group' }, [
          el('span', {
            className: 'hook-label',
            title: 'Inject ephemeral schedule-monitoring reminder after tool calls',
            textContent: 'PostInvocation:',
          }),
          el('div', { className: 'pills' }, scopePills),
        ]),
        el('div', { className: 'hook-group', style: 'gap: 10px;' }, [
          el(
            'label',
            {
              className: 'toggle-label',
              title: 'Block redundant manage_subagents/manage_task/sleep polling while a schedule timer is active',
            },
            [antiPollCheckbox, 'Anti-Poll']
          ),
          el(
            'label',
            {
              className: 'toggle-label',
              title: 'Block agent from stopping (NO_TOOL_CALL) while monitored tasks run without an active schedule timer',
            },
            [stopCheckbox, 'Stop Guard']
          ),
        ]),
      ])
    );

    // 2. Global Cross-Conversation Running Tasks section
    const globalTasks = Array.isArray(report.globalRunningTasks) ? report.globalRunningTasks : [];
    if (globalTasks.length > 0) {
      nodes.push(
        el('section', null, [
          el('div', { className: 'sec-head' }, [
            el('h2', { textContent: `Other Conversations · Running (${globalTasks.length})` }),
          ]),
          el(
            'div',
            { className: 'task-list' },
            globalTasks.map((t) => buildTaskCard(t, true))
          ),
        ])
      );
    }

    // 3. Current Conversation Section
    const filterDefs = [
      { id: 'all', label: 'All', count: counts.all },
      { id: 'running', label: 'Running', count: counts.running },
      { id: 'command', label: 'Command', count: counts.command },
      { id: 'daemon', label: 'Daemon', count: counts.daemon },
      { id: 'schedule', label: 'Schedule', count: counts.schedule },
      { id: 'completed', label: 'Done', count: counts.completed },
      { id: 'failed', label: 'Failed', count: counts.failed },
    ];

    const pillButtons = filterDefs
      .filter((f) => f.id === 'all' || f.id === 'running' || f.id === 'command' || f.count > 0 || activeFilter === f.id)
      .map((f) =>
        el(
          'button',
          {
            type: 'button',
            className: `pill num${activeFilter === f.id ? ' active' : ''}`,
            onClick: () => {
              activeFilter = f.id;
              visibleLimit = PAGE_SIZE;
              render();
            },
          },
          `${f.label} (${f.count || 0})`
        )
      );

    const searchInput = el('input', {
      id: 'task-search-input',
      type: 'search',
      placeholder: 'Filter by summary, command, or #step…',
      value: searchQuery,
      onInput: (e) => {
        searchQuery = e.currentTarget.value;
        visibleLimit = PAGE_SIZE;
        renderTaskListOnly();
      },
    });

    const hideTimersCheckbox = el('input', {
      type: 'checkbox',
      checked: hideCompletedTimers ? 'checked' : null,
      onChange: (e) => {
        hideCompletedTimers = Boolean(e.currentTarget.checked);
        renderTaskListOnly();
      },
    });

    const listContainer = el('div', { id: 'current-task-list-wrap' });

    const convSubtitle = report.conversationTitle
      ? report.conversationTitle
      : report.conversationId
      ? `Session ${report.conversationId.slice(0, 8)}`
      : 'No active conversation';

    nodes.push(
      el('section', null, [
        el('div', { className: 'sec-head' }, [
          el('h2', { textContent: 'Current Conversation' }),
          el('span', { className: 'dim', style: 'font-size:11px;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: convSubtitle }),
        ]),
        el('div', { className: 'controls' }, [
          el('div', { className: 'pills' }, pillButtons),
          el('div', { className: 'search-row' }, [
            searchInput,
            counts.schedule > 0 && (activeFilter === 'all' || activeFilter === 'completed')
              ? el('label', { className: 'toggle-label', title: 'Hide finished one-shot timers' }, [
                  hideTimersCheckbox,
                  'Hide timers',
                ])
              : null,
          ]),
        ]),
        listContainer,
      ])
    );

    // 4. Footer
    const updatedStr = report.updatedAt ? fmtTime(Date.parse(report.updatedAt)) : '';
    nodes.push(
      el('footer', { className: 'num' }, [
        el('span', { textContent: report.workspaceName ? `Workspace: ${report.workspaceName}` : 'Background Tasks Monitor' }),
        el('span', { id: 'footer-updated', textContent: updatedStr ? `Updated ${updatedStr}` : '' }),
      ])
    );

    mainEl.replaceChildren(...nodes);
    renderTaskListOnly();

    if (activeSearchFocused) {
      const restored = document.getElementById('task-search-input');
      if (restored) {
        restored.focus();
        if (selStart !== null && selEnd !== null) {
          restored.setSelectionRange(selStart, selEnd);
        }
      }
    }
  }

  function renderTaskListOnly() {
    const wrap = document.getElementById('current-task-list-wrap');
    if (!wrap || !report) return;

    const allTasks = Array.isArray(report.currentTasks) ? report.currentTasks : [];
    const filtered = allTasks.filter(matchesFilter);

    if (filtered.length === 0) {
      const msg = !report.conversationId
        ? 'Open a conversation to inspect its background tasks.'
        : allTasks.length === 0
        ? 'No background tasks recorded in this conversation.'
        : 'No tasks match the current filter.';
      wrap.replaceChildren(el('p', { className: 'empty', textContent: msg }));
      return;
    }

    const slice = filtered.slice(0, visibleLimit);
    const listEl = el(
      'div',
      { className: 'task-list' },
      slice.map((t) => buildTaskCard(t, false))
    );

    const children = [listEl];
    if (filtered.length > visibleLimit) {
      const remaining = filtered.length - visibleLimit;
      children.push(
        el('div', { className: 'more-wrap' }, [
          el(
            'button',
            {
              type: 'button',
              onClick: () => {
                visibleLimit += PAGE_SIZE;
                renderTaskListOnly();
              },
            },
            `Show more (${remaining} remaining)`
          ),
        ])
      );
    }

    wrap.replaceChildren(...children);
  }

  // --- Live 1s timer tick & polling -----------------------------------------

  function tickLiveTimers() {
    const now = Date.now();
    const nodes = document.querySelectorAll('[data-live-start]');
    for (const node of nodes) {
      const startMs = Number(node.getAttribute('data-live-start'));
      if (startMs > 0) {
        node.textContent = fmtDuration(Math.max(0, now - startMs));
      }
    }
  }

  async function refreshOpenLogsForRunningTasks() {
    if (!report || openLogs.size === 0) return;
    const all = [
      ...(report.currentTasks || []),
      ...(report.globalRunningTasks || []),
    ];
    for (const t of all) {
      const key = taskKey(t);
      if (openLogs.has(key) && (t.state === 'running' || !logStateMap.get(key)?.loadedOnce)) {
        fetchLogForTask(t);
      }
    }
  }

  async function poll(forceRender = false) {
    try {
      const qs = new URLSearchParams();
      if (conversationId) qs.set('conversationId', conversationId);
      const targetId = params.get('targetId') || '';
      if (targetId) qs.set('targetId', targetId);

      const res = await doFetch(`/api/tasks?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.message || data.error);
      }
      lastError = '';
      report = data;
      const nextSig = JSON.stringify({ ...data, updatedAt: '' });
      const updatedStr = data.updatedAt ? fmtTime(Date.parse(data.updatedAt)) : '';

      if (!forceRender && nextSig === lastRenderSig) {
        const footerUpd = document.getElementById('footer-updated');
        if (footerUpd && updatedStr) footerUpd.textContent = `Updated ${updatedStr}`;
      } else {
        lastRenderSig = nextSig;
        render();
      }
      await refreshOpenLogsForRunningTasks();
    } catch (err) {
      lastError = err.message || 'Failed to load background tasks';
      render();
    }
  }

  setInterval(tickLiveTimers, TICK_MS);
  setInterval(() => poll(false), POLL_MS);
  poll(true);
})();

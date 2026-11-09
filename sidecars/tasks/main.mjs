// Sidecar backend for the Background Tasks panel.
//
// Fuses live cross-conversation running tasks from the Language Server
// (ListBackgroundTasks, GetAllCascadeTrajectories) with historical and active
// task records stored in conversation SQLite databases (steps.task_details,
// steps.metadata, steps.step_payload) and task log files under
// ~/.gemini/antigravity/brain/<id>/.system_generated/tasks/.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const APP_DIR = join(GEMINI_DIR, 'antigravity');
const CONVERSATIONS_DIR = resolve(APP_DIR, 'conversations');
const BRAIN_DIR = resolve(APP_DIR, 'brain');
const SUMMARIES_DB_PATH = resolve(APP_DIR, 'conversation_summaries.db');
const DATA_DIR = resolve(APP_DIR, 'background-tasks');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_CID_RE = /"conversationId"\s*:\s*"([0-9a-fA-F-]{36})"/;
const EXIT_CODE_RE = /Command exited with code (-?\d+)\./;
const VALID_POST_SCOPES = new Set(['off', 'command', 'subagent', 'both']);
const DEFAULT_TAIL_BYTES = 128 * 1024;
const MAX_TAIL_BYTES = 512 * 1024;
const SNIPPET_TAIL_BYTES = 4096;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*;",
};

// --- Protobuf wire reader ---------------------------------------------------

function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [val, pos];
    }
    shift += 7n;
    if (shift > 70n) throw new Error('Varint overflow');
  }
  throw new Error('Truncated varint');
}

export class WireMsg {
  constructor(buf) {
    this.fields = new Map();
    if (!buf || !buf.length) return;
    let pos = 0;
    const len = buf.length;
    while (pos < len) {
      let tag;
      try {
        [tag, pos] = readVarint(buf, pos);
      } catch {
        break;
      }
      const fn = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      let val;
      try {
        if (wt === 0) {
          [val, pos] = readVarint(buf, pos);
        } else if (wt === 2) {
          let l;
          [l, pos] = readVarint(buf, pos);
          const n = Number(l);
          if (n < 0 || pos + n > len) break;
          val = buf.subarray(pos, pos + n);
          pos += n;
        } else if (wt === 1) {
          if (pos + 8 > len) break;
          val = buf.subarray(pos, pos + 8);
          pos += 8;
        } else if (wt === 5) {
          if (pos + 4 > len) break;
          val = buf.subarray(pos, pos + 4);
          pos += 4;
        } else {
          break;
        }
      } catch {
        break;
      }
      let arr = this.fields.get(fn);
      if (!arr) {
        arr = [];
        this.fields.set(fn, arr);
      }
      arr.push(val);
    }
  }

  has(fn) {
    return this.fields.has(fn);
  }

  int(fn) {
    const arr = this.fields.get(fn);
    if (!arr || !arr.length) return 0;
    const v = arr[arr.length - 1];
    return typeof v === 'bigint' ? Number(v) : 0;
  }

  bytes(fn) {
    const arr = this.fields.get(fn);
    if (!arr || !arr.length) return null;
    const v = arr[arr.length - 1];
    return v instanceof Uint8Array ? v : null;
  }

  str(fn) {
    const b = this.bytes(fn);
    return b ? Buffer.from(b).toString('utf8') : '';
  }

  msg(fn) {
    const b = this.bytes(fn);
    return b ? new WireMsg(b) : null;
  }
}

function parseTimestampMs(msg) {
  if (!msg) return null;
  const sec = msg.int(1);
  const nanos = msg.int(2);
  if (!sec && !nanos) return null;
  return sec * 1000 + Math.floor(nanos / 1e6);
}

function parseIsoTimestampMs(str) {
  if (!str || typeof str !== 'string') return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

// --- Language Server RPC ----------------------------------------------------

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    return Promise.reject(new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN'));
  }
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const payload = JSON.stringify(body || {});
  const transport = base.protocol === 'https:' ? https : http;

  return new Promise((resolvePromise, rejectPromise) => {
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          rejectPromise(new Error(`${method} returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(text));
        } catch (err) {
          rejectPromise(new Error(`${method} invalid JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} timed out`)));
    req.on('error', rejectPromise);
    req.end(payload);
  });
}

// --- Path validation & log reading ------------------------------------------

function isSubpath(parentDir, candidatePath) {
  const prefix = parentDir + sep;
  return process.platform === 'win32'
    ? candidatePath.toLowerCase().startsWith(prefix.toLowerCase())
    : candidatePath.startsWith(prefix);
}

function resolveConversationDbPath(convId) {
  if (!UUID_RE.test(convId || '')) return null;
  const resolved = resolve(CONVERSATIONS_DIR, `${convId}.db`);
  if (!isSubpath(CONVERSATIONS_DIR, resolved)) return null;
  return resolved;
}

function resolveSandboxedTaskLogPath(convId, stepIndex, logUri) {
  if (!UUID_RE.test(convId || '')) return null;
  const idx = Number(stepIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;

  const sandboxDir = resolve(BRAIN_DIR, convId, '.system_generated', 'tasks');
  let candidate = resolve(sandboxDir, `task-${idx}.log`);

  if (typeof logUri === 'string' && logUri.startsWith('file://')) {
    try {
      const fromUri = resolve(fileURLToPath(logUri));
      if (isSubpath(sandboxDir, fromUri) && fromUri.toLowerCase().endsWith('.log')) {
        candidate = fromUri;
      }
    } catch {
      // Fall back to canonical task-<idx>.log inside sandboxDir.
    }
  }

  if (!isSubpath(sandboxDir, candidate)) return null;
  return candidate;
}

export function normalizeTerminalOutput(raw) {
  if (!raw) return '';
  // Normalize CRLF -> LF, then collapse bare carriage-return progress bar overwrites on the same line.
  const lf = raw.replace(/\r\n/g, '\n');
  const lines = lf.split('\n');
  const cleaned = lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    // Keep the last non-empty segment overwritten on that line.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) return parts[i];
    }
    return '';
  });
  return cleaned.join('\n');
}

function readTailFromFile(filePath, maxBytes) {
  if (!filePath || !existsSync(filePath)) {
    return { exists: false, totalBytes: 0, truncated: false, content: '', mtimeMs: null };
  }
  try {
    const st = statSync(filePath);
    const totalBytes = st.size;
    if (totalBytes === 0) {
      return { exists: true, totalBytes: 0, truncated: false, content: '', mtimeMs: st.mtimeMs };
    }
    const readLen = Math.min(totalBytes, maxBytes);
    const offset = Math.max(0, totalBytes - readLen);
    const buf = Buffer.alloc(readLen);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buf, 0, readLen, offset);
    } finally {
      closeSync(fd);
    }
    let content = buf.toString('utf8');
    if (offset > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1 && firstNewline < 256) {
        content = content.slice(firstNewline + 1);
      }
    }
    return {
      exists: true,
      totalBytes,
      truncated: offset > 0,
      content: normalizeTerminalOutput(content),
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { exists: false, totalBytes: 0, truncated: false, content: '', mtimeMs: null };
  }
}

function lastNonEmptyLines(text, maxLines = 2) {
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (!lines.length) return '';
  return lines.slice(-maxLines).join('\n');
}

// --- Task classification & SQLite extraction --------------------------------

function classifyTaskKind(toolName, isDaemon, description, args) {
  const desc = String(description || '');
  if (toolName === 'schedule' || /^(Timer|Cron):/i.test(desc)) {
    const isCron = Boolean(args?.CronExpression) || /^Cron:/i.test(desc);
    return { kind: 'schedule', subkind: isCron ? 'cron' : 'timer' };
  }
  if (isDaemon || Boolean(args?.IsDaemon)) {
    return { kind: 'daemon', subkind: 'daemon' };
  }
  return { kind: 'command', subkind: 'command' };
}

function classifyTaskState(stepStatus, isLiveRunning, exitCode, hasErrorDetails) {
  if (isLiveRunning || stepStatus === 2 || stepStatus === 8 || stepStatus === 9) {
    return 'running';
  }
  if (stepStatus === 6 || stepStatus === 10 || stepStatus === 11) {
    return 'canceled';
  }
  if (stepStatus === 4 || stepStatus === 7 || hasErrorDetails) {
    return 'failed';
  }
  if (exitCode !== null && exitCode !== 0) {
    return 'failed';
  }
  if (stepStatus === 3) {
    return 'completed';
  }
  return 'pending';
}

function extractStepTask(row, convId, liveTaskSet, subagentMeta = null) {
  const idx = Number(row.idx);
  const stepStatus = Number(row.status);
  const td = new WireMsg(row.task_details);
  const meta = new WireMsg(row.metadata);
  const payload = new WireMsg(row.step_payload);

  const taskId = td.str(1) || `${convId}/task-${idx}`;
  const logUri = td.str(2) || '';
  const dbSnippet = normalizeTerminalOutput(td.str(3) || '');
  const description = td.str(4) || '';
  const isDaemon = td.int(6) === 1;
  const toolSummary = td.str(7) || '';
  const tdStartMs = parseTimestampMs(td.msg(8));

  const tc = meta.msg(4);
  const toolName = tc ? tc.str(2) : '';
  let args = null;
  if (tc) {
    const rawArgs = tc.str(3);
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = null;
      }
    }
  }

  const createdAtMs = parseTimestampMs(meta.msg(1));
  const metaStartMs = parseTimestampMs(meta.msg(7)) || parseTimestampMs(meta.msg(6));
  const completedAtMs = parseTimestampMs(meta.msg(8));

  const genericMsg = payload.msg(140);
  const resultMsg = genericMsg ? genericMsg.msg(2) : null;
  const payloadOutput = resultMsg ? resultMsg.str(1) : '';
  const exitMatch = EXIT_CODE_RE.exec(payloadOutput);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const hasErrorDetails = Boolean(row.error_details && row.error_details.length > 0);

  const isLiveRunning = liveTaskSet.has(taskId) || liveTaskSet.has(`${convId}/task-${idx}`);
  const kindInfo = classifyTaskKind(toolName, isDaemon, description, args);
  const state = classifyTaskState(stepStatus, isLiveRunning, exitCode, hasErrorDetails);

  const logPath = resolveSandboxedTaskLogPath(convId, idx, logUri);
  const logTail = readTailFromFile(logPath, SNIPPET_TAIL_BYTES);

  const startedAtMs = metaStartMs || tdStartMs || createdAtMs || null;
  const endedAtMs = state === 'running' ? null : (completedAtMs || logTail.mtimeMs || null);
  const durationMs = startedAtMs && endedAtMs && endedAtMs >= startedAtMs
    ? endedAtMs - startedAtMs
    : null;

  const cleanedPayload = normalizeTerminalOutput(
    payloadOutput.replace(/^Command exited with code -?\d+\.\s*(?:Command output:\s*)?/i, '')
  );
  const snippet = lastNonEmptyLines(logTail.content || dbSnippet || cleanedPayload, 2);
  const totalBytes = logTail.totalBytes || Buffer.byteLength(dbSnippet || payloadOutput, 'utf8');
  const summary = toolSummary || args?.toolSummary || (kindInfo.kind === 'schedule' ? 'Scheduled task' : `Task #${idx}`);
  const commandOrPrompt = args?.CommandLine || description || args?.Prompt || '';

  return {
    taskId,
    conversationId: convId,
    stepIndex: idx,
    summary,
    description: commandOrPrompt,
    toolName: toolName || (kindInfo.kind === 'schedule' ? 'schedule' : 'run_command'),
    kind: kindInfo.kind,
    subkind: kindInfo.subkind,
    isDaemon: kindInfo.kind === 'daemon' || Boolean(args?.IsDaemon) || isDaemon,
    state,
    exitCode,
    startedAtMs,
    endedAtMs,
    durationMs,
    logBytes: totalBytes,
    hasLog: totalBytes > 0,
    snippet,
    subagentRole: subagentMeta?.role || '',
    subagentType: subagentMeta?.typeName || '',
  };
}

function readConversationTasksFromDb(convId, liveTaskSet, subagentMeta = null) {
  const dbPath = resolveConversationDbPath(convId);
  if (!dbPath || !existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(
      'SELECT idx, step_type, status, metadata, error_details, task_details, step_payload ' +
      'FROM steps WHERE task_details IS NOT NULL AND length(task_details) > 0 ORDER BY idx DESC'
    );
    const rows = stmt.all();
    return rows.map((row) => extractStepTask(row, convId, liveTaskSet, subagentMeta));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function snapshotToTask(convId, snap, convInfo = null, subagentMeta = null) {
  const stepIndex = Number(snap?.stepIndex ?? 0);
  const taskId = snap?.taskId || `${convId}/task-${stepIndex}`;
  const toolName = snap?.toolName || '';
  const isDaemon = Boolean(snap?.isDaemon);
  const description = snap?.description || '';
  const kindInfo = classifyTaskKind(toolName, isDaemon, description, null);
  const startedAtMs = parseIsoTimestampMs(snap?.startTime) || null;
  const logPath = resolveSandboxedTaskLogPath(convId, stepIndex, snap?.logUri || '');
  const logTail = readTailFromFile(logPath, SNIPPET_TAIL_BYTES);

  return {
    taskId,
    conversationId: convId,
    conversationTitle: convInfo?.title || '',
    workspaceName: convInfo?.workspaceName || '',
    stepIndex,
    summary: snap?.toolSummary || (kindInfo.kind === 'schedule' ? 'Scheduled task' : `Task #${stepIndex}`),
    description,
    toolName: toolName || (kindInfo.kind === 'schedule' ? 'schedule' : 'run_command'),
    kind: kindInfo.kind,
    subkind: kindInfo.subkind,
    isDaemon: kindInfo.kind === 'daemon' || isDaemon,
    state: 'running',
    exitCode: null,
    startedAtMs,
    endedAtMs: null,
    durationMs: null,
    logBytes: logTail.totalBytes,
    hasLog: logTail.totalBytes > 0,
    snippet: lastNonEmptyLines(logTail.content, 2),
    subagentRole: subagentMeta?.role || '',
    subagentType: subagentMeta?.typeName || '',
  };
}

function extractWorkspaceName(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) return '';
  const uri = workspaces[0]?.workspaceFolderAbsoluteUri || workspaces[0]?.workspaceUri || '';
  if (!uri) return '';
  let cleaned = uri;
  if (cleaned.startsWith('file://')) {
    try {
      cleaned = fileURLToPath(cleaned);
    } catch {
      cleaned = decodeURIComponent(cleaned.replace(/^file:\/\//, ''));
    }
  }
  const parts = cleaned.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts[parts.length - 1] || '';
}

// --- Public API handlers ----------------------------------------------------

export async function fetchTasksReport(conversationId, targetId = '') {
  const hostId = UUID_RE.test(conversationId || '') ? conversationId : '';
  const activeId = UUID_RE.test(targetId || '') ? targetId : hostId;
  const warnings = [];

  const [bgResp, trajResp] = await Promise.all([
    lsRequest('ListBackgroundTasks', {}).catch((err) => {
      warnings.push(`Live background task RPC unavailable: ${err.message}`);
      return null;
    }),
    lsRequest('GetAllCascadeTrajectories', {}).catch(() => null),
  ]);

  const summaries = trajResp?.trajectorySummaries || trajResp?.response?.trajectorySummaries || {};
  const liveEntries = Array.isArray(bgResp?.tasks) ? bgResp.tasks : [];

  const liveTaskSet = new Set();
  const liveByConv = new Map();
  for (const item of liveEntries) {
    const cid = item?.conversationId || '';
    const snap = item?.task;
    if (!cid || !snap) continue;
    const tid = snap.taskId || `${cid}/task-${snap.stepIndex ?? 0}`;
    liveTaskSet.add(tid);
    if (!liveByConv.has(cid)) liveByConv.set(cid, []);
    liveByConv.get(cid).push(snap);
  }

  // Discover child subagents belonging to activeId so their background tasks appear in the current session view.
  const childSubagents = new Map();
  if (activeId) {
    for (const [cid, info] of Object.entries(summaries)) {
      const meta = info?.trajectoryMetadata;
      if (meta && (meta.parentConversationId === activeId || meta.rootConversationId === activeId) && cid !== activeId) {
        childSubagents.set(cid, {
          role: meta.subagentRole || info.summary || '',
          typeName: meta.subagentTypeName || '',
        });
      }
    }
  }

  const currentTasksMap = new Map();
  if (activeId) {
    const mainTasks = readConversationTasksFromDb(activeId, liveTaskSet, null);
    for (const t of mainTasks) {
      currentTasksMap.set(t.taskId, t);
    }
    for (const [subId, subMeta] of childSubagents.entries()) {
      const subTasks = readConversationTasksFromDb(subId, liveTaskSet, subMeta);
      for (const t of subTasks) {
        currentTasksMap.set(t.taskId, t);
      }
    }
    // Merge any in-memory live tasks not yet flushed to SQLite.
    const scopeIds = [activeId, ...childSubagents.keys()];
    for (const cid of scopeIds) {
      const snaps = liveByConv.get(cid) || [];
      const subMeta = cid === activeId ? null : childSubagents.get(cid);
      for (const snap of snaps) {
        const tid = snap.taskId || `${cid}/task-${snap.stepIndex ?? 0}`;
        if (!currentTasksMap.has(tid)) {
          currentTasksMap.set(tid, snapshotToTask(cid, snap, null, subMeta));
        }
      }
    }
  }

  const currentTasks = Array.from(currentTasksMap.values()).sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return (b.startedAtMs || 0) - (a.startedAtMs || 0) || b.stepIndex - a.stepIndex;
  });

  // Collect global running tasks from other conversations.
  const currentScopeSet = new Set([activeId, ...childSubagents.keys()].filter(Boolean));
  const globalRunningTasks = [];
  const seenGlobalIds = new Set();

  for (const [cid, snaps] of liveByConv.entries()) {
    if (currentScopeSet.has(cid)) continue;
    const info = summaries[cid];
    const convInfo = {
      title: info?.summary || `Conversation ${cid.slice(0, 8)}`,
      workspaceName: extractWorkspaceName(info?.workspaces),
    };
    const dbTasks = readConversationTasksFromDb(cid, liveTaskSet, null);
    const dbByTaskId = new Map(dbTasks.map((t) => [t.taskId, t]));

    for (const snap of snaps) {
      const tid = snap.taskId || `${cid}/task-${snap.stepIndex ?? 0}`;
      if (seenGlobalIds.has(tid)) continue;
      seenGlobalIds.add(tid);
      const fromDb = dbByTaskId.get(tid);
      if (fromDb) {
        globalRunningTasks.push({
          ...fromDb,
          state: 'running',
          conversationTitle: convInfo.title,
          workspaceName: convInfo.workspaceName,
        });
      } else {
        globalRunningTasks.push(snapshotToTask(cid, snap, convInfo, null));
      }
    }
  }

  // Also check any currently running conversation trajectories in case ListBackgroundTasks omitted a waiting step.
  for (const [cid, info] of Object.entries(summaries)) {
    if (currentScopeSet.has(cid)) continue;
    if (info?.status !== 'CASCADE_RUN_STATUS_RUNNING') continue;
    const convInfo = {
      title: info?.summary || `Conversation ${cid.slice(0, 8)}`,
      workspaceName: extractWorkspaceName(info?.workspaces),
    };
    const dbTasks = readConversationTasksFromDb(cid, liveTaskSet, null);
    for (const t of dbTasks) {
      if (t.state === 'running' && !seenGlobalIds.has(t.taskId)) {
        seenGlobalIds.add(t.taskId);
        globalRunningTasks.push({
          ...t,
          conversationTitle: convInfo.title,
          workspaceName: convInfo.workspaceName,
        });
      }
    }
  }

  globalRunningTasks.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));

  const counts = {
    all: currentTasks.length,
    running: currentTasks.filter((t) => t.state === 'running').length,
    command: currentTasks.filter((t) => t.kind === 'command').length,
    daemon: currentTasks.filter((t) => t.isDaemon || t.kind === 'daemon').length,
    schedule: currentTasks.filter((t) => t.kind === 'schedule').length,
    completed: currentTasks.filter((t) => t.state === 'completed').length,
    failed: currentTasks.filter((t) => t.state === 'failed' || t.state === 'canceled').length,
    globalRunning: globalRunningTasks.length,
  };

  const activeInfo = activeId ? summaries[activeId] : null;
  return {
    conversationId: activeId,
    hostConversationId: hostId || activeId,
    conversationTitle: activeInfo?.summary || '',
    workspaceName: extractWorkspaceName(activeInfo?.workspaces),
    counts,
    currentTasks,
    globalRunningTasks,
    hookConfig: readHookConfig(),
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

// --- Hook configuration & lifecycle hook evaluation -------------------------

export function readHookConfig() {
  const defaults = {
    postInvocation: 'both',
    stop: true,
    antiPoll: true,
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const post = String(raw?.postInvocation || '').toLowerCase();
    return {
      postInvocation: VALID_POST_SCOPES.has(post) ? post : defaults.postInvocation,
      stop: typeof raw?.stop === 'boolean' ? raw.stop : defaults.stop,
      antiPoll: typeof raw?.antiPoll === 'boolean' ? raw.antiPoll : defaults.antiPoll,
    };
  } catch {
    return defaults;
  }
}

export function writeHookConfig(patch = {}) {
  const current = readHookConfig();
  const next = { ...current };
  if (patch && typeof patch === 'object') {
    if (patch.postInvocation !== undefined) {
      const candidate = String(patch.postInvocation || '').toLowerCase();
      if (VALID_POST_SCOPES.has(candidate)) {
        next.postInvocation = candidate;
      }
    }
    if (patch.stop !== undefined) {
      next.stop = Boolean(patch.stop);
    }
    if (patch.antiPoll !== undefined) {
      next.antiPoll = Boolean(patch.antiPoll);
    }
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Ignore write failure on read-only fs and return computed config.
  }
  return next;
}

function extractParentSubagentInvocations(convId) {
  const dbPath = resolveConversationDbPath(convId);
  const map = new Map();
  if (!dbPath || !existsSync(dbPath)) return map;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      'SELECT idx, status, metadata, step_payload FROM steps WHERE status = 3 ORDER BY idx ASC'
    ).all();
    for (const row of rows) {
      const meta = new WireMsg(row.metadata);
      const tc = meta.msg(4);
      const toolName = tc ? tc.str(2) : '';
      if (toolName !== 'invoke_subagent') continue;
      const payload = new WireMsg(row.step_payload);
      const outText = payload.msg(140)?.msg(2)?.str(1) || '';
      const match = SUBAGENT_CID_RE.exec(outText);
      if (!match) continue;
      const subId = match[1].toLowerCase();
      let args = null;
      try {
        args = JSON.parse(tc.str(3) || '{}');
      } catch {
        args = {};
      }
      map.set(subId, {
        conversationId: subId,
        role: String(args?.Role || '').trim(),
        typeName: String(args?.TypeName || '').trim(),
        invokeStep: Number(row.idx),
      });
    }
  } catch {
    // Ignore DB errors.
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return map;
}

export function findRunningSubagents(convId, initialNumSteps = null) {
  if (!UUID_RE.test(convId || '')) return [];
  const invokedMap = extractParentSubagentInvocations(convId);
  const summaryMap = new Map();

  if (existsSync(SUMMARIES_DB_PATH)) {
    let db;
    try {
      db = new DatabaseSync(SUMMARIES_DB_PATH, { readOnly: true });
      const rows = db.prepare(
        'SELECT conversation_id, agent_name, title, status, not_fully_idle, killed, step_count ' +
        'FROM conversation_summaries WHERE parent_conversation_id = ?'
      ).all(convId);
      for (const r of rows) {
        const sid = String(r.conversation_id || '').toLowerCase();
        if (UUID_RE.test(sid)) summaryMap.set(sid, r);
      }
    } catch {
      // Ignore DB errors.
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  const running = new Map();
  const minNewStep = initialNumSteps !== null && initialNumSteps !== undefined && Number.isFinite(Number(initialNumSteps))
    ? Number(initialNumSteps)
    : null;

  for (const [sid, r] of summaryMap.entries()) {
    const isKilled = Boolean(r.killed);
    if (isKilled) continue;
    const isRunning = r.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(r.not_fully_idle);
    if (isRunning) {
      const inv = invokedMap.get(sid);
      running.set(sid, {
        conversationId: sid,
        role: inv?.role || String(r.title || '').trim(),
        typeName: inv?.typeName || String(r.agent_name || '').trim(),
        invokeStep: inv?.invokeStep ?? null,
      });
    }
  }

  // Also cover subagents invoked in the current turn before conversation_summaries.db flushes.
  if (minNewStep !== null) {
    for (const [sid, inv] of invokedMap.entries()) {
      if (running.has(sid) || inv.invokeStep < minNewStep) continue;
      const sum = summaryMap.get(sid);
      if (sum && (Boolean(sum.killed) || (sum.status === 'CASCADE_RUN_STATUS_IDLE' && Number(sum.step_count) > 1))) {
        continue;
      }
      running.set(sid, inv);
    }
  }

  return Array.from(running.values());
}

const PURE_SLEEP_CMD_RE = /^\s*(?:sleep\s+\d+(?:\.\d+)?|python3?\s+-c\s+["']import\s+time\s*;\s*time\.sleep\([^)]+\)["'])\s*$/i;

function isStatusPollToolCall(toolName, args) {
  if (toolName === 'manage_subagents') {
    const act = String(args?.Action || 'list').toLowerCase();
    return act === 'list';
  }
  if (toolName === 'manage_task') {
    const act = String(args?.Action || '').toLowerCase();
    return act === 'list' || act === 'status';
  }
  return false;
}

function inspectConversationPollHistory(convId, maxScheduleStepIdx = null) {
  const dbPath = resolveConversationDbPath(convId);
  const result = {
    hasPlannerTurnAfterSchedule: false,
    isBackToBackStatusPoll: false,
  };
  if (!dbPath || !existsSync(dbPath)) return result;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if (maxScheduleStepIdx !== null && Number.isFinite(Number(maxScheduleStepIdx))) {
      const row = db.prepare(
        'SELECT 1 FROM steps WHERE idx > ? AND step_type = 15 LIMIT 1'
      ).get(Number(maxScheduleStepIdx));
      result.hasPlannerTurnAfterSchedule = Boolean(row);
    }

    // Check recent non-ephemeral steps to detect consecutive status polling without external wakeup.
    const recent = db.prepare(
      'SELECT idx, step_type, metadata FROM steps WHERE step_type != 90 ORDER BY idx DESC LIMIT 6'
    ).all();
    // Expected pattern when PreToolUse fires in a new turn right after a previous poll-only turn:
    // recent[0]: step_type=15 (current PLANNER_RESPONSE)
    // recent[1]: step_type=132 (previous GENERIC tool call)
    // recent[2]: step_type=15 (previous PLANNER_RESPONSE)
    let startIdx = 0;
    if (recent[0]?.step_type === 15) {
      startIdx = 1;
    }
    const prevStep = recent[startIdx];
    const prevPlanner = recent[startIdx + 1];
    if (prevStep?.step_type === 132 && prevPlanner?.step_type === 15) {
      const meta = new WireMsg(prevStep.metadata);
      const tc = meta.msg(4);
      const tname = tc ? tc.str(2) : '';
      let targs = {};
      try {
        targs = JSON.parse(tc?.str(3) || '{}');
      } catch {
        targs = {};
      }
      if (isStatusPollToolCall(tname, targs)) {
        result.isBackToBackStatusPoll = true;
      }
    }
  } catch {
    // Ignore DB errors.
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return result;
}

export async function evaluateLifecycleHook(eventType, payload = {}) {
  const convId = String(payload?.conversationId || '').trim().toLowerCase();
  if (!UUID_RE.test(convId)) {
    return eventType === 'PreToolUse' ? { decision: 'allow' } : {};
  }

  const config = readHookConfig();
  let scope = 'off';

  if (eventType === 'PreToolUse') {
    if (!config.antiPoll) return { decision: 'allow' };
    scope = config.postInvocation !== 'off' ? config.postInvocation : 'both';
  } else if (eventType === 'PostInvocation') {
    if (config.postInvocation === 'off' && !config.antiPoll) return {};
    scope = config.postInvocation !== 'off' ? config.postInvocation : 'both';
  } else if (eventType === 'Stop') {
    if (!config.stop) return {};
    const reason = String(payload?.terminationReason || 'NO_TOOL_CALL');
    if (reason !== 'NO_TOOL_CALL') return {};
    if (Number(payload?.executionNum || 1) > 3) return {};
    scope = config.postInvocation !== 'off' ? config.postInvocation : 'both';
  } else {
    return {};
  }

  // Fast check of live tasks from Language Server if credentials exist, plus local SQLite DB.
  const liveTaskSet = new Set();
  const liveSnaps = [];
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    try {
      const bgResp = await lsRequest('ListBackgroundTasks', {});
      const entries = Array.isArray(bgResp?.tasks) ? bgResp.tasks : [];
      for (const item of entries) {
        if (String(item?.conversationId || '').toLowerCase() !== convId || !item?.task) continue;
        const snap = item.task;
        const tid = snap.taskId || `${convId}/task-${snap.stepIndex ?? 0}`;
        liveTaskSet.add(tid);
        liveSnaps.push(snap);
      }
    } catch {
      // Fall back to SQLite steps table.
    }
  }

  const tasksMap = new Map();
  for (const t of readConversationTasksFromDb(convId, liveTaskSet, null)) {
    tasksMap.set(t.taskId, t);
  }
  for (const snap of liveSnaps) {
    const tid = snap.taskId || `${convId}/task-${snap.stepIndex ?? 0}`;
    if (!tasksMap.has(tid)) {
      tasksMap.set(tid, snapshotToTask(convId, snap, null, null));
    }
  }

  const allTasks = Array.from(tasksMap.values());
  const activeSchedules = allTasks.filter((t) => t.state === 'running' && t.kind === 'schedule');
  const hasActiveSchedule = activeSchedules.length > 0;

  // --- 1. PreToolUse Anti-Poll Guard ---
  if (eventType === 'PreToolUse') {
    const toolName = String(payload?.toolCall?.name || '').trim();
    const args = payload?.toolCall?.args || {};

    if (toolName === 'schedule') {
      const activeTimers = activeSchedules.filter((s) => !s.isDaemon);
      if (activeTimers.length > 0 && !args?.IsDaemon) {
        const schedLabels = activeTimers.map((s) => `#${s.stepIndex}`).join(', ');
        return {
          decision: 'deny',
          reason:
            `[Background Tasks Monitor] 监控计时器 (${schedLabels}) 已在运行中。` +
            '严禁重复调用 schedule 设置计时器（否则将触发 TimerCondition 互斥冲突报错）！' +
            '请仅用纯文本向用户简短说明进度后直接结束当前回合（不要调用任何工具），等待已有计时器或完成通知唤醒。',
        };
      }
      return { decision: 'allow' };
    }

    if (toolName === 'run_command') {
      const cmdLine = String(args?.CommandLine || '');
      if (PURE_SLEEP_CMD_RE.test(cmdLine)) {
        return {
          decision: 'deny',
          reason:
            '[Background Tasks Monitor] 严禁使用 shell sleep 命令作为计时器或等待手段。' +
            '请改用 schedule 工具设置定期监控计时器，并在设置后直接结束当前回合等待唤醒。',
        };
      }
      return { decision: 'allow' };
    }

    if (isStatusPollToolCall(toolName, args)) {
      const maxSchedStep = hasActiveSchedule
        ? Math.max(...activeSchedules.map((s) => Number(s.stepIndex || 0)))
        : null;
      const pollHist = inspectConversationPollHistory(convId, maxSchedStep);

      if (hasActiveSchedule && pollHist.hasPlannerTurnAfterSchedule) {
        const schedLabels = activeSchedules.map((s) => `#${s.stepIndex}`).join(', ');
        return {
          decision: 'deny',
          reason:
            `[Background Tasks Monitor] 监控计时器 (${schedLabels}) 已在运行中。` +
            `严禁在计时器触发前额外调用 ${toolName} 轮询状态！请直接结束当前回合（不要调用任何工具），等待计时器或完成通知唤醒。`,
        };
      }

      if (pollHist.isBackToBackStatusPoll) {
        return {
          decision: 'deny',
          reason:
            `[Background Tasks Monitor] 检测到连续多回合重复调用 ${toolName} 空转轮询。` +
            '若后台任务或子智能体仍在运行，请立即调用 schedule 工具设置定期监控计时器并在下一回合直接结束等待唤醒，严禁无计时器连续轮询。',
        };
      }
    }

    return { decision: 'allow' };
  }

  // --- 2. Active Schedule Already Running ---
  if (hasActiveSchedule) {
    if (eventType === 'PostInvocation' && config.antiPoll) {
      const minNewStep = Number(payload?.initialNumSteps);
      const justScheduled = Number.isFinite(minNewStep) &&
        activeSchedules.some((s) => Number(s.stepIndex) >= minNewStep);
      if (justScheduled) {
        const schedLabels = activeSchedules.map((s) => `#${s.stepIndex}`).join(', ');
        return {
          injectSteps: [
            {
              ephemeralMessage:
                `[Background Tasks Monitor] 监控计时器 (${schedLabels}) 已启动。` +
                '若当前无其他独立的实质开发任务，请仅用纯文本简短回复用户后直接结束本回合（不要调用任何工具），' +
                '严禁在计时器启动后再次调用 schedule（否则将触发 TimerCondition 互斥冲突报错）或调用 manage_subagents / manage_task 查看状态（否则将阻断休眠进入空转轮询）。',
            },
          ],
        };
      }
    }
    return {};
  }

  if (eventType === 'PostInvocation' && config.postInvocation === 'off') {
    return {};
  }

  // --- 3. No Active Schedule -> Check Monitored Background Targets ---
  const checkCmd = scope === 'command' || scope === 'both';
  const checkSub = scope === 'subagent' || scope === 'both';

  const runningCommands = checkCmd
    ? allTasks.filter((t) => t.state === 'running' && t.kind === 'command' && !t.isDaemon)
    : [];
  const runningSubagents = checkSub
    ? findRunningSubagents(convId, eventType === 'PostInvocation' ? payload?.initialNumSteps : null)
    : [];

  if (runningCommands.length === 0 && runningSubagents.length === 0) {
    return {};
  }

  const parts = [];
  for (const cmd of runningCommands) {
    parts.push(`后台命令 #${cmd.stepIndex} (${cmd.summary})`);
  }
  for (const sub of runningSubagents) {
    const label = sub.role || sub.typeName || sub.conversationId.slice(0, 8);
    parts.push(`子智能体 [${label}] (${sub.conversationId.slice(0, 8)})`);
  }
  const targetDesc = parts.join('、');

  if (eventType === 'PostInvocation') {
    return {
      injectSteps: [
        {
          ephemeralMessage:
            `[Background Tasks Monitor] 检测到当前存在运行中的 ${targetDesc}，但尚未设置活跃的 schedule 定期监控计时器。` +
            '请向用户简短汇报当前进度并调用 schedule 工具设置定期监控计时器（如设置 DurationSeconds 与 TimerCondition: "any"）；' +
            '若需先查询状态，可在同一回合内并行调用状态检查工具与 schedule，但一旦 schedule 启动返回，下一回合必须仅输出文本并直接结束（严禁再次调用 schedule 或状态查询工具）。',
        },
      ],
    };
  }

  return {
    decision: 'continue',
    reason:
      `[Background Tasks Monitor] 当前仍有正在运行的 ${targetDesc}，但尚未调用 schedule 工具设置定期监控计时器。` +
      '请先向用户简短说明进度并调用 schedule 设置定期监控计时器，随后直接结束回合等待唤醒。',
  };
}

export async function runLifecycleHook(eventType) {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw && raw.trim()) {
      payload = JSON.parse(raw);
    }
  } catch {
    payload = {};
  }
  try {
    const out = await evaluateLifecycleHook(eventType, payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write(eventType === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n');
  }
}

export function fetchTaskLog(conversationId, stepIndex, requestedTailBytes = DEFAULT_TAIL_BYTES) {
  if (!UUID_RE.test(conversationId || '')) {
    return { error: 'invalid-conversation-id', message: 'Invalid conversationId UUID' };
  }
  const idx = Number(stepIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return { error: 'invalid-step-index', message: 'Invalid stepIndex' };
  }
  const tailBytes = Math.min(
    MAX_TAIL_BYTES,
    Math.max(4096, Number(requestedTailBytes) || DEFAULT_TAIL_BYTES)
  );

  let logUri = '';
  let dbFallbackOutput = '';
  const dbPath = resolveConversationDbPath(conversationId);
  if (dbPath && existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare(
        'SELECT task_details, step_payload FROM steps WHERE idx = ? AND task_details IS NOT NULL'
      );
      const row = stmt.get(idx);
      if (row) {
        const td = new WireMsg(row.task_details);
        logUri = td.str(2) || '';
        const snippet = td.str(3) || '';
        const payload = new WireMsg(row.step_payload);
        const genericMsg = payload.msg(140);
        const resultMsg = genericMsg ? genericMsg.msg(2) : null;
        const payloadText = resultMsg ? resultMsg.str(1) : '';
        dbFallbackOutput = normalizeTerminalOutput(snippet || payloadText);
      }
    } catch {
      // Ignore DB errors and fall back to canonical sandboxed log file path.
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  const logPath = resolveSandboxedTaskLogPath(conversationId, idx, logUri);
  const logData = readTailFromFile(logPath, tailBytes);
  const content = logData.exists && logData.totalBytes > 0 ? logData.content : dbFallbackOutput;
  const totalBytes = logData.exists && logData.totalBytes > 0
    ? logData.totalBytes
    : Buffer.byteLength(dbFallbackOutput, 'utf8');

  return {
    conversationId,
    stepIndex: idx,
    content,
    totalBytes,
    truncated: logData.truncated,
    source: logData.exists && logData.totalBytes > 0 ? 'logfile' : (dbFallbackOutput ? 'database' : 'empty'),
    updatedAt: new Date().toISOString(),
  };
}

// --- Sidecar HTTP server & CLI self-check -----------------------------------

const isMain = Boolean(
  process.argv[1] && (
    process.platform === 'win32'
      ? fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
      : fileURLToPath(import.meta.url) === resolve(process.argv[1])
  )
);

if (isMain && process.argv.includes('--check')) {
  const cidIdx = process.argv.indexOf('--check') + 1;
  const cid = process.argv[cidIdx] || '';
  const report = await fetchTasksReport(cid);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (isMain && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    headers: SECURITY_HEADERS,
  }));

  app.page('/app.js', () => new Response(readFileSync(join(HERE, 'app.js'), 'utf8'), {
    contentType: 'application/javascript; charset=utf-8',
    headers: SECURITY_HEADERS,
  }));

  app.api('/api/tasks', async (data) => {
    try {
      const result = await fetchTasksReport(data?.conversationId, data?.targetId);
      return new Response(JSON.stringify(result), {
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'failed', message: err.message }), {
        status: 500,
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    }
  }, 'GET');

  app.api('/api/log', async (data) => {
    try {
      const result = fetchTaskLog(data?.conversationId, data?.stepIndex, data?.tailBytes);
      const status = result.error ? 400 : 200;
      return new Response(JSON.stringify(result), {
        status,
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'failed', message: err.message }), {
        status: 500,
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    }
  }, 'GET');

  app.api('/api/config', async () => {
    return new Response(JSON.stringify({ ok: true, hookConfig: readHookConfig() }), {
      contentType: 'application/json; charset=utf-8',
      headers: SECURITY_HEADERS,
    });
  }, 'GET');

  app.api('/api/config', async (data) => {
    try {
      const next = writeHookConfig(data || {});
      return new Response(JSON.stringify({ ok: true, hookConfig: next }), {
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        contentType: 'application/json; charset=utf-8',
        headers: SECURITY_HEADERS,
      });
    }
  }, 'POST');

  app.run();
}

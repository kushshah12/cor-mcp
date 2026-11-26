// U1 (plan 2026-10-13-001): anonymous usage metrics. Off unless a PostHog key was injected at build time
// (tsup define, see tsup.config.js) and COR_TELEMETRY is not "off". Events are built from allow-lists only, and
// sending never throws or blocks a tool call.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Replaced at build time by tsup `define`. Unbundled runs (tests, dev) see the empty fallbacks, so nothing is sent.
const BUILD_KEY = typeof __COR_POSTHOG_KEY__ !== 'undefined' ? __COR_POSTHOG_KEY__ : '';
const BUILD_HOST = typeof __COR_POSTHOG_HOST__ !== 'undefined' ? __COR_POSTHOG_HOST__ : '';

const OUTCOMES = ['ok', 'tool_error', 'exception', 'timeout'];
const SEND_TIMEOUT_MS = 2000;

// COR_OFFLINE=true stops all outbound data, the same switch @corlabs/client honours.
export function resolveConfig(env = process.env, { key = BUILD_KEY, host = BUILD_HOST } = {}) {
  const off = env.COR_TELEMETRY === 'off' || env.COR_OFFLINE === 'true';
  return { enabled: !off && Boolean(key) && Boolean(host), key, host };
}

/** The anonymous install ID under `dir`. `created` is true only when this call wrote it (the first run). Never throws. */
export function installId(dir = join(homedir(), '.cor')) {
  const file = join(dir, 'install-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return { id: existing, created: false };
  } catch {
    // no file yet — create it below
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, id, { flag: 'wx' });
    return { id, created: true };
  } catch {
    // unwritable, or another process won the race: this run's id is not persisted
    return { id, created: false };
  }
}

// Each builder returns { event, properties } with only the allow-listed fields, or null when the input is not allowed.

export function installedEvent({ version, node = process.version, platform = process.platform }) {
  return { event: 'mcp_installed', properties: { version, node, platform } };
}

// PostHog MCP Analytics schema (posthog.com/docs/mcp-analytics/installation/other-languages): `$mcp_source` must be
// this value or the event is ignored. Parameters, responses and intent are never sent (R4).
const MCP_SOURCE = 'posthog_mcp_analytics';
export const SERVER_NAME = '@corlabsdev/mcp';
const ERROR_TYPES = ['validation', 'missing_context', 'timeout', 'internal', 'Error'];

/** `ses_<UUIDv7>`, the session id MCP Analytics expects for stdio servers. */
export function sessionId(now = Date.now()) {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `ses_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Low-cardinality error label from a thrown error. The message is read here and never sent.
 * ponytail: message regexes over COR's own error text; move to typed errors if the labels drift.
 */
export function errorType(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  const m = String(err?.message ?? '');
  if (/no page is open|no snapshot is current|is stale/i.test(m)) return 'missing_context';
  if (/^pass |not gradable|not a valid|exactly one of/i.test(m)) return 'validation';
  return 'internal';
}

/** Session-wide properties shared by `$mcp_initialize` and every `$mcp_tool_call`. */
function sessionProps(ctx = {}) {
  return {
    $session_id: ctx.sessionId,
    $mcp_client_name: clean(ctx.clientName),
    $mcp_client_version: clean(ctx.clientVersion),
    source: normalizeSource(ctx.source),
    ci: ctx.ci === true,
    container: ctx.container === true,
  };
}

export function toolCalledEvent({ tool, durationMs, outcome, version, error, ctx }, registeredNames) {
  if (!registeredNames.includes(tool)) return null;
  if (!OUTCOMES.includes(outcome)) return null;
  if (!Number.isInteger(durationMs) || durationMs < 0) return null;
  const properties = {
    $mcp_source: MCP_SOURCE,
    $mcp_tool_name: tool,
    $mcp_is_error: outcome !== 'ok',
    $mcp_duration_ms: durationMs,
    $mcp_server_name: SERVER_NAME,
    $mcp_server_version: version,
    ...sessionProps(ctx),
    outcome,
    version,
  };
  if (outcome !== 'ok') {
    const type = ERROR_TYPES.includes(error) ? error : outcome === 'tool_error' ? 'Error' : 'internal';
    properties.$mcp_error_type = type;
    properties.$mcp_error_message = type; // ponytail: the label, never the raw text (it can hold URLs and selectors)
  }
  return { event: '$mcp_tool_call', properties };
}

// U1 (plan 2026-11-24-002): where an install came from. Set by `--source` in the client config (setup, listings, Lens).
export const SOURCES = ['setup', 'lens', 'smithery', 'glama', 'pulsemcp', 'cursor', 'mcpso', 'awesome', 'readme'];

export function normalizeSource(value) {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const v = value.trim().toLowerCase();
  return SOURCES.includes(v) ? v : 'other';
}

// U1: coarse booleans that let the funnel drop automated starts. No env values, hostnames or paths are sent.
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'JENKINS_URL'];

export function envFlags(env = process.env, exists = existsSync) {
  const ci = CI_VARS.some((k) => env[k] && env[k] !== 'false' && env[k] !== '0');
  let container = false;
  try {
    container = exists('/.dockerenv');
  } catch {
    // unreadable: assume not a container
  }
  return { ci, container };
}

// Client-reported strings: printable ASCII only, at most 64 characters.
function clean(value) {
  return typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '').slice(0, 64) : '';
}

export function sessionStartedEvent({ version, ...ctx }) {
  return {
    event: '$mcp_initialize',
    properties: { $mcp_source: MCP_SOURCE, $mcp_server_name: SERVER_NAME, $mcp_server_version: version, ...sessionProps(ctx), version },
  };
}

export const FIRST_RUN_NOTICE = 'COR sends anonymous usage metrics (tool names, timings, outcomes). Turn off with COR_TELEMETRY=off. Details: README.\n';

/**
 * U3: on the first run of an install, send mcp_installed and say so on stderr (stdout carries the protocol).
 * Does nothing on later runs, or when telemetry is off (installCreated is only true when it is on).
 */
export function announceFirstRun(telemetry, { version, stderr = process.stderr }) {
  if (!telemetry.installCreated) return;
  telemetry.track(installedEvent({ version }));
  stderr.write(FIRST_RUN_NOTICE);
}

/**
 * The sender for one server process. `track` takes a builder's output and returns nothing; it never throws.
 * `installCreated` tells the caller whether this is the first run for the install.
 */
export function createTelemetry({ env = process.env, key, host, dir, fetchImpl = globalThis.fetch } = {}) {
  const cfg = resolveConfig(env, { key, host });
  const { id, created } = cfg.enabled ? installId(dir) : { id: '', created: false };
  const url = cfg.enabled ? `${cfg.host.replace(/\/+$/, '')}/capture/` : '';

  function track(built) {
    if (!cfg.enabled || !built) return;
    try {
      const body = JSON.stringify({
        api_key: cfg.key,
        event: built.event,
        distinct_id: id,
        properties: built.properties,
        timestamp: (built.timestamp ?? new Date()).toISOString(), // MCP Analytics: when the request started
      });
      fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).catch(() => {});
    } catch {
      // telemetry must never affect a tool call
    }
  }

  return { enabled: cfg.enabled, installCreated: created, track };
}

// U1 (plan 2026-10-13-001): anonymous usage metrics. Off unless a PostHog key was injected at build time
// (tsup define, see tsup.config.js) and COR_TELEMETRY is not "off". Events are built from allow-lists only, and
// sending never throws or blocks a tool call.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function toolCalledEvent({ tool, durationMs, outcome, version }, registeredNames) {
  if (!registeredNames.includes(tool)) return null;
  if (!OUTCOMES.includes(outcome)) return null;
  if (!Number.isInteger(durationMs) || durationMs < 0) return null;
  return { event: 'mcp_tool_called', properties: { tool, duration_ms: durationMs, outcome, version } };
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
        timestamp: new Date().toISOString(),
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

import { appendFile } from 'node:fs/promises';
import { defaults } from './config.js';

export function formatDuration(ms) {
  const span = new Date(ms);
  const hours = span.getUTCHours();
  const minutes = span.getUTCMinutes();
  const seconds = span.getUTCSeconds();
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export const rules = [
  {
    id: 'overheat',
    severity: 'crit',
    test: (r) => r.tempC !== null && r.tempC > 45,
    text: (r) => `temperature ${r.tempC.toFixed(1)} °C`,
  },
  {
    id: 'probe-dead',
    severity: 'warn',
    test: (r) => r.tempC === null,
    text: () => 'temperature probe gives no value',
  },
  {
    id: 'low-battery',
    severity: 'warn',
    test: (r) => r.batteryV < 3.3,
    text: (r) => `battery at ${r.batteryV.toFixed(2)} V`,
  },
  {
    id: 'stale',
    severity: 'warn',
    test: (r, now) => now - r.takenAt > defaults.staleAfterMs,
    text: (r, now) => `no reading for ${formatDuration(now - r.takenAt)}`,
  },
];

export function evaluate(readings, now = Date.now()) {
  const alerts = [];
  for (const reading of readings) {
    for (const rule of rules) {
      if (!rule.test(reading, now)) continue;
      alerts.push({
        at: now,
        stationId: reading.stationId,
        rule: rule.id,
        severity: rule.severity,
        text: rule.text(reading, now),
      });
    }
  }
  return alerts;
}

// One line per station that has alerts: "st-04: overheat, low-battery".
export function summarize(alerts) {
  const byStation = alerts.reduce((groups, alert) => {
    (groups[alert.stationId] ??= []).push(alert);
    return groups;
  }, {});
  return Object.entries(byStation).map(
    ([stationId, list]) => `${stationId}: ${list.map((a) => a.rule).join(', ')}`,
  );
}

export async function writeAlerts(file, alerts) {
  if (alerts.length === 0) return;
  await appendFile(file, alerts.map((a) => JSON.stringify(a)).join('\n') + '\n');
}

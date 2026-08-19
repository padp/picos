import React, { useState } from 'react';
import usePressUptime from './usePressUptime';

// RUNNING and the muted "no data" cases are fixed status colors; each
// downtime reason gets its own categorical hue so the stacked bar and
// legend agree everywhere reasons appear. Kept in one place so the state
// badge and the uptime bar never drift apart.
const RUNNING_COLOR = '#0ca30c';
const NO_DATA_COLOR = '#c3c2b7';
const REASON_COLORS = {
  Emergency: '#d03b3b',
  'Die Change': '#2a78d6',
  Setup: '#eb6834',
  Manual: '#eda100',
  Unspecified: '#898781',
};

const WINDOW_OPTIONS = [
  { label: '1h', hours: 1 },
  { label: '8h', hours: 8 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
];

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const total = Math.max(Math.round(seconds), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

function formatClock(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function getStateBadge(state, reason) {
  if (state === 'RUNNING') return { label: 'Running', color: RUNNING_COLOR };
  if (state === 'IDLE') {
    const label = reason || 'Idle';
    return { label, color: REASON_COLORS[reason] || REASON_COLORS.Unspecified };
  }
  return { label: reason === 'Stale Data' ? 'No Data' : 'Unknown', color: NO_DATA_COLOR };
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value === undefined || value === null || value === '' ? '—' : value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function UptimeBar({ uptime }) {
  if (!uptime) return null;

  const segments = [];
  if (uptime.uptime_seconds > 0) {
    segments.push({ label: 'Uptime', seconds: uptime.uptime_seconds, color: RUNNING_COLOR });
  }
  Object.entries(uptime.downtime_by_reason || {}).forEach(([reason, seconds]) => {
    if (seconds > 0) {
      segments.push({ label: reason, seconds, color: REASON_COLORS[reason] || REASON_COLORS.Unspecified });
    }
  });
  if (uptime.unknown_seconds > 0) {
    segments.push({ label: 'No Data', seconds: uptime.unknown_seconds, color: NO_DATA_COLOR });
  }

  const total = segments.reduce((sum, seg) => sum + seg.seconds, 0);
  if (total === 0) {
    return <p className="uptime-bar-empty">No coverage yet for this window.</p>;
  }

  return (
    <div>
      <div className="uptime-bar" role="img" aria-label="Uptime vs downtime breakdown">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className="uptime-bar-segment"
            style={{ width: `${(seg.seconds / total) * 100}%`, backgroundColor: seg.color }}
            title={`${seg.label}: ${formatDuration(seg.seconds)} (${((seg.seconds / total) * 100).toFixed(1)}%)`}
          />
        ))}
      </div>
      <div className="uptime-legend">
        {segments.map((seg) => (
          <div className="uptime-legend-item" key={seg.label}>
            <span className="uptime-legend-swatch" style={{ backgroundColor: seg.color }} />
            <span className="uptime-legend-label">{seg.label}</span>
            <span className="uptime-legend-value">
              {formatDuration(seg.seconds)} ({((seg.seconds / total) * 100).toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BilletsTable({ billets }) {
  if (!billets || billets.length === 0) {
    return <p>No billet cycles recorded yet.</p>;
  }
  return (
    <div className="billets-table-wrap">
      <table className="billets-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Billet</th>
            <th>Job #</th>
            <th>Alloy</th>
            <th>Length (in)</th>
            <th>Extrusion (s)</th>
            <th>Cycle (s)</th>
            <th>Peak Force (UST)</th>
          </tr>
        </thead>
        <tbody>
          {billets.map((b) => (
            <tr key={b.billet_key}>
              <td>{formatClock(b.ts)}</td>
              <td>
                {b.billet_number_per_order ?? '—'}
                {b.scheduled_billets ? ` / ${b.scheduled_billets}` : ''}
              </td>
              <td>{b.job_number || '—'}</td>
              <td>{b.alloy_name || '—'}</td>
              <td>{formatNumber(b.billet_length_actual_in, 2)}</td>
              <td>{formatNumber(b.extrusion_time_s, 0)}</td>
              <td>{formatNumber(b.cycle_duration_s, 0)}</td>
              <td>{formatNumber(b.extrusion_force_peak_ust, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PressUptimeView({ onBackToDefault }) {
  const [windowHours, setWindowHours] = useState(24);
  const { status, uptime, billets, isLoading, error } = usePressUptime(windowHours);

  const badge = uptime ? getStateBadge(uptime.current_state, uptime.current_reason) : null;

  return (
    <div className="container">
      <div className="default-view-header">
        <h1>Press Billet Cycles &amp; Uptime</h1>
        <button className="secondary-button" onClick={onBackToDefault}>
          &larr; Live Data
        </button>
      </div>

      {isLoading && !uptime ? (
        <p>Loading press history…</p>
      ) : error && !uptime ? (
        <p>Could not reach the press API.</p>
      ) : (
        <>
          {badge && (
            <div className="status-badge" style={{ backgroundColor: badge.color }}>
              {badge.label}
              {uptime.current_state_since ? ` since ${formatClock(uptime.current_state_since)}` : ''}
            </div>
          )}

          {status && status.stalled && (
            <div className="stall-banner">
              ⚠ Press is in Automatic but hasn't completed a billet in{' '}
              {formatDuration(status.seconds_since_last_billet)} — possible stall.
            </div>
          )}

          <div className="window-picker">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                className={opt.hours === windowHours ? 'window-picker-btn active' : 'window-picker-btn'}
                onClick={() => setWindowHours(opt.hours)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="stat-grid">
            <StatCard label="Uptime" value={uptime && uptime.uptime_pct !== null ? `${uptime.uptime_pct}%` : '—'} />
            <StatCard label="Uptime Total" value={uptime ? formatDuration(uptime.uptime_seconds) : '—'} />
            <StatCard label="Downtime Total" value={uptime ? formatDuration(uptime.downtime_seconds) : '—'} />
            <StatCard
              label="Last Billet"
              value={status && status.latest_billet ? `#${status.latest_billet.billet_number_per_order}` : '—'}
              sub={status ? `${formatDuration(status.seconds_since_last_billet)} ago` : undefined}
            />
          </div>

          <h3>Uptime vs Downtime</h3>
          <UptimeBar uptime={uptime} />

          <h3>Recent Billets</h3>
          <BilletsTable billets={billets} />
        </>
      )}
    </div>
  );
}

export default PressUptimeView;

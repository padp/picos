import React, { useState, useEffect, useMemo } from 'react';
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

// Production-cycle breakdown (billet_monitor.py's gap classification, see
// its module docstring): only Stoppage is a real problem, so it's the one
// status-red segment - everything else (extrusion itself, and the three
// *expected* reasons a billet isn't extruding) gets a distinct, calmer hue
// so "how much red is there" answers the question at a glance.
const CYCLE_COLORS = {
  Extrusion: '#0ca30c',
  'Dead Cycle': '#2a78d6',
  Cleanout: '#4a3aa7',
  'Die Change': '#eb6834',
  Startup: '#898781',
  Stoppage: '#d03b3b',
};

// Chronological order for a given label-date: Third Shift starts the
// PREVIOUS evening but is labeled with the date its early-morning half
// falls on (matches app.py's _current_date_and_shift exactly), so within
// one label-date it actually runs first.
const SHIFT_SEQUENCE = ['Third Shift', 'First Shift', 'Second Shift'];

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shiftStep(dateStr, shift, direction) {
  const idx = SHIFT_SEQUENCE.indexOf(shift);
  let newIdx = idx + direction;
  let newDate = dateStr;
  if (newIdx < 0) {
    newIdx = SHIFT_SEQUENCE.length - 1;
    newDate = addDays(dateStr, -1);
  } else if (newIdx >= SHIFT_SEQUENCE.length) {
    newIdx = 0;
    newDate = addDays(dateStr, 1);
  }
  return { date: newDate, shift: SHIFT_SEQUENCE[newIdx] };
}

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

function StatCard({ label, value, sub, onClick, expanded }) {
  const clickable = !!onClick;
  return (
    <div
      className={clickable ? 'stat-card stat-card-clickable' : 'stat-card'}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="stat-label">
        {label}
        {clickable ? (expanded ? ' ▲' : ' ▼') : ''}
      </div>
      <div className="stat-value">{value === undefined || value === null || value === '' ? '—' : value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ShiftPicker({ date, shift, isCurrent, onNavigate, onJumpToCurrent }) {
  return (
    <div className="shift-picker">
      <button className="secondary-button" onClick={() => onNavigate(-1)} aria-label="Previous shift">
        &larr;
      </button>
      <div className="shift-picker-label">
        <strong>{shift || '—'}</strong>
        {date ? ` · ${date}` : ''}
        {isCurrent && <span className="shift-picker-live"> (current)</span>}
      </div>
      <button className="secondary-button" onClick={() => onNavigate(1)} aria-label="Next shift">
        &rarr;
      </button>
      {!isCurrent && (
        <button className="secondary-button" onClick={onJumpToCurrent}>
          Current Shift
        </button>
      )}
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
    return <p className="uptime-bar-empty">No coverage yet for this shift.</p>;
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

function CycleBreakdownBar({ breakdown }) {
  if (!breakdown) return null;

  const segments = [
    { label: 'Extrusion', seconds: breakdown.extrusion_s },
    { label: 'Dead Cycle', seconds: breakdown.dead_cycle_s },
    { label: 'Cleanout', seconds: breakdown.cleanout_s },
    { label: 'Die Change', seconds: breakdown.die_change_s },
    { label: 'Startup', seconds: breakdown.startup_s },
    { label: 'Stoppage', seconds: breakdown.stoppage_total_s },
  ]
    .filter((seg) => seg.seconds > 0)
    .map((seg) => ({ ...seg, color: CYCLE_COLORS[seg.label] }));

  const total = segments.reduce((sum, seg) => sum + seg.seconds, 0);
  if (total === 0) {
    return <p className="uptime-bar-empty">No billets recorded yet for this shift.</p>;
  }

  return (
    <div>
      <div className="uptime-bar" role="img" aria-label="Production cycle breakdown">
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

function gapTag(b) {
  // Precedence matches billet_monitor.py's own classification order
  // (startup > cleanout > die change > baselined normal/stoppage).
  if (b.is_startup) return { label: 'Startup', color: CYCLE_COLORS.Startup };
  if (b.is_cleanout) return { label: 'Cleanout', color: CYCLE_COLORS.Cleanout };
  if (b.is_die_change) return { label: 'Die Change', color: CYCLE_COLORS['Die Change'] };
  if (b.stoppage_s > 0) return { label: 'Stoppage', color: CYCLE_COLORS.Stoppage };
  if (b.gap_before_s !== undefined && b.gap_before_s !== null) return { label: 'Normal', color: CYCLE_COLORS['Dead Cycle'] };
  return null; // pre-dates this classification
}

function StoppagesTable({ stoppages }) {
  if (!stoppages || stoppages.length === 0) {
    return <p>No unexplained stoppages this shift.</p>;
  }
  return (
    <div className="billets-table-wrap">
      <table className="billets-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Profile</th>
            <th>Die</th>
            <th>Job #</th>
            <th>Billet #</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {stoppages.map((s, i) => (
            <tr key={`${s.ts}-${i}`}>
              <td>{formatClock(s.ts)}</td>
              <td>{s.profile || '—'}</td>
              <td>{s.die_copy ?? '—'}</td>
              <td>{s.job_number || '—'}</td>
              <td>{s.billet_number_per_order ?? '—'}</td>
              <td>{formatDuration(s.total_stoppage_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BILLET_FILTER_COLUMNS = [
  { key: 'job_number', label: 'Job #', getValue: (b) => b.job_number },
  { key: 'die_copy', label: 'Die', getValue: (b) => (b.die_copy === undefined || b.die_copy === null ? null : String(b.die_copy)) },
  { key: 'alloy_name', label: 'Alloy', getValue: (b) => b.alloy_name },
  { key: 'gapType', label: 'Gap type', getValue: (b) => { const tag = gapTag(b); return tag ? tag.label : null; } },
];

const ALL_FILTER = 'All';

function BilletsTable({ billets }) {
  const [filters, setFilters] = useState({});

  const filterOptions = useMemo(() => {
    const options = {};
    BILLET_FILTER_COLUMNS.forEach(({ key, getValue }) => {
      const values = new Set();
      (billets || []).forEach((b) => {
        const v = getValue(b);
        if (v !== null && v !== undefined && v !== '') values.add(v);
      });
      options[key] = Array.from(values).sort();
    });
    return options;
  }, [billets]);

  const filteredBillets = useMemo(() => {
    return (billets || []).filter((b) =>
      BILLET_FILTER_COLUMNS.every(({ key, getValue }) => {
        const active = filters[key];
        if (!active || active === ALL_FILTER) return true;
        return getValue(b) === active;
      })
    );
  }, [billets, filters]);

  const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearFilters = () => setFilters({});
  const activeFilterCount = Object.values(filters).filter((v) => v && v !== ALL_FILTER).length;

  if (!billets || billets.length === 0) {
    return <p>No billet cycles recorded yet.</p>;
  }

  return (
    <div>
      <div className="table-filters">
        {BILLET_FILTER_COLUMNS.map(({ key, label }) => (
          <label className="table-filter" key={key}>
            {label}
            <select value={filters[key] || ALL_FILTER} onChange={(e) => setFilter(key, e.target.value)}>
              <option value={ALL_FILTER}>All</option>
              {filterOptions[key].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
        {activeFilterCount > 0 && (
          <button className="secondary-button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>
      {activeFilterCount > 0 && (
        <p className="stat-sub">
          Showing {filteredBillets.length} of {billets.length} billets.
        </p>
      )}
      {filteredBillets.length === 0 ? (
        <p>No billets match these filters.</p>
      ) : (
      <div className="billets-table-wrap">
        <table className="billets-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Billet</th>
              <th>Job #</th>
              <th>Die</th>
              <th>Alloy</th>
              <th>Length (in)</th>
              <th>Extrusion (s)</th>
              <th>Gap (s)</th>
              <th>Gap type</th>
              <th>Peak Force (UST)</th>
            </tr>
          </thead>
          <tbody>
          {filteredBillets.map((b) => {
            const tag = gapTag(b);
            const stallNote = b.in_billet_stall_s > 0 ? ` (+${formatNumber(b.in_billet_stall_s, 0)}s mid-stall)` : '';
            return (
              <tr key={b.billet_key}>
                <td>{formatClock(b.ts)}</td>
                <td>
                  {b.billet_number_per_order ?? '—'}
                  {b.scheduled_billets ? ` / ${b.scheduled_billets}` : ''}
                </td>
                <td>{b.job_number || '—'}</td>
                <td>{b.die_copy ?? '—'}</td>
                <td>{b.alloy_name || '—'}</td>
                <td>{formatNumber(b.billet_length_actual_in, 2)}</td>
                <td>{formatNumber(b.extrusion_duration_s ?? b.extrusion_time_s, 0)}</td>
                <td>
                  {formatNumber(b.gap_before_s, 0)}
                  {stallNote}
                </td>
                <td>
                  {tag ? (
                    <span className="gap-tag" style={{ backgroundColor: tag.color }}>
                      {tag.label}
                    </span>
                  ) : '—'}
                </td>
                <td>{formatNumber(b.extrusion_force_peak_ust, 0)}</td>
              </tr>
            );
          })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

function PressUptimeView({ onBackToDefault }) {
  const [shiftParams, setShiftParams] = useState(null); // null = let the server pick the current shift
  const [showStoppages, setShowStoppages] = useState(false);
  const { status, uptime, breakdown, billets, stoppages, isLoading, error } = usePressUptime(shiftParams);

  // Captures the server's current-shift resolution once, so Prev/Next has
  // a concrete (date, shift) to step from even before the user has picked
  // one explicitly. Deliberately does NOT keep re-syncing after that - once
  // a shift is selected (by this or by explicit navigation) the view stays
  // pinned to it rather than jumping to a new "current" shift out from
  // under the user as real time crosses a shift boundary.
  useEffect(() => {
    if (!shiftParams && uptime && uptime.date && uptime.shift) {
      setShiftParams({ date: uptime.date, shift: uptime.shift });
    }
  }, [shiftParams, uptime]);

  const badge = uptime ? getStateBadge(uptime.current_state, uptime.current_reason) : null;
  const accounted = breakdown ? breakdown.accounted_seconds : null;
  const extrusionPct = breakdown && accounted ? (breakdown.extrusion_s / accounted) * 100 : null;
  const stoppagePct = breakdown && accounted ? (breakdown.stoppage_total_s / accounted) * 100 : null;

  const handleNavigate = (direction) => {
    const base = shiftParams || (uptime ? { date: uptime.date, shift: uptime.shift } : null);
    if (!base) return;
    setShiftParams(shiftStep(base.date, base.shift, direction));
  };

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
              ⚠ No billet completed in {formatDuration(status.seconds_since_last_billet)}
              {status.expected_gap_s
                ? ` — this profile/die normally goes about ${formatDuration(status.expected_gap_s)} between billets`
                : ''}{' '}
              — possible stoppage.
            </div>
          )}

          <ShiftPicker
            date={shiftParams ? shiftParams.date : uptime && uptime.date}
            shift={shiftParams ? shiftParams.shift : uptime && uptime.shift}
            isCurrent={shiftParams === null}
            onNavigate={handleNavigate}
            onJumpToCurrent={() => setShiftParams(null)}
          />

          <div className="stat-grid">
            <StatCard label="Extruding" value={extrusionPct !== null ? `${extrusionPct.toFixed(1)}%` : '—'} />
            <StatCard
              label="Downtime Total"
              value={breakdown ? formatDuration(breakdown.stoppage_total_s) : '—'}
              sub={
                stoppagePct !== null
                  ? `${stoppagePct.toFixed(1)}% · ${stoppages.length} instance${stoppages.length === 1 ? '' : 's'}`
                  : undefined
              }
              onClick={() => setShowStoppages((v) => !v)}
              expanded={showStoppages}
            />
            <StatCard label="Billets" value={breakdown ? breakdown.billet_count : '—'} />
            <StatCard
              label="Last Billet"
              value={status && status.latest_billet ? `#${status.latest_billet.billet_number_per_order}` : '—'}
              sub={status ? `${formatDuration(status.seconds_since_last_billet)} ago` : undefined}
            />
          </div>

          {showStoppages && (
            <div className="stoppages-panel">
              <h3>Downtime Instances</h3>
              <p className="stat-sub">
                Unexplained stoppages this shift - each tied to the specific billet it happened around
                (a gap before it beyond that profile/die's normal baseline, or ram speed reading ~0
                mid-extrusion). Does not include Automatic Mode being off for a known reason
                (Emergency/Setup/Manual/Die Change) - see the Automatic Mode section below for that.
              </p>
              <StoppagesTable stoppages={stoppages} />
            </div>
          )}

          <h3>Production Cycle Breakdown</h3>
          <p className="stat-sub">
            Is the press actually extruding? Splits every billet's cycle into extrusion time and the
            gap before it - normal dead cycle (discard shear + reload), cleanout (alloy-family change),
            die change, or an unexplained stoppage, baselined per profile/die against its own recent history.
          </p>
          <CycleBreakdownBar breakdown={breakdown} />

          <h3>Automatic Mode: Uptime vs Downtime</h3>
          <p className="stat-sub">
            The press's control-mode timeline (Automatic Mode Active) - stays "up" through the normal
            gap between billets, so this is a coarser, different signal than the breakdown above (it
            can't tell you which billet a stoppage happened around).
          </p>
          <div className="stat-grid">
            <StatCard label="Uptime" value={uptime && uptime.uptime_pct !== null ? `${uptime.uptime_pct}%` : '—'} />
            <StatCard label="Uptime Total" value={uptime ? formatDuration(uptime.uptime_seconds) : '—'} />
            <StatCard label="Non-Automatic Total" value={uptime ? formatDuration(uptime.downtime_seconds) : '—'} />
          </div>
          <UptimeBar uptime={uptime} />

          <h3>Recent Billets</h3>
          <BilletsTable billets={billets} />
        </>
      )}
    </div>
  );
}

export default PressUptimeView;

import React, { useState, useMemo } from 'react';

// RUNNING and the muted "no data" cases are fixed status colors; each
// downtime reason gets its own categorical hue so the stacked bar and
// legend agree everywhere reasons appear. Kept in one place so the state
// badge and the uptime bar never drift apart.
export const RUNNING_COLOR = '#0ca30c';
export const NO_DATA_COLOR = '#c3c2b7';
export const REASON_COLORS = {
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
export const CYCLE_COLORS = {
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
export const SHIFT_SEQUENCE = ['Third Shift', 'First Shift', 'Second Shift'];

export function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function shiftStep(dateStr, shift, direction) {
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

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const total = Math.max(Math.round(seconds), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

export function formatClock(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function getStateBadge(state, reason) {
  if (state === 'RUNNING') return { label: 'Running', color: RUNNING_COLOR };
  if (state === 'IDLE') {
    const label = reason || 'Idle';
    return { label, color: REASON_COLORS[reason] || REASON_COLORS.Unspecified };
  }
  return { label: reason === 'Stale Data' ? 'No Data' : 'Unknown', color: NO_DATA_COLOR };
}

// Consolidated Uptime/Downtime: extrusion time plus every "expected"
// reason a billet isn't extruding (dead cycle, cleanout, die change)
// counts as uptime; an unexplained billet-level stoppage, or non-
// automatic time for any reason OTHER than Die Change (Manual, Setup,
// Emergency, or unattributed), counts as downtime. Die Change stays
// "expected" whether it shows up as a state_events reason or a
// billet-level gap - swapping a die isn't a failure - so both sources
// are merged into one Die Change segment.
//
// Unlike the single-lump version this replaced, every category is its
// own segment (matching the Production Cycle Breakdown/Automatic Mode
// detail sections' own numbers) rather than being collapsed into one
// green "Uptime" block - Uptime%/uptimeSeconds/downtimeSeconds are
// DERIVED by summing the segments below, so the stat cards can never
// drift out of sync with what the bar actually shows.
//
// Combines two independently-sourced signals without double-counting:
// billet-level breakdown (extrusion/dead_cycle/cleanout/die_change/
// stoppage, see billet_monitor.py's module docstring) only covers
// RUNNING time, since billet activity can't happen otherwise; state_events
// (RUNNING/IDLE) gives the non-automatic reasons for the rest. A gap
// between the two totals (e.g. RUNNING time before this shift's first
// billet) is possible but expected to be small in practice.
export function consolidateUptime(uptime, breakdown) {
  if (!uptime || !breakdown) return null;
  const byReason = uptime.downtime_by_reason || {};

  const uptimeSegments = [
    { label: 'Extrusion Time', seconds: (breakdown.extrusion_s || 0) + (breakdown.startup_s || 0), color: CYCLE_COLORS.Extrusion },
    { label: 'Dead Cycle', seconds: breakdown.dead_cycle_s || 0, color: CYCLE_COLORS['Dead Cycle'] },
    { label: 'Cleanout', seconds: breakdown.cleanout_s || 0, color: CYCLE_COLORS.Cleanout },
    { label: 'Die Change', seconds: (breakdown.die_change_s || 0) + (byReason['Die Change'] || 0), color: CYCLE_COLORS['Die Change'] },
  ];
  const downtimeSegments = [
    { label: 'Stoppage', seconds: breakdown.stoppage_total_s || 0, color: CYCLE_COLORS.Stoppage },
    { label: 'Manual', seconds: byReason['Manual'] || 0, color: REASON_COLORS.Manual },
    { label: 'Setup', seconds: byReason['Setup'] || 0, color: REASON_COLORS.Setup },
    { label: 'Emergency', seconds: byReason['Emergency'] || 0, color: REASON_COLORS.Emergency },
    { label: 'Unspecified', seconds: byReason['Unspecified'] || 0, color: REASON_COLORS.Unspecified },
  ];

  const uptimeSeconds = uptimeSegments.reduce((sum, seg) => sum + seg.seconds, 0);
  const downtimeSeconds = downtimeSegments.reduce((sum, seg) => sum + seg.seconds, 0);
  const covered = uptimeSeconds + downtimeSeconds;
  const uptimePct = covered > 0 ? (uptimeSeconds / covered) * 100 : null;
  const segments = [...uptimeSegments, ...downtimeSegments].filter((s) => s.seconds > 0);

  return { uptimeSeconds, downtimeSeconds, uptimePct, segments };
}

export function gapTag(b) {
  // This is about the GAP before the billet - Startup no longer factors
  // in here (it's about the billet's own extrusion duration now, see
  // billet_monitor.py's module docstring), so it's shown separately as a
  // note on the Extrusion column instead of taking over this tag.
  // Precedence matches billet_monitor.py's classification order:
  // cleanout > die change > baselined normal/stoppage.
  if (b.is_cleanout) return { label: 'Cleanout', color: CYCLE_COLORS.Cleanout };
  if (b.is_die_change) return { label: 'Die Change', color: CYCLE_COLORS['Die Change'] };
  if (b.stoppage_s > 0) return { label: 'Stoppage', color: CYCLE_COLORS.Stoppage };
  if (b.gap_before_s !== undefined && b.gap_before_s !== null) return { label: 'Normal', color: CYCLE_COLORS['Dead Cycle'] };
  return null; // pre-dates this classification
}

export function StatCard({ label, value, sub, onClick, expanded }) {
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

export function ShiftPicker({ date, shift, isCurrent, onNavigate, onJumpToCurrent }) {
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

export function BarWithLegend({ segments, ariaLabel, emptyMessage }) {
  const total = segments.reduce((sum, seg) => sum + seg.seconds, 0);
  if (total === 0) {
    return <p className="uptime-bar-empty">{emptyMessage}</p>;
  }
  return (
    <div>
      <div className="uptime-bar" role="img" aria-label={ariaLabel}>
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

export function UptimeBar({ uptime }) {
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
  return (
    <BarWithLegend
      segments={segments}
      ariaLabel="Uptime vs downtime breakdown"
      emptyMessage="No coverage yet for this shift."
    />
  );
}

export function CycleBreakdownBar({ breakdown }) {
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
  return (
    <BarWithLegend
      segments={segments}
      ariaLabel="Production cycle breakdown"
      emptyMessage="No billets recorded yet for this shift."
    />
  );
}

export function StoppagesTable({ stoppages }) {
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

export const BILLET_FILTER_COLUMNS = [
  { key: 'job_number', label: 'Job #', type: 'select', getValue: (b) => b.job_number },
  { key: 'die_copy', label: 'Die', type: 'select', getValue: (b) => (b.die_copy === undefined || b.die_copy === null ? null : String(b.die_copy)) },
  { key: 'alloy_name', label: 'Alloy', type: 'select', getValue: (b) => b.alloy_name },
  { key: 'gapType', label: 'Gap type', type: 'select', getValue: (b) => { const tag = gapTag(b); return tag ? tag.label : null; } },
  // Gap (s) is continuous, not categorical - a dropdown of every distinct
  // value would be useless. A "≥" threshold instead, so it doubles as a
  // way to spot any unusually long gap regardless of how the baseline
  // classified it, not just the ones already tagged Stoppage.
  { key: 'gap_before_s', label: 'Min Gap (s)', type: 'number', getValue: (b) => b.gap_before_s },
];

export const ALL_FILTER = 'All';

const BILLET_COLUMNS_FULL = ['time', 'billet', 'job', 'die', 'alloy', 'length', 'extrusion', 'gap', 'gapType', 'force'];
// A tighter column set for space-constrained layouts (the operator kiosk
// view) - drops length/alloy/force, which matter for the interactive
// drill-down but aren't what an operator glancing at a shop-floor screen
// needs first.
const BILLET_COLUMNS_COMPACT = ['time', 'billet', 'job', 'die', 'gap', 'gapType'];

const COLUMN_HEADERS = {
  time: 'Time', billet: 'Billet', job: 'Job #', die: 'Die', alloy: 'Alloy',
  length: 'Length (in)', extrusion: 'Extrusion (s)', gap: 'Gap (s)',
  gapType: 'Gap type', force: 'Peak Force (UST)',
};

function BilletRow({ b, columns }) {
  const tag = gapTag(b);
  const stallNote = b.in_billet_stall_s > 0 ? ` (+${formatNumber(b.in_billet_stall_s, 0)}s mid-stall)` : '';
  // Startup is its own badge, same visual treatment as the Gap Type tags -
  // shown on the Extrusion column since that's what it actually measures
  // now (excess extrusion time on a run's first billet, not a gap). A
  // billet can carry BOTH this and a Gap Type badge at once (e.g. the
  // first billet of a new die is typically both Die Change and Startup).
  const startupBadge = b.startup_s > 0 ? (
    <span className="gap-tag" style={{ backgroundColor: CYCLE_COLORS.Startup, marginLeft: 6 }}>
      +{formatNumber(b.startup_s, 0)}s Startup
    </span>
  ) : null;
  const cells = {
    time: formatClock(b.ts),
    billet: (
      <>
        {b.billet_number_per_order ?? '—'}
        {b.scheduled_billets ? ` / ${b.scheduled_billets}` : ''}
      </>
    ),
    job: b.job_number || '—',
    die: b.die_copy ?? '—',
    alloy: b.alloy_name || '—',
    length: formatNumber(b.billet_length_actual_in, 2),
    extrusion: (
      <>
        {formatNumber(b.extrusion_duration_s ?? b.extrusion_time_s, 0)}
        {startupBadge}
      </>
    ),
    gap: (
      <>
        {formatNumber(b.gap_before_s, 0)}
        {stallNote}
      </>
    ),
    gapType: tag ? (
      <span className="gap-tag" style={{ backgroundColor: tag.color }}>
        {tag.label}
      </span>
    ) : '—',
    force: formatNumber(b.extrusion_force_peak_ust, 0),
  };
  return (
    <tr>
      {columns.map((col) => (
        <td key={col}>{cells[col]}</td>
      ))}
    </tr>
  );
}

// compact: use the tighter column set (see BILLET_COLUMNS_COMPACT).
// limit: cap to the N most recent rows (already sorted newest-first).
// showFilters: whether to render the Job#/Die/Alloy/Gap-type dropdowns -
// off for the passive kiosk display, which has no room and no pointer
// interaction to spare for it.
export function BilletsTable({ billets, compact = false, limit = null, showFilters = true }) {
  const [filters, setFilters] = useState({});
  const columns = compact ? BILLET_COLUMNS_COMPACT : BILLET_COLUMNS_FULL;

  const filterOptions = useMemo(() => {
    const options = {};
    BILLET_FILTER_COLUMNS.forEach((col) => {
      if (col.type === 'number') return; // no discrete option list for a continuous value
      const values = new Set();
      (billets || []).forEach((b) => {
        const v = col.getValue(b);
        if (v !== null && v !== undefined && v !== '') values.add(v);
      });
      options[col.key] = Array.from(values).sort();
    });
    return options;
  }, [billets]);

  const filteredBillets = useMemo(() => {
    const rows = (billets || []).filter((b) =>
      BILLET_FILTER_COLUMNS.every((col) => {
        const active = filters[col.key];
        if (active === undefined || active === null || active === '' || active === ALL_FILTER) return true;
        const value = col.getValue(b);
        if (col.type === 'number') {
          return value !== null && value !== undefined && value >= Number(active);
        }
        return value === active;
      })
    );
    return limit ? rows.slice(0, limit) : rows;
  }, [billets, filters, limit]);

  const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearFilters = () => setFilters({});
  const activeFilterCount = Object.values(filters).filter((v) => v !== undefined && v !== null && v !== '' && v !== ALL_FILTER).length;

  if (!billets || billets.length === 0) {
    return <p>No billet cycles recorded yet.</p>;
  }

  return (
    <div>
      {showFilters && (
        <div className="table-filters">
          {BILLET_FILTER_COLUMNS.map((col) => (
            <label className="table-filter" key={col.key}>
              {col.label}
              {col.type === 'number' ? (
                <input
                  type="number"
                  min="0"
                  placeholder="Any"
                  value={filters[col.key] ?? ''}
                  onChange={(e) => setFilter(col.key, e.target.value)}
                />
              ) : (
                <select value={filters[col.key] || ALL_FILTER} onChange={(e) => setFilter(col.key, e.target.value)}>
                  <option value={ALL_FILTER}>All</option>
                  {filterOptions[col.key].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ))}
          {activeFilterCount > 0 && (
            <button className="secondary-button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}
      {showFilters && activeFilterCount > 0 && (
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
                {columns.map((col) => (
                  <th key={col}>{COLUMN_HEADERS[col]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredBillets.map((b) => (
                <BilletRow key={b.billet_key} b={b} columns={columns} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

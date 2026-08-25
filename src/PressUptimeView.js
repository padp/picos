import React, { useState, useEffect } from 'react';
import usePressUptime from './usePressUptime';
import {
  formatDuration, formatClock, getStateBadge, shiftStep, consolidateUptime,
  StatCard, ShiftPicker, UptimeBar, CycleBreakdownBar, StoppagesTable, BilletsTable, BarWithLegend,
} from './pressShared';

function PressUptimeView({ onBackToDefault, onOpenOperatorView }) {
  const [shiftParams, setShiftParams] = useState(null); // null = let the server pick the current shift
  const [showStoppages, setShowStoppages] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
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
  const consolidated = consolidateUptime(uptime, breakdown);

  const handleNavigate = (direction) => {
    const base = shiftParams || (uptime ? { date: uptime.date, shift: uptime.shift } : null);
    if (!base) return;
    setShiftParams(shiftStep(base.date, base.shift, direction));
  };

  return (
    <div className="container">
      <div className="default-view-header">
        <h1>Press Billet Cycles &amp; Uptime</h1>
        <div>
          <button className="secondary-button" onClick={onOpenOperatorView}>
            Operator Display &rarr;
          </button>
          <button className="secondary-button" onClick={onBackToDefault}>
            &larr; Live Data
          </button>
        </div>
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

          <h3>Uptime / Downtime</h3>
          <p className="stat-sub">
            Extruding (including a run's first billet running a bit long for thermal ramp-up), or in a
            normal/expected gap (dead cycle, cleanout, die change) counts as uptime. An unexplained
            stoppage, or the press sitting in Manual, Setup, or Emergency, counts as downtime.
          </p>

          <div className="stat-grid">
            <StatCard
              label="Uptime"
              value={consolidated && consolidated.uptimePct !== null ? `${consolidated.uptimePct.toFixed(1)}%` : '—'}
            />
            <StatCard
              label="Downtime Total"
              value={consolidated ? formatDuration(consolidated.downtimeSeconds) : '—'}
              sub={
                consolidated
                  ? `${stoppages.length} unexplained stoppage instance${stoppages.length === 1 ? '' : 's'}`
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

          {consolidated && (
            <BarWithLegend
              segments={consolidated.segments}
              ariaLabel="Consolidated uptime vs downtime"
              emptyMessage="No coverage yet for this shift."
            />
          )}

          {showStoppages && (
            <div className="stoppages-panel">
              <h3>Downtime Instances</h3>
              <p className="stat-sub">
                Unexplained stoppages this shift - each tied to the specific billet it happened around
                (a gap before it beyond that profile/die's normal baseline, or ram speed reading ~0
                mid-extrusion). Manual/Setup/Emergency time isn't billet-linked, so it isn't listed here
                individually - see the Automatic Mode breakdown below for that.
              </p>
              <StoppagesTable stoppages={stoppages} />
            </div>
          )}

          <button className="secondary-button" onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'Hide' : 'Show'} Detailed Breakdown {showDetails ? '▲' : '▼'}
          </button>

          {showDetails && (
            <div className="details-panel">
              <h3>Production Cycle Breakdown</h3>
              <p className="stat-sub">
                Is the press actually extruding? Splits every billet's cycle into extrusion time and the
                gap before it - normal dead cycle (discard shear + reload), cleanout (alloy-family change),
                die change, or an unexplained stoppage, baselined per profile/die against its own recent
                history. Doesn't know about Manual/Setup/Emergency at all - that's the Automatic Mode
                section below, a completely separate signal.
              </p>
              <div className="stat-grid">
                <StatCard label="Extruding" value={extrusionPct !== null ? `${extrusionPct.toFixed(1)}%` : '—'} />
              </div>
              <CycleBreakdownBar breakdown={breakdown} />

              <h3>Automatic Mode: Uptime vs Downtime</h3>
              <p className="stat-sub">
                The press's control-mode timeline (Automatic Mode Active) - stays "up" through the normal
                gap between billets, so this treats every billet-to-billet gap as uptime, unlike the
                consolidated view above.
              </p>
              <div className="stat-grid">
                <StatCard label="Uptime" value={uptime && uptime.uptime_pct !== null ? `${uptime.uptime_pct}%` : '—'} />
                <StatCard label="Uptime Total" value={uptime ? formatDuration(uptime.uptime_seconds) : '—'} />
                <StatCard label="Non-Automatic Total" value={uptime ? formatDuration(uptime.downtime_seconds) : '—'} />
              </div>
              <UptimeBar uptime={uptime} />
            </div>
          )}

          <h3>Recent Billets</h3>
          <BilletsTable billets={billets} />
        </>
      )}
    </div>
  );
}

export default PressUptimeView;

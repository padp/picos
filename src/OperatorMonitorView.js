import React from 'react';
import usePressUptime from './usePressUptime';
import {
  formatDuration, getStateBadge,
  StatCard, CycleBreakdownBar, StoppagesTable, BilletsTable,
} from './pressShared';

// Sized for a shop-floor display meant to be glanced at, not scrolled -
// table rows and downtime instances are both capped so a normal shift's
// worth of content fits in one screen; the interactive /monitor page
// (linked below) is where the full, filterable history lives.
const OPERATOR_BILLET_LIMIT = 15;
const OPERATOR_STOPPAGE_LIMIT = 5;

function OperatorMonitorView({ onBackToDefault }) {
  // Always the live current shift - no Prev/Next navigation. This is a
  // passive/kiosk display, not a workstation someone is browsing history
  // from; that's what the interactive Monitor page is for.
  const { status, uptime, breakdown, billets, stoppages, isLoading, error } = usePressUptime(null);

  const badge = uptime ? getStateBadge(uptime.current_state, uptime.current_reason) : null;
  const accounted = breakdown ? breakdown.accounted_seconds : null;
  const extrusionPct = breakdown && accounted ? (breakdown.extrusion_s / accounted) * 100 : null;
  const stoppagePct = breakdown && accounted ? (breakdown.stoppage_total_s / accounted) * 100 : null;
  const visibleStoppages = stoppages.slice(0, OPERATOR_STOPPAGE_LIMIT);

  return (
    <div className="operator-container">
      <div className="operator-header">
        <h1>Press Operations Monitor</h1>
        <div className="operator-header-right">
          {uptime && uptime.shift && (
            <span className="operator-shift-label">
              {uptime.shift} · {uptime.date}
            </span>
          )}
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
          {status && status.stalled && (
            <div className="stall-banner">
              ⚠ No billet completed in {formatDuration(status.seconds_since_last_billet)}
              {status.expected_gap_s
                ? ` — normally about ${formatDuration(status.expected_gap_s)} between billets`
                : ''}{' '}
              — possible stoppage.
            </div>
          )}

          <div className="operator-layout">
            <div className="operator-main">
              <h3>Recent Billets</h3>
              <BilletsTable billets={billets} compact limit={OPERATOR_BILLET_LIMIT} showFilters={false} />
            </div>

            <div className="operator-side">
              {badge && (
                <div className="status-badge" style={{ backgroundColor: badge.color }}>
                  {badge.label}
                </div>
              )}

              <div className="stat-grid">
                <StatCard label="Extruding" value={extrusionPct !== null ? `${extrusionPct.toFixed(1)}%` : '—'} />
                <StatCard
                  label="Downtime"
                  value={breakdown ? formatDuration(breakdown.stoppage_total_s) : '—'}
                  sub={stoppagePct !== null ? `${stoppagePct.toFixed(1)}%` : undefined}
                />
                <StatCard label="Billets" value={breakdown ? breakdown.billet_count : '—'} />
                <StatCard
                  label="Last Billet"
                  value={status && status.latest_billet ? `#${status.latest_billet.billet_number_per_order}` : '—'}
                  sub={status ? `${formatDuration(status.seconds_since_last_billet)} ago` : undefined}
                />
              </div>

              <h3>Production Cycle</h3>
              <CycleBreakdownBar breakdown={breakdown} />

              <h3>Downtime Instances</h3>
              <StoppagesTable stoppages={visibleStoppages} />
              {stoppages.length > OPERATOR_STOPPAGE_LIMIT && (
                <p className="stat-sub">+{stoppages.length - OPERATOR_STOPPAGE_LIMIT} more this shift.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default OperatorMonitorView;

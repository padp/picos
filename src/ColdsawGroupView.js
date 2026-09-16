import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT } from './Constants';

// Animated view of the batch of profiles forming for the coldsaw.
//
// DIRECTION IS THE WHOLE POINT OF THE LAYOUT. Material travels left to right,
// so the FIRST profile into a batch ends up furthest right - which means the
// rightmost part normally carries the LOWEST billet number. The API returns
// `members` in arrival order (lowest billet first); this renders that array
// reversed so index 0 lands on the right. New profiles slide in from the left.
//
// Batch SIZE comes from the setpoint, never from counting the members we
// happened to observe: two increments inside one poll interval read as one, so
// counting undercounts about a quarter of batches. Empty slots are drawn as
// outlines, which is also what makes "filling up" legible.
//
// The billet number on a part is the billet that was AT THE PRESS when that
// profile was stretched - and the press is minutes ahead of the stretcher, so
// it is an approximation, deliberately labelled as such. part_ledger.py in the
// Press History project does the exact offline attribution.

const POLL_MS = 2000;

function Part({ member, slot, total, isNewest }) {
  const unknown = member && (member.unknown || member.billet_number == null);
  const label = member && member.billet_number != null
    ? `#${Math.round(member.billet_number)}`
    : (unknown ? '?' : '—');
  const cls = !member ? ' cs-part-pending'
    : unknown ? ' cs-part-unknown' : '';
  const title = !member
    ? 'Not stretched yet — the batch may still release before reaching this slot'
    : unknown
      ? 'Already on the table when tracking started — its billet cannot be recovered'
      : `Billet ${label} · profile ${member.profile || '?'} · stretched ${member.stretched_at || ''}`;
  return (
    <div
      className={`cs-part${cls}${isNewest ? ' cs-part-new' : ''}`}
      style={{ animationDelay: `${slot * 60}ms` }}
      title={title}
    >
      <div className="cs-part-body">
        <span className="cs-part-billet">{label}</span>
      </div>
      <div className="cs-part-slot">{total - slot}</div>
    </div>
  );
}

function Batch({ batch, setpoint, highlightNewest, showPending }) {
  const members = (batch && batch.members) || [];
  // A released batch shows exactly what it CONTAINS - batches are routinely
  // brought over before the setpoint, so padding a finished batch out to the
  // setpoint would invent parts that were never in it. Only the batch still
  // forming shows faint pending slots, and even then they are a target, not a
  // promise: it can release at any point.
  const pending = showPending ? Math.max(0, (setpoint || 0) - members.length) : 0;
  const size = members.length + pending;
  const slots = [];
  for (let i = 0; i < size; i += 1) slots.push(members[i] || null);
  slots.reverse();

  return (
    <div className="cs-track">
      <div className="cs-track-arrow">travel &rarr;</div>
      <div className="cs-parts">
        {slots.map((m, i) => (
          <Part
            key={i}
            member={m}
            slot={i}
            total={size}
            isNewest={highlightNewest && m && m === members[members.length - 1]}
          />
        ))}
      </div>
    </div>
  );
}

function ColdsawGroupView({ onBackToDefault }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${PRESS_API_BASE}/api/coldsaw/current`, { timeout: REQUEST_TIMEOUT });
      setState(res.data);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const live = (state && state.live) || {};
  const forming = state && state.forming;
  const released = (state && state.released) || [];
  const setpoint = live.setpoint || (forming && forming.setpoint) || 0;
  const cutsTotal = live.cuts_total || 0;
  const cutNumber = live.cut_number || 0;
  const cutPct = cutsTotal ? Math.min(100, (cutNumber / cutsTotal) * 100) : 0;

  return (
    <div className="cs-view">
      <style>{CSS}</style>

      <div className="cs-header">
        <button className="cs-back" onClick={onBackToDefault}>&larr; Back</button>
        <h1>Coldsaw Group</h1>
        <div className="cs-meta">
          {live.profile ? (
            <>
              <span>Profile <b>{live.profile}</b></span>
              <span>Die Copy <b>{live.die_copy}</b></span>
              <span>Nominal batch <b>{setpoint || '—'}</b> profiles</span>
            </>
          ) : <span>waiting for data…</span>}
        </div>
      </div>

      {error && <div className="cs-note cs-error">Could not reach the press API. Retrying…</div>}
      {isLoading && !state && <div className="cs-note">Loading…</div>}
      {state && state.stale && (
        <div className="cs-note cs-error">
          Press data is more than 5 minutes old — this is the last known state, not live.
        </div>
      )}

      <section className="cs-section">
        <h2>
          Forming now
          <span className="cs-counter">{live.actual != null ? live.actual : '—'} / {setpoint || '—'}</span>
        </h2>
        <Batch batch={forming} setpoint={setpoint} highlightNewest showPending />
        <p className="cs-caption">
          Rightmost part entered first, so it carries the lowest billet number.
          Faint slots are the nominal batch size — it can be brought over early.
        </p>
      </section>

      <section className="cs-section">
        <h2>
          At the saw
          {cutsTotal ? <span className="cs-counter">cut {cutNumber} of {cutsTotal}</span> : null}
        </h2>
        {released.length === 0 ? (
          <p className="cs-caption">No released batch recorded yet.</p>
        ) : (
          <>
            <Batch batch={released[0]} setpoint={released[0].setpoint} />
            <div className="cs-cutbar">
              <div className="cs-cutbar-fill" style={{ width: `${cutPct}%` }} />
            </div>
            <p className="cs-caption">
              Released {released[0].released_at || ''} with{' '}
              <b>{released[0].size != null ? released[0].size : (released[0].members || []).length}</b>{' '}
              profiles
              {released[0].short_of_setpoint
                ? ` — brought over early (nominal ${released[0].setpoint})`
                : ''}
              {released[0].closed_by === 'profile_change' ? ' — closed by profile changeover' : ''}
              . The blade cuts every profile in one stroke, so each cut yields one
              piece per part above.
            </p>
          </>
        )}
      </section>

      {live.table && live.table.length > 0 && (
        <section className="cs-section">
          <h2>On the run-out table<span className="cs-counter">{live.table.length} queued</span></h2>
          <div className="cs-table-queue">
            {live.table.slice().reverse().map((t) => (
              <div className="cs-queued" key={t.position} title={`Table position ${t.position}`}>
                {/* 3 decimals, not 2: at 2 dp, 161.076 and 161.037 both render as
                    161.04 - the very collision the caption says this avoids. */}
                <span className="cs-queued-len">{t.length_ft.toFixed(3)} ft</span>
                <span className="cs-queued-pos">pos {t.position}</span>
              </div>
            ))}
          </div>
          <p className="cs-caption">
            Waiting between press and stretcher. Lengths are shown at full precision —
            profiles of the same nominal length are only distinguishable this way.
          </p>
        </section>
      )}

      {released.length > 1 && (
        <section className="cs-section">
          <h2>Recent batches</h2>
          <table className="cs-recent">
            <thead>
              <tr><th>Released</th><th>Profile</th><th>Die</th><th>Billets</th></tr>
            </thead>
            <tbody>
              {released.slice(1).map((b) => (
                <tr key={b._id}>
                  <td>{(b.released_at || '').slice(-8)}</td>
                  <td>{b.profile}</td>
                  <td>{b.die_copy}</td>
                  <td>
                    {(b.members || [])
                      .map((m) => (m.billet_number != null ? Math.round(m.billet_number) : '—'))
                      .join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="cs-footnote">
        Billet numbers are tracked through the run-out table queue, captured at the moment
        each extrusion ends, so they are exact rather than inferred from what the press is
        running now. A part marked <b>?</b> was already on the table when tracking started
        and its billet cannot be recovered; those clear within one pass of the queue.
      </p>
    </div>
  );
}

const CSS = `
.cs-view { padding: 1.25rem 1.5rem 3rem; max-width: 1100px; margin: 0 auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #17202b; }
.cs-header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: .25rem; }
.cs-header h1 { font-size: 1.35rem; margin: 0; }
.cs-back { background: #eef2f7; border: 1px solid #d3dce6; border-radius: 6px;
  padding: .35rem .7rem; cursor: pointer; font-size: .85rem; }
.cs-back:hover { background: #e2e8f0; }
.cs-meta { display: flex; gap: 1rem; flex-wrap: wrap; font-size: .85rem; color: #5a6b7d; }
.cs-section { margin-top: 1.75rem; }
.cs-section h2 { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase;
  color: #6b7a8c; margin: 0 0 .6rem; display: flex; align-items: center; gap: .75rem; }
.cs-counter { font-variant-numeric: tabular-nums; background: #eef2f7; color: #35455a;
  border-radius: 999px; padding: .1rem .55rem; font-size: .78rem; letter-spacing: 0; }
.cs-caption { font-size: .8rem; color: #6b7a8c; margin: .55rem 0 0; }
.cs-note { padding: .6rem .8rem; border-radius: 6px; background: #eef2f7; font-size: .85rem; margin-top: .75rem; }
.cs-error { background: #fdecec; color: #8c2f2f; }

.cs-track { position: relative; background: linear-gradient(#f6f8fa, #eef1f5);
  border: 1px solid #dde4ec; border-radius: 10px; padding: 1.4rem 1rem .9rem; overflow: hidden; }
.cs-track-arrow { position: absolute; top: .4rem; right: .8rem; font-size: .7rem;
  letter-spacing: .1em; text-transform: uppercase; color: #9aa8b6; }
.cs-parts { display: flex; gap: .5rem; justify-content: flex-end; align-items: flex-end; min-height: 92px; }

.cs-part { display: flex; flex-direction: column; align-items: center; gap: .3rem;
  animation: cs-slide-in .5s ease-out both; }
.cs-part-body { width: 74px; height: 62px; border-radius: 5px;
  background: linear-gradient(105deg, #c6ced6 0%, #eef2f6 18%, #b8c2cc 42%,
    #dfe5eb 62%, #aab5c0 85%, #cfd7df 100%);
  border: 1px solid #93a0ad; box-shadow: inset 0 2px 0 rgba(255,255,255,.75),
    inset 0 -3px 5px rgba(0,0,0,.12), 0 1px 3px rgba(23,32,43,.16);
  display: flex; align-items: center; justify-content: center; }
.cs-part-billet { font-weight: 700; font-size: .95rem; color: #2b3746;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 0 rgba(255,255,255,.7); }
.cs-part-slot { font-size: .68rem; color: #94a2b0; font-variant-numeric: tabular-nums; }
.cs-part-empty .cs-part-body { background: repeating-linear-gradient(135deg,
    #f2f5f8, #f2f5f8 6px, #e8edf2 6px, #e8edf2 12px);
  border: 1px dashed #c2ccd6; box-shadow: none; }
.cs-part-empty .cs-part-billet { color: #b3bfca; font-weight: 500; }
.cs-part-new .cs-part-body { animation: cs-flash 1.1s ease-out 1; }

@keyframes cs-slide-in { from { opacity: 0; transform: translateX(-38px); }
  to { opacity: 1; transform: translateX(0); } }
@keyframes cs-flash { 0% { box-shadow: 0 0 0 0 rgba(37,120,205,.55); }
  100% { box-shadow: 0 0 0 14px rgba(37,120,205,0); } }


.cs-part-pending .cs-part-body { background: repeating-linear-gradient(135deg,
    #f2f5f8, #f2f5f8 6px, #e8edf2 6px, #e8edf2 12px);
  border: 1px dashed #c2ccd6; box-shadow: none; opacity: .75; }
.cs-part-pending .cs-part-billet { color: #b3bfca; font-weight: 500; }
.cs-part-unknown .cs-part-body { background: repeating-linear-gradient(135deg,
    #f6efe2, #f6efe2 6px, #efe4d0 6px, #efe4d0 12px); border-color: #d8c49a; }
.cs-part-unknown .cs-part-billet { color: #8a6d3b; }
.cs-badge-early { background: #fdf0e3; color: #8a5a1f; border-radius: 999px;
  padding: .1rem .5rem; font-size: .72rem; margin-left: .4rem; }

.cs-cutbar { margin-top: .7rem; height: 7px; background: #e6ebf1; border-radius: 4px; overflow: hidden; }
.cs-cutbar-fill { height: 100%; background: linear-gradient(90deg, #3d82c4, #2e6ba8);
  transition: width .45s ease; }

.cs-table-queue { display: flex; gap: .45rem; flex-wrap: wrap; justify-content: flex-end; }
.cs-queued { border: 1px solid #dde4ec; background: #f8fafc; border-radius: 6px;
  padding: .4rem .55rem; display: flex; flex-direction: column; align-items: center; gap: .1rem; }
.cs-queued-len { font-size: .8rem; font-variant-numeric: tabular-nums; color: #35455a; }
.cs-queued-pos { font-size: .65rem; color: #9aa8b6; }

.cs-recent { width: 100%; border-collapse: collapse; font-size: .82rem; }
.cs-recent th { text-align: left; font-weight: 600; color: #6b7a8c; padding: .35rem .5rem;
  border-bottom: 1px solid #dde4ec; }
.cs-recent td { padding: .35rem .5rem; border-bottom: 1px solid #eef1f5;
  font-variant-numeric: tabular-nums; }

.cs-footnote { margin-top: 2rem; font-size: .76rem; color: #8b98a6; line-height: 1.5; }
.cs-footnote code { background: #f1f4f8; padding: 0 .25rem; border-radius: 3px; }

@media (prefers-reduced-motion: reduce) {
  .cs-part { animation: none; }
  .cs-part-new .cs-part-body { animation: none; }
  .cs-cutbar-fill { transition: none; }
}
@media (max-width: 560px) {
  .cs-parts { justify-content: flex-start; flex-wrap: wrap; }
  .cs-part-body { width: 58px; height: 50px; }
}
`;

export default ColdsawGroupView;

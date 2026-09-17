import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT } from './Constants';

// Follows profiles through the plant, in the order the material travels:
//
//   1  at the press   what is extruding right now
//   2  pre-stretch    on the run-out table, waiting for the stretcher
//   3  post-stretch   stretched, accumulating until the batch goes over
//   4  at the saw     being cut
//
// DIRECTION IS THE POINT OF THE LAYOUT. Material travels left to right, so the
// first profile into a stage ends up furthest right - the rightmost part
// normally carries the LOWEST billet number. Each queue arrives oldest-first
// and is rendered reversed.
//
// Batch SIZE comes from the counter's peak, never the setpoint: batches are
// routinely brought over early, and the setpoint field has been seen reading 8
// while the counter reset at 6.
//
// On a 2-profiles-per-billet recipe two parts share a billet number, so each
// carries its index within that billet - #41.1 and #41.2 - the same way they
// get written down by hand. The ratio is deduced from how many profiles reach
// the table between billet changes, cross-checked against Hotsaw Blade
// Rotation Active.

const POLL_MS = 2000;

function billetLabel(member, perBillet) {
  if (!member) return '—';
  if (member.unknown || member.billet_number == null) return '?';
  const seq = perBillet > 1 && member.billet_seq ? `.${member.billet_seq}` : '';
  return `#${Math.round(member.billet_number)}${seq}`;
}

function Part({ member, slot, total, isNewest, perBillet }) {
  const unknown = member && (member.unknown || member.billet_number == null);
  const cls = !member ? ' cs-part-pending' : unknown ? ' cs-part-unknown' : '';
  const title = !member
    ? 'Not stretched yet — the batch may still release before reaching this slot'
    : unknown
      ? 'Already in the queue when tracking started — its billet cannot be recovered'
      : `Billet ${billetLabel(member, perBillet)} · profile ${member.profile || '?'}`
        + (member.length_ft ? ` · ${member.length_ft.toFixed(3)} ft` : '');
  return (
    <div
      className={`cs-part${cls}${isNewest ? ' cs-part-new' : ''}`}
      style={{ animationDelay: `${slot * 60}ms` }}
      title={title}
    >
      <div className="cs-part-body">
        <span className="cs-part-billet">{billetLabel(member, perBillet)}</span>
      </div>
      <div className="cs-part-slot">{total - slot}</div>
    </div>
  );
}

// members arrive oldest-first; reversed here so the first one in sits rightmost
function Track({ members, pending, perBillet, highlightNewest, empty }) {
  const list = members || [];
  const size = list.length + (pending || 0);
  if (!size) return <p className="cs-caption">{empty}</p>;
  const slots = [];
  for (let i = 0; i < size; i += 1) slots.push(list[i] || null);
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
            perBillet={perBillet}
            isNewest={highlightNewest && m && m === list[list.length - 1]}
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
  // The saw runs a couple of batches behind the release point, so this is the
  // head of the saw queue - advanced only when the cut counter resets. Using
  // released[0] made a newly released batch appear at the saw immediately, so
  // at a die change the next profile's billets replaced 1262 mid-cut.
  const atSaw = state && state.at_saw;
  const perBillet = live.profiles_per_billet || 1;
  const setpoint = live.setpoint || (forming && forming.setpoint) || 0;
  const cutsTotal = live.cuts_total || 0;
  const cutNumber = live.cut_number || 0;
  const cutPct = cutsTotal ? Math.min(100, (cutNumber / cutsTotal) * 100) : 0;

  // the run-out table arrives newest-first; Track wants oldest-first
  const preStretch = (live.on_table || []).slice().reverse();
  const formingMembers = (forming && forming.members) || [];

  return (
    <div className="cs-view">
      <style>{CSS}</style>

      <div className="cs-header">
        <button className="cs-back" onClick={onBackToDefault}>&larr; Back</button>
        <h1>Coldsaw Group</h1>
      </div>

      {error && <div className="cs-note cs-error">Could not reach the press API. Retrying…</div>}
      {isLoading && !state && <div className="cs-note">Loading…</div>}
      {state && state.stale && (
        <div className="cs-note cs-error">
          Press data is more than 5 minutes old — this is the last known state, not live.
        </div>
      )}

      {/* 1 - at the press */}
      <section className="cs-section">
        <h2>At the press
          <span className={`cs-counter${live.extruding ? ' cs-run' : ''}`}>
            {live.extruding ? 'extruding' : 'not extruding'}
          </span>
        </h2>
        <div className="cs-now">
          <div className="cs-now-item"><span>Profile</span><b>{live.profile || '—'}</b></div>
          <div className="cs-now-item"><span>Die copy</span><b>{live.die_copy != null ? live.die_copy : '—'}</b></div>
          <div className="cs-now-item">
            <span>Billet</span>
            <b>{live.billet_at_press != null ? `#${Math.round(live.billet_at_press)}` : '—'}</b>
          </div>
          {perBillet > 1 && (
            <div className="cs-now-item">
              <span>Profile of billet</span>
              <b>{Math.min(perBillet, (live.hotsaw_edges_this_billet || 0) + 1)} of {perBillet}</b>
            </div>
          )}
          <div className="cs-now-item"><span>Profiles per billet</span><b>{perBillet}</b></div>
        </div>
      </section>

      {/* 2 - pre-stretch */}
      <section className="cs-section">
        <h2>Waiting for the stretcher
          <span className="cs-counter">{preStretch.length} on the table</span>
        </h2>
        <Track members={preStretch} perBillet={perBillet}
               empty="Nothing on the run-out table." />
        <p className="cs-caption">
          On the run-out table after evacuation. Rightmost entered first and is next
          to be stretched.
        </p>
      </section>

      {/* 3 - post-stretch */}
      <section className="cs-section">
        <h2>Waiting for the coldsaw
          <span className="cs-counter">
            {live.actual != null ? live.actual : '—'} / {setpoint || '—'}
          </span>
        </h2>
        <Track members={formingMembers} perBillet={perBillet} highlightNewest
               pending={Math.max(0, (setpoint || 0) - formingMembers.length)}
               empty="No batch forming yet." />
        <p className="cs-caption">
          Stretched and queued. Faint slots are the nominal batch size — it can be
          brought over early.
          {perBillet > 1 && ' Two profiles per billet, so #41.1 and #41.2 are the two halves of billet 41.'}
        </p>
      </section>

      {/* 4 - at the saw */}
      <section className="cs-section">
        <h2>At the coldsaw
          {cutsTotal ? <span className="cs-counter">cut {cutNumber} of {cutsTotal}</span> : null}
          {live.cut_length_in ? <span className="cs-counter">{live.cut_length_in.toFixed(2)} in</span> : null}
        </h2>
        {!atSaw ? (
          <p className="cs-caption">No released batch recorded yet.</p>
        ) : (
          <>
            <Track members={atSaw.members} perBillet={perBillet}
                   empty="No parts recorded in this batch." />
            <div className="cs-cutbar"><div className="cs-cutbar-fill" style={{ width: `${cutPct}%` }} /></div>
            <p className="cs-caption">
              Released {atSaw.released_at || ''} with{' '}
              <b>{atSaw.size != null ? atSaw.size : (atSaw.members || []).length}</b> profiles
              {atSaw.short_of_setpoint ? ` — brought over early (nominal ${atSaw.setpoint})` : ''}
              {atSaw.closed_by === 'profile_change' ? ' — closed by profile changeover' : ''}
              . The blade cuts every profile in one stroke, so each cut yields one
              piece per part above.
            </p>
          </>
        )}
      </section>

      {released.length > 0 && (
        <section className="cs-section">
          <h2>Recent batches</h2>
          <table className="cs-recent">
            <thead>
              <tr><th>Released</th><th>Profile</th><th>Die</th><th>Size</th><th>Billets</th></tr>
            </thead>
            <tbody>
              {released.filter((b) => !atSaw || b.batch_seq !== atSaw.batch_seq).map((b) => (
                <tr key={b._id}>
                  <td>{(b.released_at || '').slice(-8)}</td>
                  <td>{b.profile}</td>
                  <td>{b.die_copy}</td>
                  <td>{b.size}</td>
                  <td>{(b.members || []).map((m) => billetLabel(m, perBillet)).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="cs-footnote">
        A profile is identified by its position in the run-out table sequence, and
        attributed to the billet that most recently finished extruding — the press runs
        several minutes ahead of the stretcher. Billet 0 is the idle placeholder and is
        never used. A part marked <b>?</b> was already in the queue when tracking started
        and its billet cannot be recovered; those clear within one pass.
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
.cs-section { margin-top: 1.75rem; }
.cs-section h2 { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase;
  color: #6b7a8c; margin: 0 0 .6rem; display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.cs-counter { font-variant-numeric: tabular-nums; background: #eef2f7; color: #35455a;
  border-radius: 999px; padding: .1rem .55rem; font-size: .78rem; letter-spacing: 0; }
.cs-counter.cs-run { background: #e4f3e8; color: #2c6b41; }
.cs-caption { font-size: .8rem; color: #6b7a8c; margin: .55rem 0 0; }
.cs-note { padding: .6rem .8rem; border-radius: 6px; background: #eef2f7; font-size: .85rem; margin-top: .75rem; }
.cs-error { background: #fdecec; color: #8c2f2f; }

.cs-now { display: flex; gap: .5rem; flex-wrap: wrap; }
.cs-now-item { background: #f6f8fa; border: 1px solid #dde4ec; border-radius: 8px;
  padding: .5rem .8rem; display: flex; flex-direction: column; gap: .15rem; min-width: 104px; }
.cs-now-item span { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8b98a6; }
.cs-now-item b { font-size: 1.05rem; font-variant-numeric: tabular-nums; }

.cs-track { position: relative; background: linear-gradient(#f6f8fa, #eef1f5);
  border: 1px solid #dde4ec; border-radius: 10px; padding: 1.4rem 1rem .9rem; overflow: hidden; }
.cs-track-arrow { position: absolute; top: .4rem; right: .8rem; font-size: .7rem;
  letter-spacing: .1em; text-transform: uppercase; color: #9aa8b6; }
.cs-parts { display: flex; gap: .5rem; justify-content: flex-end; align-items: flex-end;
  min-height: 92px; flex-wrap: wrap; }

.cs-part { display: flex; flex-direction: column; align-items: center; gap: .3rem;
  animation: cs-slide-in .5s ease-out both; }
.cs-part-body { width: 78px; height: 62px; border-radius: 5px;
  background: linear-gradient(105deg, #c6ced6 0%, #eef2f6 18%, #b8c2cc 42%,
    #dfe5eb 62%, #aab5c0 85%, #cfd7df 100%);
  border: 1px solid #93a0ad; box-shadow: inset 0 2px 0 rgba(255,255,255,.75),
    inset 0 -3px 5px rgba(0,0,0,.12), 0 1px 3px rgba(23,32,43,.16);
  display: flex; align-items: center; justify-content: center; }
.cs-part-billet { font-weight: 700; font-size: .92rem; color: #2b3746;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 0 rgba(255,255,255,.7); }
.cs-part-slot { font-size: .68rem; color: #94a2b0; font-variant-numeric: tabular-nums; }
.cs-part-pending .cs-part-body { background: repeating-linear-gradient(135deg,
    #f2f5f8, #f2f5f8 6px, #e8edf2 6px, #e8edf2 12px);
  border: 1px dashed #c2ccd6; box-shadow: none; opacity: .75; }
.cs-part-pending .cs-part-billet { color: #b3bfca; font-weight: 500; }
.cs-part-unknown .cs-part-body { background: repeating-linear-gradient(135deg,
    #f6efe2, #f6efe2 6px, #efe4d0 6px, #efe4d0 12px); border-color: #d8c49a; }
.cs-part-unknown .cs-part-billet { color: #8a6d3b; }
.cs-part-new .cs-part-body { animation: cs-flash 1.1s ease-out 1; }

@keyframes cs-slide-in { from { opacity: 0; transform: translateX(-38px); }
  to { opacity: 1; transform: translateX(0); } }
@keyframes cs-flash { 0% { box-shadow: 0 0 0 0 rgba(37,120,205,.55); }
  100% { box-shadow: 0 0 0 14px rgba(37,120,205,0); } }

.cs-cutbar { margin-top: .7rem; height: 7px; background: #e6ebf1; border-radius: 4px; overflow: hidden; }
.cs-cutbar-fill { height: 100%; background: linear-gradient(90deg, #3d82c4, #2e6ba8);
  transition: width .45s ease; }

.cs-recent { width: 100%; border-collapse: collapse; font-size: .82rem; }
.cs-recent th { text-align: left; font-weight: 600; color: #6b7a8c; padding: .35rem .5rem;
  border-bottom: 1px solid #dde4ec; }
.cs-recent td { padding: .35rem .5rem; border-bottom: 1px solid #eef1f5;
  font-variant-numeric: tabular-nums; }

.cs-footnote { margin-top: 2rem; font-size: .76rem; color: #8b98a6; line-height: 1.5; }

@media (prefers-reduced-motion: reduce) {
  .cs-part { animation: none; }
  .cs-part-new .cs-part-body { animation: none; }
  .cs-cutbar-fill { transition: none; }
}
@media (max-width: 560px) {
  .cs-parts { justify-content: flex-start; }
  .cs-part-body { width: 62px; height: 50px; }
}
`;

export default ColdsawGroupView;

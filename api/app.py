import os
from datetime import datetime, timedelta

from flask import Flask, jsonify, request
from flask_cors import CORS

import billet_monitor
from db import ensure_indexes, get_db

app = Flask(__name__)
CORS(app)

# Fallback "stalled" threshold only for when this profile/die has no gap
# baseline yet (see billet_monitor.gap_baseline) - once one exists,
# press_status() scores the live gap against it instead, the same way
# billet_monitor.py scores a completed one. A fixed threshold alone was
# wrong: it fired on a large profile mid-way through a single normal long
# extrusion (seconds_since_last_billet counts from the PREVIOUS billet's
# completion, so a >10min extrusion in progress looked identical to a
# >10min real stall), and it couldn't tell a fast-cycling small profile's
# genuinely-stuck 3 minutes from a slow profile's completely normal one.
BILLET_STALL_FALLBACK_THRESHOLD_S = 10 * 60
MAX_UPTIME_WINDOW_HOURS = 24 * 30

if os.environ.get("SQL_PASS"):
    # Skipped at build time (no SQL_PASS yet) - runs at import time so it
    # also happens under gunicorn, not just `python app.py`. Same guard
    # Granco Saw Monitor's api/app.py uses.
    ensure_indexes()
    billet_monitor.start_background_poller()


@app.get("/")
def health():
    return jsonify({"status": "ok"})


@app.get("/data")
def get_data():
    doc = get_db().press_data.find_one({})
    if doc is None:
        return jsonify([])
    doc["_id"] = str(doc["_id"])
    return jsonify([doc])


@app.get("/api/press/status")
def press_status():
    """"stalled" here means a genuinely abnormal gap - never true while
    Extrusion Active is live (that's just a billet still mid-stroke, no
    matter how long it's been since the last one *completed*), and scored
    against this profile/die's own baseline (the same one billet_monitor.py
    scores completed gaps against) rather than one fixed threshold, so a
    fast-cycling small profile and a slow large one are each judged against
    what's actually normal for them."""
    db = get_db()
    latest_state = db.state_events.find_one(sort=[("ts_start", -1)], projection={"_id": False})
    latest_billet = db.billet_cycles.find_one(sort=[("ts", -1)], projection={"_id": False})
    live = db.press_data.find_one(
        {},
        projection={
            billet_monitor.FLD_EXTRUSION_ACTIVE: True,
            billet_monitor.FLD_PROFILE: True,
            billet_monitor.FLD_DIE_COPY: True,
        },
    )
    extrusion_active = bool(live.get(billet_monitor.FLD_EXTRUSION_ACTIVE)) if live else None

    seconds_since_last_billet = None
    expected_gap_s = None
    stalled = False
    if latest_billet and latest_billet.get("ts"):
        last_billet_ts = datetime.fromisoformat(latest_billet["ts"])
        seconds_since_last_billet = (datetime.now() - last_billet_ts).total_seconds()
        is_running = bool(latest_state) and latest_state.get("state") == billet_monitor.RUNNING

        if is_running and not extrusion_active:
            profile = live.get(billet_monitor.FLD_PROFILE) if live else None
            die_copy = live.get(billet_monitor.FLD_DIE_COPY) if live else None
            baseline = billet_monitor.gap_baseline(db, profile, die_copy) if profile is not None else None
            expected_gap_s = (
                billet_monitor.expected_gap_s(baseline) if baseline else BILLET_STALL_FALLBACK_THRESHOLD_S
            )
            stalled = seconds_since_last_billet > expected_gap_s

    return jsonify(
        state=latest_state,
        latest_billet=latest_billet,
        seconds_since_last_billet=seconds_since_last_billet,
        extrusion_active=extrusion_active,
        expected_gap_s=expected_gap_s,
        stalled=stalled,
    )


@app.get("/api/press/billets/recent")
def billets_recent():
    limit = min(int(request.args.get("limit", 50)), 200)
    db = get_db()
    billets = list(db.billet_cycles.find(sort=[("ts", -1)], limit=limit, projection={"_id": False}))
    return jsonify(billets=billets)


def _clipped_seconds(ts_start_iso, ts_end_iso, window_start, window_end):
    start = max(datetime.fromisoformat(ts_start_iso), window_start)
    end = min(datetime.fromisoformat(ts_end_iso) if ts_end_iso else window_end, window_end)
    return max((end - start).total_seconds(), 0.0)


@app.get("/api/press/uptime")
def press_uptime():
    """Total RUNNING (uptime) vs IDLE (downtime, broken down by reason)
    over a trailing window - state_events is the same RUNNING/IDLE/UNKNOWN
    ledger Granco Saw Monitor keeps for the saw, driven here by the
    press's "Automatic Mode Active" tag instead of the saw's AUTO_MODE
    (see billet_monitor.py). uptime_pct is against the covered portion of
    the window (excludes any UNKNOWN/no-data gap, e.g. before this
    feature was deployed), not the raw window length."""
    hours = min(float(request.args.get("hours", 24)), MAX_UPTIME_WINDOW_HOURS)
    now = datetime.now()
    window_start = now - timedelta(hours=hours)

    db = get_db()
    events = db.state_events.find(
        {"ts_start": {"$lt": now.isoformat()},
         "$or": [{"ts_end": None}, {"ts_end": {"$gt": window_start.isoformat()}}]},
        projection={"_id": False},
    )

    uptime_seconds = 0.0
    downtime_by_reason = {}
    unknown_seconds = 0.0
    for event in events:
        secs = _clipped_seconds(event["ts_start"], event.get("ts_end"), window_start, now)
        if event["state"] == billet_monitor.RUNNING:
            uptime_seconds += secs
        elif event["state"] == billet_monitor.IDLE:
            reason = event.get("reason") or "Unspecified"
            downtime_by_reason[reason] = downtime_by_reason.get(reason, 0.0) + secs
        else:
            unknown_seconds += secs

    downtime_seconds = sum(downtime_by_reason.values())
    covered_seconds = uptime_seconds + downtime_seconds + unknown_seconds
    uptime_pct = round(uptime_seconds / covered_seconds * 100, 1) if covered_seconds else None

    current = db.state_events.find_one(sort=[("ts_start", -1)], projection={"_id": False})

    return jsonify(
        window_hours=hours,
        uptime_seconds=uptime_seconds,
        downtime_seconds=downtime_seconds,
        downtime_by_reason=downtime_by_reason,
        unknown_seconds=unknown_seconds,
        uptime_pct=uptime_pct,
        current_state=current.get("state") if current else None,
        current_reason=current.get("reason") if current else None,
        current_state_since=current.get("ts_start") if current else None,
    )


@app.get("/api/press/cycle-breakdown")
def cycle_breakdown():
    """Where the press's time actually went, billet by billet - a finer,
    complementary view to /api/press/uptime's press-control-mode timeline.
    Automatic Mode staying on through the normal gap between billets isn't
    downtime, so that endpoint alone can't answer "is the press actually
    producing". This one can, using the dead_cycle/cleanout/die_change/
    stoppage split billet_monitor.py computes per billet (see its module
    docstring for the full reasoning, ported from Press History UI's
    per-profile/die-copy baseline methodology).

    stoppage_total_s combines stoppage_s (an abnormally long gap *before*
    a billet, beyond that profile/die's own recent baseline) and
    in_billet_stall_s (ram speed reading ~0 *during* a billet) - both are
    real, unexplained stalls, just at different points in the cycle."""
    hours = min(float(request.args.get("hours", 24)), MAX_UPTIME_WINDOW_HOURS)
    window_start = (datetime.now() - timedelta(hours=hours)).isoformat()

    db = get_db()
    billets = list(db.billet_cycles.find(
        {"ts": {"$gte": window_start}},
        projection={
            "_id": False, "extrusion_duration_s": True, "gap_before_s": True,
            "dead_cycle_s": True, "stoppage_s": True, "in_billet_stall_s": True,
            "is_startup": True, "is_cleanout": True, "is_die_change": True,
        },
    ))

    totals = {
        "extrusion_s": 0.0, "dead_cycle_s": 0.0, "cleanout_s": 0.0,
        "die_change_s": 0.0, "startup_s": 0.0, "stoppage_s": 0.0, "in_billet_stall_s": 0.0,
    }
    for b in billets:
        totals["extrusion_s"] += b.get("extrusion_duration_s") or 0.0
        totals["in_billet_stall_s"] += b.get("in_billet_stall_s") or 0.0
        gap = b.get("gap_before_s") or 0.0
        if b.get("is_startup"):
            totals["startup_s"] += gap
        elif b.get("is_cleanout"):
            totals["cleanout_s"] += gap
        elif b.get("is_die_change"):
            totals["die_change_s"] += gap
        else:
            totals["dead_cycle_s"] += b.get("dead_cycle_s") or 0.0
            totals["stoppage_s"] += b.get("stoppage_s") or 0.0

    accounted_seconds = sum(totals.values())
    totals["stoppage_total_s"] = totals["stoppage_s"] + totals["in_billet_stall_s"]

    return jsonify(
        window_hours=hours,
        billet_count=len(billets),
        accounted_seconds=accounted_seconds,
        **totals,
    )


@app.get("/health")
def health_check():
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

import os
from datetime import datetime, timedelta

from flask import Flask, jsonify, request
from flask_cors import CORS

import billet_monitor
from db import ensure_indexes, get_db

app = Flask(__name__)
CORS(app)

# Mirrors Granco Saw Monitor's /api/status stall detection - flags when
# the press claims to be RUNNING but hasn't finished a billet in far
# longer than a normal cycle would take (billet_monitor.py's collector is
# down, or the press really is stuck mid-cycle).
BILLET_STALL_THRESHOLD_S = 10 * 60
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
    db = get_db()
    latest_state = db.state_events.find_one(sort=[("ts_start", -1)], projection={"_id": False})
    latest_billet = db.billet_cycles.find_one(sort=[("ts", -1)], projection={"_id": False})

    seconds_since_last_billet = None
    stalled = False
    if latest_billet and latest_billet.get("ts"):
        last_billet_ts = datetime.fromisoformat(latest_billet["ts"])
        seconds_since_last_billet = (datetime.now() - last_billet_ts).total_seconds()
        is_running = bool(latest_state) and latest_state.get("state") == billet_monitor.RUNNING
        stalled = is_running and seconds_since_last_billet > BILLET_STALL_THRESHOLD_S

    return jsonify(
        state=latest_state,
        latest_billet=latest_billet,
        seconds_since_last_billet=seconds_since_last_billet,
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


@app.get("/health")
def health_check():
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

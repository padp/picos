import os
from datetime import date, datetime, time, timedelta

from bson import ObjectId
from bson.errors import InvalidId
from flask import Flask, jsonify, request
from flask_cors import CORS

import alerts
import billet_monitor
from billet_monitor import plant_now
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

# Same shift boundaries as Granco Saw Monitor's api/app.py and Press
# History UI's get_press_uptime.py - this plant runs one shift schedule,
# not a per-tool one, so all three should report the same shift for the
# same moment. Third shift crosses midnight; its label date is the date
# its early-morning half falls on (see _current_date_and_shift), matching
# both sibling projects exactly.
SHIFT_NAMES = ["First Shift", "Second Shift", "Third Shift"]
_FIRST_START = (6, 50)
_SECOND_START = (14, 50)
_THIRD_START = (22, 50)


def _shift_name_for(t: tuple) -> str:
    if t >= _THIRD_START or t < _FIRST_START:
        return "Third Shift"
    if t < _SECOND_START:
        return "First Shift"
    return "Second Shift"


def _current_date_and_shift(now: datetime) -> tuple:
    t = (now.hour, now.minute)
    shift = _shift_name_for(t)
    if shift == "Third Shift" and t >= _THIRD_START:
        label_date = (now + timedelta(hours=1, minutes=30)).date()
    else:
        label_date = now.date()
    return label_date.isoformat(), shift


def _shift_window(date_str: str, shift_name: str) -> tuple:
    d = date.fromisoformat(date_str)
    if shift_name == "First Shift":
        return datetime.combine(d, time(*_FIRST_START)), datetime.combine(d, time(*_SECOND_START))
    if shift_name == "Second Shift":
        return datetime.combine(d, time(*_SECOND_START)), datetime.combine(d, time(*_THIRD_START))
    return datetime.combine(d - timedelta(days=1), time(*_THIRD_START)), datetime.combine(d, time(*_FIRST_START))


def _resolve_shift_params():
    """date+shift from the query string, defaulting to whatever shift is
    live right now if either is missing/invalid - so a plain GET with no
    params (the dashboard's initial load) always lands on the current shift."""
    date_str = request.args.get("date")
    shift_name = request.args.get("shift")
    if not date_str or shift_name not in SHIFT_NAMES:
        date_str, shift_name = _current_date_and_shift(plant_now())
    window_start, window_end = _shift_window(date_str, shift_name)
    # A shift still in progress has a window_end in the future - clip to
    # now so it isn't scored as if the remaining, not-yet-happened part of
    # the shift were uncovered/unknown time.
    window_end = min(window_end, plant_now())
    return date_str, shift_name, window_start, window_end


if os.environ.get("SQL_PASS"):
    # Skipped at build time (no SQL_PASS yet) - runs at import time so it
    # also happens under gunicorn, not just `python app.py`. Same guard
    # Granco Saw Monitor's api/app.py uses.
    ensure_indexes()
    # state_events has no uniqueness constraint (unlike billet_cycles'
    # upsert-on-billet_key), so a second poller instance pointed at the
    # same production DB - e.g. a local dev copy of this app running
    # alongside the real Render deployment - writes its own independent,
    # overlapping RUNNING/IDLE stream instead of being deduplicated,
    # double-counting real time. POLL_DISABLED lets a local/dev instance
    # serve reads against production Mongo without also polling it - also
    # keeps a local instance from firing real pushes to whatever ntfy
    # topics real users have already subscribed to.
    if not os.environ.get("POLL_DISABLED"):
        billet_monitor.start_background_poller()
        alerts.start_background_alert_poller()


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
        seconds_since_last_billet = (plant_now() - last_billet_ts).total_seconds()
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
    """All billets in the selected shift (see _resolve_shift_params),
    newest first. limit is just a safety cap, not the primary way of
    bounding this - a shift naturally bounds it to a normal-sized list."""
    limit = min(int(request.args.get("limit", 200)), 500)
    date_str, shift_name, window_start, window_end = _resolve_shift_params()
    db = get_db()
    billets = list(db.billet_cycles.find(
        {"ts": {"$gte": window_start.isoformat(), "$lt": window_end.isoformat()}},
        sort=[("ts", -1)], limit=limit, projection={"_id": False},
    ))
    return jsonify(date=date_str, shift=shift_name, billets=billets)


@app.get("/api/press/stoppages")
def stoppages():
    """Individual unexplained-stoppage instances in the selected shift -
    each tied to the specific billet it happened around (profile, die
    copy, billet number), unlike /api/press/uptime's state_events, which
    only know a reason (Emergency/Setup/Manual/...), not which billet was
    involved. total_stoppage_s combines a gap-before-billet stoppage and
    an in-billet stall - see billet_monitor.py's module docstring."""
    date_str, shift_name, window_start, window_end = _resolve_shift_params()
    db = get_db()
    rows = list(db.billet_cycles.find(
        {
            "ts": {"$gte": window_start.isoformat(), "$lt": window_end.isoformat()},
            "$or": [{"stoppage_s": {"$gt": 0}}, {"in_billet_stall_s": {"$gt": 0}}],
        },
        sort=[("ts", -1)],
        projection={
            "_id": False, "ts": True, "profile": True, "die_copy": True,
            "job_number": True, "billet_number_per_order": True,
            "stoppage_s": True, "in_billet_stall_s": True,
        },
    ))
    for row in rows:
        row["total_stoppage_s"] = (row.get("stoppage_s") or 0.0) + (row.get("in_billet_stall_s") or 0.0)

    return jsonify(date=date_str, shift=shift_name, stoppages=rows)


@app.get("/api/press/uptime")
def press_uptime():
    """Total RUNNING (uptime) vs IDLE (downtime, broken down by reason)
    over the selected shift - state_events is the same RUNNING/IDLE/UNKNOWN
    ledger Granco Saw Monitor keeps for the saw, driven here by the
    press's "Automatic Mode Active" tag instead of the saw's AUTO_MODE
    (see billet_monitor.py). uptime_pct is against the covered portion of
    the window (excludes any UNKNOWN/no-data gap, e.g. before this
    feature was deployed), not the raw window length.

    state_events has no uniqueness constraint (unlike billet_cycles'
    upsert-on-billet_key), so a second poller instance pointed at the same
    production DB - e.g. a local dev copy of this app run alongside the
    real deployment without POLL_DISABLED - writes its own independent,
    overlapping RUNNING/IDLE stream instead of being deduplicated. Rather
    than trust the stored events to already be a clean non-overlapping
    timeline, this coalesces them into one before summing: events are
    clipped to the window and sorted by start, and each only contributes
    the portion of its span not already covered by an earlier-starting
    event, so an exact or partial duplicate contributes zero (or just its
    new portion) instead of double-counting real time."""
    date_str, shift_name, window_start, window_end = _resolve_shift_params()

    db = get_db()
    events = db.state_events.find(
        {"ts_start": {"$lt": window_end.isoformat()},
         "$or": [{"ts_end": None}, {"ts_end": {"$gt": window_start.isoformat()}}]},
        projection={"_id": False},
    )

    intervals = []
    for event in events:
        start = max(datetime.fromisoformat(event["ts_start"]), window_start)
        end = min(datetime.fromisoformat(event["ts_end"]) if event.get("ts_end") else window_end, window_end)
        if end > start:
            intervals.append((start, end, event["state"], event.get("reason")))
    intervals.sort(key=lambda iv: iv[0])

    uptime_seconds = 0.0
    downtime_by_reason = {}
    unknown_seconds = 0.0
    covered_until = window_start
    for start, end, state, reason in intervals:
        eff_start = max(start, covered_until)
        if end <= eff_start:
            continue
        secs = (end - eff_start).total_seconds()
        if state == billet_monitor.RUNNING:
            uptime_seconds += secs
        elif state == billet_monitor.IDLE:
            reason = reason or "Unspecified"
            downtime_by_reason[reason] = downtime_by_reason.get(reason, 0.0) + secs
        else:
            unknown_seconds += secs
        covered_until = max(covered_until, end)

    downtime_seconds = sum(downtime_by_reason.values())
    covered_seconds = uptime_seconds + downtime_seconds + unknown_seconds
    uptime_pct = round(uptime_seconds / covered_seconds * 100, 1) if covered_seconds else None

    current = db.state_events.find_one(sort=[("ts_start", -1)], projection={"_id": False})

    return jsonify(
        date=date_str,
        shift=shift_name,
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
    """Where the press's time actually went, billet by billet, over the
    selected shift - a finer, complementary view to /api/press/uptime's
    press-control-mode timeline. Automatic Mode staying on through the
    normal gap between billets isn't downtime, so that endpoint alone
    can't answer "is the press actually producing". This one can, using
    the dead_cycle/cleanout/die_change/stoppage split billet_monitor.py
    computes per billet (see its module docstring for the full reasoning,
    ported from Press History UI's per-profile/die-copy baseline
    methodology).

    stoppage_total_s combines stoppage_s (an abnormally long gap *before*
    a billet, beyond that profile/die's own recent baseline) and
    in_billet_stall_s (ram speed reading ~0 *during* a billet) - both are
    real, unexplained stalls, just at different points in the cycle.

    startup_s is NOT gap time - it's how much LONGER a run's first billet
    took to extrude than normal (see billet_monitor.py's module
    docstring), so it's a subset of that billet's own extrusion_duration_s
    rather than additional elapsed time. extrusion_s below is the
    remainder after pulling startup_s back out, so the totals still sum
    to the shift's real elapsed time without double-counting it."""
    date_str, shift_name, window_start, window_end = _resolve_shift_params()

    db = get_db()
    billets = list(db.billet_cycles.find(
        {"ts": {"$gte": window_start.isoformat(), "$lt": window_end.isoformat()}},
        projection={
            "_id": False, "extrusion_duration_s": True, "gap_before_s": True,
            "dead_cycle_s": True, "stoppage_s": True, "startup_s": True,
            "in_billet_stall_s": True, "is_cleanout": True, "is_die_change": True,
        },
    ))

    totals = {
        "extrusion_s": 0.0, "dead_cycle_s": 0.0, "cleanout_s": 0.0,
        "die_change_s": 0.0, "startup_s": 0.0, "stoppage_s": 0.0, "in_billet_stall_s": 0.0,
    }
    for b in billets:
        startup = b.get("startup_s") or 0.0
        totals["extrusion_s"] += (b.get("extrusion_duration_s") or 0.0) - startup
        totals["startup_s"] += startup
        totals["in_billet_stall_s"] += b.get("in_billet_stall_s") or 0.0
        gap = b.get("gap_before_s") or 0.0
        if b.get("is_cleanout"):
            totals["cleanout_s"] += gap
        elif b.get("is_die_change"):
            totals["die_change_s"] += gap
        else:
            totals["dead_cycle_s"] += b.get("dead_cycle_s") or 0.0
            totals["stoppage_s"] += b.get("stoppage_s") or 0.0

    accounted_seconds = sum(totals.values())
    totals["stoppage_total_s"] = totals["stoppage_s"] + totals["in_billet_stall_s"]

    return jsonify(
        date=date_str,
        shift=shift_name,
        billet_count=len(billets),
        accounted_seconds=accounted_seconds,
        **totals,
    )


def _serialize_rule(rule):
    rule["_id"] = str(rule["_id"])
    for trigger in rule.get("triggers", []):
        trigger["description"] = alerts.describe_trigger(trigger)
    return rule


@app.get("/api/alerts/tags")
def alerts_tags():
    """Everything the trigger builder needs that isn't user-entered:
    every press_data field it can be built against (bool or numeric
    only - see alerts.list_available_tags) plus the comparator/bool-mode
    wording and repeat-mode options, defined once in alerts.py rather
    than duplicated in the frontend."""
    return jsonify(
        tags=alerts.list_available_tags(get_db()),
        comparators=alerts.comparator_options(),
        bool_modes=alerts.bool_mode_options(),
        repeat_modes=list(alerts.REPEAT_MODES),
    )


@app.get("/api/alerts")
def alerts_list():
    db = get_db()
    rules = list(db.alert_rules.find({}, sort=[("created_at", -1)]))
    return jsonify(alerts=[_serialize_rule(r) for r in rules])


@app.post("/api/alerts")
def alerts_create():
    """Creates a new alert - a fresh randomly-generated ntfy topic plus
    the trigger set the request body describes. The frontend renders the
    returned topic as a QR code (https://ntfy.sh/<topic>) right away so
    the person creating it can subscribe their phone in one scan."""
    payload = request.get_json(force=True, silent=True) or {}
    doc, err = alerts.build_rule_doc(payload)
    if err:
        return jsonify(error=err), 400
    db = get_db()
    doc["topic"] = alerts.generate_topic(db)
    result = db.alert_rules.insert_one(doc)
    doc["_id"] = result.inserted_id
    return jsonify(_serialize_rule(doc)), 201


@app.patch("/api/alerts/<rule_id>")
def alerts_update(rule_id):
    """Only toggles active (enable/disable the whole topic without
    deleting it) - editing triggers goes through delete + re-create,
    since a topic's QR code/subscription doesn't change either way."""
    payload = request.get_json(force=True, silent=True) or {}
    if not isinstance(payload.get("active"), bool):
        return jsonify(error="active must be true/false"), 400
    db = get_db()
    try:
        oid = ObjectId(rule_id)
    except InvalidId:
        return jsonify(error="invalid id"), 400
    result = db.alert_rules.update_one({"_id": oid}, {"$set": {"active": payload["active"]}})
    if result.matched_count == 0:
        return jsonify(error="not found"), 404
    return jsonify(ok=True)


@app.delete("/api/alerts/<rule_id>")
def alerts_delete(rule_id):
    db = get_db()
    try:
        oid = ObjectId(rule_id)
    except InvalidId:
        return jsonify(error="invalid id"), 400
    result = db.alert_rules.delete_one({"_id": oid})
    if result.deleted_count == 0:
        return jsonify(error="not found"), 404
    return jsonify(ok=True)


@app.get("/health")
def health_check():
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

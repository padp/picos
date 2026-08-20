"""Billet-cycle and press uptime/downtime detection.

Mirrors Granco Saw Monitor's collector/detector split (see that project's
collector/detector.py), but simplified for this press: there's no direct
PLC connection here at all. picos/api/GetSendPressDataToDB.py already
polls the press PLC continuously and replaces a single "current state"
document in press_db.press_data (see db.py) - this module just polls
*that* document instead of the PLC itself, the same way Fetch Log Data's
billet_log.py already does for its own (separate) billet ledger. That
avoids a second concurrent PLC connection and means this can run as a
background thread inside this same Flask process rather than needing a
new always-on local service.

Two independent signals drive detection, both far more direct than
anything Granco had available for the saw:
  - "Automatic Mode Active (Bool)" is this press's equivalent of
    Granco's AUTO_MODE - stays true across many billets, only drops for
    a real interruption (die change, manual intervention, e-stop,
    setup). Drives state_events (RUNNING/IDLE/UNKNOWN), i.e. the coarse
    press-control-mode timeline.
  - "Extrusion Active (Bool)" is true for exactly the duration of one
    billet's extrusion stroke, false during the loader/transfer gap
    before the next one - a direct edge to key billet_cycles rows off
    of, unlike Granco's saw which had no reliable "mid-cut" signal and
    had to infer cuts from backgauge hold patterns.

state_events alone isn't a trustworthy uptime/downtime signal by itself:
Automatic Mode stays true through the entirely normal, expected gap
between billets (discard shear + next billet load), so treating "not
RUNNING" as "down" would count routine per-cycle overhead as downtime.
What actually answers "is the press really producing" is the
per-billet gap classification below - ported from the mature, already
validated methodology in the sibling Press History UI project
(v2/fingerprint_engines.py's is_cleanout_cycle and
v2/anomaly_detection.py's per-(profile,die) baseline/z-score approach,
built from a 3-year, 250k+ billet archive) so the two projects'
numbers agree rather than drifting apart:
  - dead_cycle_s: the normal, expected gap between billets (discard
    shear + reload) - anything within ~3 std devs of this (profile,
    die_copy)'s own recent baseline.
  - cleanout_s: a gap where the alloy changed out of the cleanout
    family (6005/6008/6082) into a different family - these presses
    need a physical container cleanout for that, unrelated to a normal
    per-billet gap or an actual fault.
  - die_change_s: a gap where the Die Copy value itself changed, or
    "Die Change Active" was flagged at some point during the gap.
  - stoppage_s: whatever's left over beyond the baseline once
    startup/cleanout/die-change are excluded - a genuine, unexplained
    stall *before* a billet starts.
  - in_billet_stall_s: ram speed reading ~0 while Extrusion Active was
    still true - a stall *during* a billet, not between them.

Assumes a single poller instance (matches this app's likely single
gunicorn worker on Render's free tier - no Procfile/render.yaml pins the
worker count, so this isn't hard-guaranteed). billet_cycles writes are
upserted by billet_key (job number + both billet counters) specifically
so a hypothetical second concurrent poller - or this one restarting
mid-billet - collapses onto the same row instead of duplicating it,
rather than building out full leader-election for a case that's likely
moot.
"""
import statistics
import threading
import time
from datetime import datetime

from db import ensure_indexes, get_db

POLL_INTERVAL_S = 2.0
# GetSendPressDataToDB.py normally updates press_data roughly every
# 0.5-1s (see its main loop) - a gap this long means the writer or its
# PLC connection is down, not just a slow poll.
STALE_THRESHOLD_S = 180

RUNNING = "RUNNING"
IDLE = "IDLE"
UNKNOWN = "UNKNOWN"

FLD_DATETIME = "Date/Time"
FLD_AUTO_MODE = "Automatic Mode Active (Bool)"
FLD_EXTRUSION_ACTIVE = "Extrusion Active (Bool)"
FLD_EMERGENCY = "Emergency Mode Active (Bool)"
FLD_DIE_CHANGE = "Die Change Active (Bool)"
FLD_SETUP = "Set-Up Mode Active (Bool)"
FLD_MANUAL = "Manual Mode Active (Bool)"
FLD_ALLOY = "Alloy"
FLD_PROFILE = "Profile"
FLD_DIE_COPY = "Die Copy"
FLD_JOB_NUMBER = "Job Number (#)"
FLD_BILLET_NO_ORDER = "Billet Number (per Order)"
FLD_BILLET_NO_DIE = "Billet Number (per Die)"
FLD_SCHEDULED_BILLETS = "Scheduled Billets"
FLD_BILLET_LEN_SETPOINT = "Billet Length Setpoint (in)"
FLD_BILLET_LEN_ACTUAL = "Billet Length Actual (in)"
FLD_BUTT_LEN_SETPOINT = "Butt Length Setpoint (in)"
FLD_BUTT_LEN_ACTUAL = "Butt Length Actual (in)"
FLD_BILLET_TEMP_SETPOINT = "Billet Temperature Setpoint (F)"
FLD_BILLET_TEMP_ACTUAL = "Billet Temperature Actual (F)"
FLD_STEM_SPEED = "Current Ram Speed (in/min)"
FLD_STEM_PRESSURE = "Stem Pressure (psi)"
FLD_EXTRUSION_FORCE_MAX = "Maximum Extrusion Force (UST)"
FLD_FORCE_MAX = "Maximum Force (UST)"
FLD_BREAKTHROUGH_PRESSURE = "Breakthrough Pressure (psi)"
FLD_EXTRUSION_TIME = "Elapsed Extrusion Time (sec)"
FLD_PROFILE_SPEED = "Profile Speed (ft/min)"
FLD_PRESS_HYD_TEMP = "Press Hydraulic Fluid Temperature (F)"

# code -> friendly name. Mirrors Fetch Log Data/collector/press.py's
# ALLOY_MAP - kept as its own copy rather than an import across that
# separate project, same reasoning Granco's api/app.py gives for not
# importing its sibling collector/ package: don't couple across an
# uncertain deployment boundary. Keep in sync if it ever changes there.
ALLOY_MAP = {
    "006005": "8-6005A",
    "066099": "8-6063 B",
    "006063": "8-6063 GP",
    "006008": "8-6008",
    "006082": "8-6082",
}

# Checked in this order when Automatic Mode drops, so a die change during
# an e-stop (say) is attributed to the more specific cause.
_IDLE_REASON_FIELDS = [
    (FLD_EMERGENCY, "Emergency"),
    (FLD_DIE_CHANGE, "Die Change"),
    (FLD_SETUP, "Setup"),
    (FLD_MANUAL, "Manual"),
]

# Tracked as a running max across every poll while Extrusion Active is
# true, rather than read once from the doc at the True->False instant -
# confirmed live that "Elapsed Extrusion Time (sec)" resets to 0 the
# moment extrusion ends, so a completion-instant read silently recorded
# 0 for every billet instead of its real duration. The PLC-reported
# "Maximum ..." force fields are carried the same way defensively: two
# billets ~15 minutes and 7 billets apart read identical peak-force
# values, suggesting that register may not reset per-billet either (a
# running order/session high-water mark, not this billet's own peak) -
# tracking our own max during the active window sidesteps needing to
# know that register's true reset semantics at all. Note this still
# reads at the poll's resolution (POLL_INTERVAL_S), not the PLC's true
# instant peak.
_PEAK_FIELDS = [
    ("stem_speed_peak_in_min", FLD_STEM_SPEED),
    ("stem_pressure_peak_psi", FLD_STEM_PRESSURE),
    ("profile_speed_peak_ft_min", FLD_PROFILE_SPEED),
    ("extrusion_time_s", FLD_EXTRUSION_TIME),
    ("extrusion_force_peak_ust", FLD_EXTRUSION_FORCE_MAX),
    ("press_force_peak_ust", FLD_FORCE_MAX),
    ("breakthrough_pressure_psi", FLD_BREAKTHROUGH_PRESSURE),
]

# Alloys that require a physical container cleanout when the press moves
# away from this family to a different one. Ported from Press History
# UI's v2/fingerprint_engines.py::is_cleanout_cycle, itself a bug fix over
# die-change-time-logger.py's original (which only ever matched alloys
# containing '6005' due to a for/else that short-circuited on the first
# list entry regardless of match).
CLEANOUT_ALLOY_FAMILY = ["6005", "6008", "6082"]

# Ram speed at/below this reads as "not actually moving" - matches Press
# History UI's get_press_uptime.py threshold (current_speed <= 0.1)
# exactly, so an in-billet stall reads the same amount of stall time in
# both projects for the same raw data.
STALL_RAM_SPEED_EPSILON = 0.1

# Per-(profile, die_copy) baseline for a "normal" between-billet gap,
# ported from Press History UI's v2/anomaly_detection.py: mean/std over
# the group's own recent history, z_threshold=3.0, a group needs at least
# this many eligible (non-startup/cleanout/die-change) samples before
# it's trusted - matches that module's min_group_size=15 default. The
# 1800s cap when *fitting* the baseline (not when scoring against it) is
# the same value that module derived from its 3-year/250k-billet archive:
# real gaps cluster tightly (median 156s, p99 461s) while genuine
# stoppages run multiple hours - 1800s sits in the clear gap between the
# two, so one historical monster outlier can't drag a group's mean up
# and mask real (but shorter) stoppages against it.
GAP_BASELINE_LOOKBACK = 30
GAP_BASELINE_MIN_SAMPLES = 15
GAP_BASELINE_CAP_S = 1800
GAP_BASELINE_Z_THRESHOLD = 3.0


def is_cleanout_cycle(last_alloy, next_alloy):
    """True when transitioning OUT of the cleanout alloy family into a
    different one - not just "the alloy changed". See CLEANOUT_ALLOY_FAMILY."""
    if not last_alloy or not next_alloy or last_alloy == next_alloy:
        return False
    if not any(fam in last_alloy for fam in CLEANOUT_ALLOY_FAMILY):
        return False
    return not any(fam in next_alloy for fam in CLEANOUT_ALLOY_FAMILY)


def _parse_press_datetime(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%m/%d/%Y %H:%M:%S")
    except ValueError:
        return None


def _billet_key(job_number, billet_no_order, billet_no_die):
    def _fmt(n):
        return f"{n:g}" if isinstance(n, (int, float)) else str(n)
    return f"{job_number or 'unknown'}|{_fmt(billet_no_order)}|{_fmt(billet_no_die)}"


def gap_baseline(db, profile, die_copy):
    """Mean/std of this (profile, die_copy)'s recent normal (non-startup/
    cleanout/die-change) between-billet gaps, or None if there isn't
    enough history yet to trust one - see GAP_BASELINE_MIN_SAMPLES.

    Module-level (not a Detector method) so app.py's live "is this stall
    actually abnormal" check (/api/press/status) can call the exact same
    baseline the poller itself scores completed gaps against, without
    needing a Detector instance."""
    cursor = db.billet_cycles.find(
        {
            "profile": profile,
            "die_copy": die_copy,
            "is_startup": False,
            "is_cleanout": False,
            "is_die_change": False,
            "gap_before_s": {"$ne": None},
        },
        sort=[("ts", -1)],
        limit=GAP_BASELINE_LOOKBACK,
        projection={"gap_before_s": True},
    )
    samples = [min(row["gap_before_s"], GAP_BASELINE_CAP_S) for row in cursor]
    if len(samples) < GAP_BASELINE_MIN_SAMPLES:
        return None
    mean = statistics.fmean(samples)
    std = statistics.pstdev(samples, mean) if len(samples) > 1 else 0.0
    return {"mean": mean, "std": std, "n": len(samples)}


def expected_gap_s(baseline):
    """The gap length beyond which a (profile, die_copy)'s baseline calls
    it a stoppage rather than normal dead cycle time."""
    return baseline["mean"] + GAP_BASELINE_Z_THRESHOLD * baseline["std"]


class Detector:
    def __init__(self, db):
        self._db = db
        self._state = UNKNOWN
        self._state_event_id = None
        self._prev_extrusion_active = False
        self._last_billet_ts = None
        self._extrusion_start_ts = None
        self._in_billet_stall_s = 0.0
        self._die_change_flagged_during_gap = False
        self._peaks = {name: None for name, _field in _PEAK_FIELDS}

        # Staleness is judged by whether press_data's own Date/Time value
        # is still advancing, measured against this process's monotonic
        # clock - NOT by comparing that timestamp to this process's
        # datetime.now(). GetSendPressDataToDB.py runs on a different
        # machine (the plant floor PC with PLC access) whose wall clock
        # isn't guaranteed to be in sync with wherever this API runs;
        # confirmed live a few minutes' drift between the two, which a
        # direct now()-vs-doc-timestamp comparison mistook for a stalled
        # writer every time. Comparing "has this value changed recently"
        # instead sidesteps clock sync entirely.
        self._last_seen_dt_str = None
        self._last_change_monotonic = time.monotonic()

        # Recovered so the first billet after a restart doesn't spuriously
        # look like a startup/cleanout/die-change event just because this
        # process's own memory of the previous billet was reset.
        self._prev_billet_job_number = None
        self._prev_billet_alloy = None
        self._prev_billet_die_copy = None
        last = db.billet_cycles.find_one(sort=[("ts", -1)])
        if last and last.get("ts"):
            self._last_billet_ts = datetime.fromisoformat(last["ts"])
            self._prev_billet_job_number = last.get("job_number")
            self._prev_billet_alloy = last.get("alloy_code")
            self._prev_billet_die_copy = last.get("die_copy")

        # A state_event left open (ts_end None) from a prior process that
        # went away without a clean shutdown - close it out at "now"
        # rather than let it dangle open forever. The gap between then and
        # now is simply uncovered, not mis-recorded as extra RUNNING/IDLE
        # time either way.
        now_iso = datetime.now().isoformat()
        db.state_events.update_many(
            {"ts_end": None}, {"$set": {"ts_end": now_iso}}
        )

    def process(self, doc, poll_monotonic: float):
        # press_data briefly reads back empty on a real, live poll every
        # so often (confirmed against production - roughly 1 in 10-15
        # polls at a 2s interval, not a bug on this side) - a lone empty
        # read must NOT immediately flag stale, only a read that stays
        # empty/unchanged for STALE_THRESHOLD_S straight should. Only a
        # genuine (non-None) new value ever advances the "last seen"
        # clock; a transient gap just leaves it counting from whenever
        # real data was last seen.
        dt_str = doc.get(FLD_DATETIME) if doc else None
        if dt_str is not None and dt_str != self._last_seen_dt_str:
            self._last_seen_dt_str = dt_str
            self._last_change_monotonic = poll_monotonic

        if (poll_monotonic - self._last_change_monotonic) > STALE_THRESHOLD_S:
            ts = _parse_press_datetime(self._last_seen_dt_str) or datetime.now()
            self._update_state(ts, UNKNOWN, "Stale Data")
            self._prev_extrusion_active = False
            return

        if dt_str is None:
            return  # transient empty read, not yet stale - just skip this tick

        ts = _parse_press_datetime(dt_str)
        if ts is None:
            return  # malformed timestamp - skip this tick defensively

        auto_mode = doc.get(FLD_AUTO_MODE)
        if auto_mode is None:
            new_state, reason = UNKNOWN, None
        elif auto_mode:
            new_state, reason = RUNNING, None
        else:
            new_state = IDLE
            reason = next(
                (label for field, label in _IDLE_REASON_FIELDS if doc.get(field)),
                None,
            )
        self._update_state(ts, new_state, reason)
        self._track_extrusion(ts, doc)

    def _update_state(self, ts, new_state, reason):
        if new_state == self._state:
            return
        ts_iso = ts.isoformat()
        if self._state_event_id is not None:
            self._db.state_events.update_one(
                {"_id": self._state_event_id}, {"$set": {"ts_end": ts_iso}}
            )
        result = self._db.state_events.insert_one(
            {"ts_start": ts_iso, "ts_end": None, "state": new_state, "reason": reason}
        )
        self._state_event_id = result.inserted_id
        self._state = new_state

    def _track_extrusion(self, ts, doc):
        active = bool(doc.get(FLD_EXTRUSION_ACTIVE))
        if active:
            if not self._prev_extrusion_active:
                self._peaks = {name: None for name, _field in _PEAK_FIELDS}
                self._extrusion_start_ts = ts
                self._in_billet_stall_s = 0.0
            for name, field in _PEAK_FIELDS:
                value = doc.get(field)
                if value is not None:
                    current = self._peaks[name]
                    self._peaks[name] = value if current is None else max(current, value)
            ram_speed = doc.get(FLD_STEM_SPEED)
            if ram_speed is not None and abs(ram_speed) <= STALL_RAM_SPEED_EPSILON:
                self._in_billet_stall_s += POLL_INTERVAL_S
        else:
            if self._prev_extrusion_active:
                self._emit_billet_cycle(ts, doc)
            elif doc.get(FLD_DIE_CHANGE):
                # Only meaningful between billets - a die change can't
                # start mid-extrusion, and _emit_billet_cycle resets this
                # flag once it's been consumed by the billet it applies to.
                self._die_change_flagged_during_gap = True
        self._prev_extrusion_active = active

    def _classify_gap(self, profile, die_copy, gap_before_s, is_startup, is_cleanout, is_die_change):
        """Splits gap_before_s into (dead_cycle_s, stoppage_s). Startup/
        cleanout/die-change gaps are expected in full - see this module's
        docstring - so they're not scored against the baseline at all."""
        if gap_before_s is None:
            return None, None
        if is_startup or is_cleanout or is_die_change:
            return gap_before_s, 0.0
        baseline = gap_baseline(self._db, profile, die_copy)
        if baseline is None:
            return gap_before_s, 0.0  # not enough history for this profile/die yet - don't guess
        expected = expected_gap_s(baseline)
        dead_cycle_s = min(gap_before_s, expected)
        stoppage_s = max(0.0, gap_before_s - expected)
        return dead_cycle_s, stoppage_s

    def _emit_billet_cycle(self, ts, doc):
        billet_no_order = doc.get(FLD_BILLET_NO_ORDER)
        if billet_no_order is None:
            return  # nothing stable to key this row on - skip rather than guess

        job_number = doc.get(FLD_JOB_NUMBER)
        billet_no_die = doc.get(FLD_BILLET_NO_DIE)
        alloy_code = doc.get(FLD_ALLOY)
        profile = doc.get(FLD_PROFILE)
        die_copy = doc.get(FLD_DIE_COPY)

        extrusion_duration_s = (
            (ts - self._extrusion_start_ts).total_seconds() if self._extrusion_start_ts else None
        )
        # self._last_billet_ts IS the previous billet's extrusion-end
        # timestamp (it's set from this same `ts` at the bottom of this
        # method, always at a True->False edge) - no separate variable
        # needed to track "previous extrusion end" apart from it.
        gap_before_s = (
            (self._extrusion_start_ts - self._last_billet_ts).total_seconds()
            if self._extrusion_start_ts and self._last_billet_ts else None
        )
        cycle_duration_s = (
            (ts - self._last_billet_ts).total_seconds() if self._last_billet_ts else None
        )

        is_startup = (
            self._prev_billet_job_number is None
            or job_number != self._prev_billet_job_number
            or (billet_no_order is not None and billet_no_order <= 1)
        )
        is_cleanout = (not is_startup) and is_cleanout_cycle(self._prev_billet_alloy, alloy_code)
        is_die_change = (not is_startup) and not is_cleanout and (
            (die_copy is not None and self._prev_billet_die_copy is not None and die_copy != self._prev_billet_die_copy)
            or self._die_change_flagged_during_gap
        )
        dead_cycle_s, stoppage_s = self._classify_gap(
            profile, die_copy, gap_before_s, is_startup, is_cleanout, is_die_change
        )

        row = {
            "billet_key": _billet_key(job_number, billet_no_order, billet_no_die),
            "ts": ts.isoformat(),
            "job_number": job_number,
            "profile": profile,
            "die_copy": die_copy,
            "alloy_code": alloy_code,
            "alloy_name": ALLOY_MAP.get(alloy_code, alloy_code),
            "billet_number_per_order": billet_no_order,
            "billet_number_per_die": billet_no_die,
            "scheduled_billets": doc.get(FLD_SCHEDULED_BILLETS),
            "billet_length_setpoint_in": doc.get(FLD_BILLET_LEN_SETPOINT),
            "billet_length_actual_in": doc.get(FLD_BILLET_LEN_ACTUAL),
            "butt_length_setpoint_in": doc.get(FLD_BUTT_LEN_SETPOINT),
            "butt_length_actual_in": doc.get(FLD_BUTT_LEN_ACTUAL),
            "billet_temp_setpoint_f": doc.get(FLD_BILLET_TEMP_SETPOINT),
            "billet_temp_actual_f": doc.get(FLD_BILLET_TEMP_ACTUAL),
            **self._peaks,
            "extrusion_duration_s": extrusion_duration_s,
            "cycle_duration_s": cycle_duration_s,
            "gap_before_s": gap_before_s,
            "dead_cycle_s": dead_cycle_s,
            "stoppage_s": stoppage_s,
            "in_billet_stall_s": round(self._in_billet_stall_s, 1),
            "is_startup": is_startup,
            "is_cleanout": is_cleanout,
            "is_die_change": is_die_change,
            "press_hydraulic_temp_f": doc.get(FLD_PRESS_HYD_TEMP),
            "source": "event",
        }
        self._db.billet_cycles.update_one(
            {"billet_key": row["billet_key"]}, {"$set": row}, upsert=True
        )
        self._last_billet_ts = ts
        self._prev_billet_job_number = job_number
        self._prev_billet_alloy = alloy_code
        self._prev_billet_die_copy = die_copy
        self._die_change_flagged_during_gap = False


def run_poll_loop():
    db = get_db()
    ensure_indexes()
    detector = Detector(db)
    print(f"[billet_monitor] polling press_data every {POLL_INTERVAL_S}s")

    while True:
        try:
            doc = db.press_data.find_one({}, sort=[(FLD_DATETIME, -1)])
            detector.process(doc, time.monotonic())
        except Exception as exc:
            print(f"[billet_monitor] poll error (will retry): {exc}")
        time.sleep(POLL_INTERVAL_S)


def start_background_poller():
    threading.Thread(target=run_poll_loop, daemon=True, name="billet-monitor").start()

"""Tracks exactly which billets end up in each coldsaw batch.

press_data holds only a live snapshot, so batch membership cannot be read from
it - a batch fills one profile at a time and you have to be watching. This polls
that snapshot the same way billet_monitor does and accumulates composition into
press_db.coldsaw_batches.

WHY A FIFO QUEUE RATHER THAN READING THE BILLET NUMBER AT STRETCH TIME

`Billet Number (per Order)` is the billet at the PRESS. A profile being stretched
crossed the run-out table minutes ago, so the press has already moved on by
several billets - reading the number at stretch time is wrong, not merely
imprecise, and gets worse the deeper the table queue is.

So this tracks the queue explicitly:

  extrusion ends  -> push {billet, profile, die copy} onto a FIFO
  counter goes up -> pop that many off the front; those are the batch's members

Both ends are strictly ordered and every transition is observed live, so the
pairing is exact - no offset to guess, unlike the offline reconstruction in
part_ledger.py which has to infer the queue depth after the fact.

The billet number is captured at the EXTRUSION RESET INSTANT, which matters:
the number lags the physical event by ~10s, so at the moment the length resets
it still reads the billet that just finished. Read it a few seconds later and
you get the next one.

COLD START IS THE ONE HONEST GAP

Profiles already on the table when this starts have no recoverable identity -
nothing in the snapshot says which billet produced them. The queue is seeded
with that many placeholder entries so everything AFTER them stays correctly
aligned, and those placeholders carry billet_number: None and are rendered as
unknown rather than guessed. They drain within one queue pass (~10-15 min).

BATCH SIZE IS WHAT THE COUNTER REACHED, NOT THE SETPOINT

Batches are routinely brought over early, before the setpoint is met. The size
recorded is the counter's peak immediately before it resets. The setpoint is
kept alongside it only as the nominal target, never as the count.

BATCHES ARE HOMOGENEOUS BY PROFILE

A 1412 is never batched with an 1124. Each member carries its own profile so
this is verified rather than assumed; a batch containing more than one profile
is flagged mixed_profile, which should never appear and means something upstream
is wrong if it does. A profile change also force-closes the open batch.
"""
import os
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta

from billet_monitor import plant_now
from db import get_db

POLL_INTERVAL_S = 2.0

FLD_DATETIME = "Date/Time"
FLD_ACTUAL = "Profiles in Batch Formation (Actual)"
FLD_SETPOINT = "Profiles in Batch Formation (Setpoint)"
FLD_BILLET = "Billet Number (per Order)"
FLD_BILLET_DIE = "Billet Number (per Die)"
FLD_PROFILE = "Profile"
FLD_DIE_COPY = "Die Copy"
FLD_JOB = "Job Number (#)"
FLD_CUT_NUMBER = "Coldsaw Current Cut Number"
FLD_CUTS_TOTAL = "Number of Coldsaw Cuts"

MAX_KEPT_BATCHES = 40
# press_data's Date/Time is plant-local wall clock, and this runs on Render in
# UTC - comparing it against datetime.now() reports everything as ~5 hours
# stale, permanently. plant_now() is billet_monitor's fix for the identical bug
# in the stall banner; reuse it rather than repeat the mistake.
STALE_AFTER_S = 300

# Bump to discard queue/batch state written by an older, buggy build rather
# than carrying its corruption forward. v2 clears the state left by the
# unlocked multi-worker version.
STATE_VERSION = 4

# app.py starts the pollers at IMPORT time, which under gunicorn happens once
# per worker - so every worker ran its own coldsaw poller against the same
# Mongo state. billet_monitor survives that because it upserts on billet_key;
# this tracker APPENDS, so N workers pushed each extrusion N times and popped
# N members per increment. Live production showed exactly 2x duplication
# ([41, 41, 42, 42, 43, 43]) with the queue growing one deep per billet, while
# replaying the same press data through a single tracker reproduced ground
# truth exactly - which is what localised it here rather than in the logic.
#
# So exactly one process may mutate state. The rest idle and stand by, ready
# to take over if the holder dies.
LOCK_ID = "coldsaw_poller"
LOCK_TTL_S = 30
OWNER = "{}:{}:{}".format(socket.gethostname(), os.getpid(), uuid.uuid4().hex[:8])


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def table_occupancy(doc):
    """Profiles physically queued between press and stretcher, right now.

    Full precision deliberately: rounding collapses nominally identical
    profiles (161.076 / 161.020 / 161.043) into one indistinguishable value.
    """
    out = []
    for pos in range(16):
        length = _num(doc.get("Profiles on Table {} (ft)".format(pos)))
        if length:
            out.append({"position": pos, "length_ft": length})
    return out


def _align(current, tracked):
    """How many profiles entered the front and left the back since last poll.

    The table only ever inserts at position 1 and removes from the highest
    occupied position, so the tracked sequence must survive as a contiguous
    run inside the new one. Returns (added, removed) for the cheapest
    explanation; falling back to a full replacement if none fits (a gap in the
    data, say), which costs identities but never mis-assigns them.
    """
    for total in range(0, len(current) + len(tracked) + 1):
        for added in range(0, min(total, len(current)) + 1):
            removed = total - added
            if removed > len(tracked):
                continue
            kept = tracked[:len(tracked) - removed] if removed else tracked
            if current[added:] == kept:
                return added, removed
    return len(current), len(tracked)


class BatchTracker:
    """Tracks profiles through the run-out table, which is a SHIFT REGISTER.

    A new profile appears at Profiles on Table 1 and pushes the others to
    higher positions; the oldest leaves from the highest occupied position when
    it is stretched. Identity therefore comes from POSITION IN THE SEQUENCE,
    not from the length value.

    Keying on the length alone is tempting - it is how a human follows a
    profile down the table - but two profiles carry the same 3-dp length
    simultaneously in 15.3% of samples (measured 09/17, up to three at once),
    and collapsing those silently drops profiles from the batch.

    So each poll aligns the current occupancy against the tracked sequence,
    allowing only what the mechanism can do: insertions at the front, removals
    from the back. The length values are still carried for display and for
    cross-checking by hand.

    Earlier versions inferred profiles from Current Extrusion Length resets and
    popped a positional FIFO. That was wrong twice over - the length counter
    also resets part-way through a billet (a burp leaves a short fragment), and
    a positional queue drifts permanently once it miscounts even once.

    STAGES, and the signal that marks each transition:

      press -> table     a NEW length value appears in Profiles on Table N.
                         The profile came from the billet that most recently
                         FINISHED, not the one the press is on now - measured
                         ~72s between the billet counter advancing and the
                         profile landing on the table.

      table -> stretcher the value DISAPPEARS from the table. Verified against
                         hand-annotated production data: every disappearance is
                         followed by Profiles in Batch Formation (Actual)
                         incrementing 1-3s later, one for one.

      batch -> saw       Actual resets to 0. Size is the peak it reached, which
                         is NOT reliably the setpoint field - observed reading
                         8 while the counter reset at 6.
    """

    def __init__(self, db):
        self._db = db
        state = db.coldsaw_state.find_one({"_id": "state"}) or {}
        if state.get("version") != STATE_VERSION:
            # Older state came from a different (wrong) model - drop it rather
            # than inherit its mis-attributions.
            db.coldsaw_batches.delete_many({})
            state = {}
        self._on_table = state.get("on_table", [])
        self._last_actual = state.get("last_actual")
        self._last_billet = state.get("last_billet")
        self._completed_billet = state.get("completed_billet")
        self._seeded = state.get("seeded", False)
        self._seq = self._resume_seq()

    def _resume_seq(self):
        last = self._db.coldsaw_batches.find_one(sort=[("batch_seq", -1)])
        return (last["batch_seq"] + 1) if last else 1

    def _save(self):
        self._db.coldsaw_state.update_one(
            {"_id": "state"},
            {"$set": {"version": STATE_VERSION, "on_table": self._on_table,
                      "last_actual": self._last_actual,
                      "last_billet": self._last_billet,
                      "completed_billet": self._completed_billet,
                      "seeded": self._seeded, "updated_at": datetime.utcnow()}},
            upsert=True)

    def _forming(self):
        return self._db.coldsaw_batches.find_one({"status": "forming"})

    def _open_batch(self, doc, setpoint):
        self._db.coldsaw_batches.insert_one({
            "batch_seq": self._seq, "status": "forming",
            "opened_at": doc.get(FLD_DATETIME), "setpoint": setpoint,
            "profile": None, "die_copy": None, "members": []})
        self._seq += 1
        return self._forming()

    def _stretched(self, entry, doc, setpoint):
        """One profile left the table: it has been stretched and queued."""
        forming = self._forming() or self._open_batch(doc, setpoint)
        members = list(forming.get("members", []))
        existing = forming.get("profile")
        incoming = entry.get("profile")

        # Batches never mix profiles, and the split is driven by what comes off
        # the TABLE, not by what the press is running - the press changes over
        # long before the table drains.
        if existing and incoming and incoming != existing:
            self._release(len(members), doc, closed_by="profile_change")
            forming = self._open_batch(doc, setpoint)
            members = []

        entry = dict(entry)
        entry["slot"] = len(members) + 1
        entry["stretched_at"] = doc.get(FLD_DATETIME)
        members.append(entry)
        profiles = {m.get("profile") for m in members if m.get("profile")}
        self._db.coldsaw_batches.update_one(
            {"_id": forming["_id"]},
            {"$set": {"members": members, "setpoint": setpoint,
                      "profile": (sorted(profiles)[0] if profiles else None),
                      "die_copy": next((m.get("die_copy") for m in members
                                        if m.get("die_copy") is not None), None),
                      "mixed_profile": len(profiles) > 1}})

    def _release(self, peak, doc, closed_by=None):
        forming = self._forming()
        if not forming:
            return
        members = forming.get("members", [])
        self._db.coldsaw_batches.update_one(
            {"_id": forming["_id"]},
            {"$set": {"status": "released", "released_at": doc.get(FLD_DATETIME),
                      "size": int(peak), "observed_members": len(members),
                      "short_of_setpoint": bool(forming.get("setpoint")
                                                and peak < forming["setpoint"]),
                      "closed_by": closed_by or "counter_reset"}})
        self._prune()

    def _prune(self):
        rows = list(self._db.coldsaw_batches.find(
            {}, {"batch_seq": 1}, sort=[("batch_seq", -1)]).limit(MAX_KEPT_BATCHES))
        if len(rows) < MAX_KEPT_BATCHES:
            return
        self._db.coldsaw_batches.delete_many(
            {"batch_seq": {"$lt": rows[-1]["batch_seq"]}})

    def process(self, doc):
        if not doc:
            return
        actual = _num(doc.get(FLD_ACTUAL))
        if actual is None:
            return
        setpoint = _num(doc.get(FLD_SETPOINT))
        ts = doc.get(FLD_DATETIME)

        # Which billet most recently FINISHED. A profile reaching the table
        # belongs to that one, not to whatever the press has moved on to.
        billet = _num(doc.get(FLD_BILLET))
        if billet is not None:
            if self._last_billet is not None and billet != self._last_billet:
                self._completed_billet = self._last_billet
            self._last_billet = billet

        occupancy = table_occupancy(doc)
        current = [round(e["length_ft"], 3) for e in occupancy]

        if not self._seeded:
            # Profiles already on the table have no recoverable identity.
            self._on_table = [{"billet_number": None, "unknown": True,
                               "profile": None, "die_copy": None,
                               "length_ft": v, "entered_at": ts}
                              for v in current]
            self._seeded = True
        else:
            added, removed = _align(current, [p["length_ft"] for p in self._on_table])
            # Removals come off the back (highest position) - those are the
            # profiles that just went to the stretcher.
            for _ in range(removed):
                if self._on_table:
                    self._stretched(self._on_table.pop(), doc, setpoint)
            # Insertions arrive at the front (Table 1), newest first.
            for v in reversed(current[:added]):
                self._on_table.insert(0, {
                    "billet_number": self._completed_billet,
                    "unknown": self._completed_billet is None,
                    "profile": doc.get(FLD_PROFILE),
                    "die_copy": doc.get(FLD_DIE_COPY),
                    "job": doc.get(FLD_JOB),
                    "length_ft": v, "entered_at": ts})

        self._db.coldsaw_live.update_one(
            {"_id": "live"},
            {"$set": {"ts": ts, "profile": doc.get(FLD_PROFILE),
                      "die_copy": doc.get(FLD_DIE_COPY), "actual": actual,
                      "setpoint": setpoint,
                      "cut_number": _num(doc.get(FLD_CUT_NUMBER)),
                      "cuts_total": _num(doc.get(FLD_CUTS_TOTAL)),
                      "billet_at_press": billet,
                      "completed_billet": self._completed_billet,
                      "queue_depth": len(self._on_table),
                      "queue_unknown": sum(1 for v in self._on_table
                                           if v.get("unknown")),
                      "table": occupancy, "updated_at": datetime.utcnow()}},
            upsert=True)

        prev = self._last_actual
        self._last_actual = actual
        if prev is not None and actual < prev:
            self._release(prev, doc)

        self._save()


def current_state():
    """Everything the coldsaw group view needs, in one payload."""
    db = get_db()
    live = db.coldsaw_live.find_one({"_id": "live"}) or {}
    live.pop("_id", None)
    live.pop("updated_at", None)

    forming = db.coldsaw_batches.find_one({"status": "forming"})
    released = list(db.coldsaw_batches.find(
        {"status": "released"}, sort=[("batch_seq", -1)]).limit(6))
    for b in [forming] + released:
        if b:
            b["_id"] = str(b["_id"])

    stale = None
    try:
        ts = datetime.strptime(live.get("ts"), "%m/%d/%Y %H:%M:%S")
        stale = (plant_now() - ts).total_seconds() > STALE_AFTER_S
    except (TypeError, ValueError):
        pass

    return {"live": live, "forming": forming, "released": released, "stale": stale}


def _acquire_lock(db):
    """Claim (or renew) the right to be the only writer.

    Held by heartbeat rather than a fixed lease so a worker that dies is taken
    over within LOCK_TTL_S instead of wedging the tracker permanently.
    """
    now = datetime.utcnow()
    stale = now - timedelta(seconds=LOCK_TTL_S)
    res = db.coldsaw_lock.update_one(
        {"_id": LOCK_ID,
         "$or": [{"owner": OWNER}, {"heartbeat": {"$lt": stale}}]},
        {"$set": {"owner": OWNER, "heartbeat": now}})
    if res.matched_count:
        return True
    try:
        db.coldsaw_lock.insert_one(
            {"_id": LOCK_ID, "owner": OWNER, "heartbeat": now})
        return True
    except Exception:
        return False        # someone else holds it; stand by


def run_poll_loop():
    db = get_db()
    tracker = None
    was_leader = False
    print("[coldsaw] poller starting as {}".format(OWNER))
    while True:
        try:
            leader = _acquire_lock(db)
            if leader:
                if not was_leader:
                    # Re-read state on taking over: another process may have
                    # advanced it since this one last looked.
                    tracker = BatchTracker(db)
                    print("[coldsaw] acquired lock, polling every {}s".format(
                        POLL_INTERVAL_S))
                doc = db.press_data.find_one({}, sort=[(FLD_DATETIME, -1)])
                tracker.process(doc)
            elif was_leader:
                print("[coldsaw] lost lock, standing by")
                tracker = None
            was_leader = leader
        except Exception as exc:
            print("[coldsaw] poll error (will retry): {}".format(exc))
        time.sleep(POLL_INTERVAL_S)


def start_background_poller():
    threading.Thread(target=run_poll_loop, daemon=True, name="coldsaw").start()

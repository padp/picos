"""User-configurable ntfy.sh alerts on raw press_data tags.

Lets someone build a rule set (e.g. "Billet Temperature Actual (F) < 700
for >= 60s") entirely from the live press_data document's own fields -
no PLC-specific knowledge baked in here beyond bool-vs-numeric, so any
tag GetSendPressDataToDB.py happens to be writing today is automatically
selectable (see list_available_tags). Each rule set gets its own
randomly-generated ntfy topic; the frontend renders that as a QR code
(https://ntfy.sh/<topic>, the same URL ntfy's own app QR-scans to add a
subscription) so a phone can subscribe to it in one scan.

Runs as its own background poller, independent of billet_monitor.py's
Detector - same press_data document, same 2s cadence, but deliberately
NOT sharing that loop. A slow/unreachable ntfy.sh must never delay the
billet-cycle/state_events tracking that loop is responsible for (and per
that module's own POLL_DISABLED lesson, this one is skipped for a local
dev instance the same way - see app.py).
"""
import operator as _op
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

from billet_monitor import FLD_DATETIME, POLL_INTERVAL_S, plant_now
from db import get_db

TOPIC_PREFIX = "pad-whitehall-"

_COMPARATORS = {
    "<": _op.lt,
    "<=": _op.le,
    ">": _op.gt,
    ">=": _op.ge,
    "==": _op.eq,
    "!=": _op.ne,
}


def generate_topic(db):
    while True:
        topic = f"{TOPIC_PREFIX}{secrets.token_hex(4)}"
        if not db.alert_rules.find_one({"topic": topic}):
            return topic


def list_available_tags(db):
    """Every press_data field that's a plain bool or number, since those
    are the only two kinds of threshold the trigger builder understands.
    Read from the latest live document rather than a hardcoded field
    list, so it stays correct if GetSendPressDataToDB.py's own tag list
    ever changes - the same reason billet_monitor.py polls press_data
    instead of the PLC directly."""
    doc = db.press_data.find_one({}, sort=[(FLD_DATETIME, -1)])
    if not doc:
        return []
    tags = []
    for key, value in doc.items():
        if key == "_id":
            continue
        if isinstance(value, bool):
            tags.append({"field": key, "type": "bool"})
        elif isinstance(value, (int, float)):
            tags.append({"field": key, "type": "numeric"})
    tags.sort(key=lambda t: t["field"])
    return tags


def _pretty_field(field):
    # "Billet Temperature Actual (F)" -> "Billet Temperature Actual" -
    # the unit/type suffix is useful in a dropdown but redundant (and a
    # little odd-reading, e.g. "(Bool)") once it's part of a sentence.
    return re.sub(r"\s*\([^)]*\)\s*$", "", field).strip()


def _format_duration(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    minutes, sec = divmod(seconds, 60)
    return f"{minutes}m{sec}s" if sec else f"{minutes}m"


def describe_trigger(trigger):
    pretty = _pretty_field(trigger["field"])
    if trigger["type"] == "bool":
        core = f"{pretty} is {'True' if trigger.get('equals', True) else 'False'}"
    else:
        core = f"{pretty} {trigger.get('comparator')} {trigger.get('threshold')}"
    sustained_s = trigger.get("sustained_s") or 0
    if sustained_s > 0:
        # Plain ASCII, not "≥" - Windows' default console codepage
        # (cp1252) can't encode that and print() crashes on it, and this
        # string also goes out verbatim in the ntfy push itself.
        core += f" for >={_format_duration(sustained_s)}"
    return core


def validate_trigger(trigger):
    if not isinstance(trigger, dict):
        return "each trigger must be an object"
    field = trigger.get("field")
    if not field or not isinstance(field, str):
        return "each trigger needs a field"
    ttype = trigger.get("type")
    if ttype not in ("bool", "numeric"):
        return "type must be 'bool' or 'numeric'"
    sustained_s = trigger.get("sustained_s", 0)
    if isinstance(sustained_s, bool) or not isinstance(sustained_s, (int, float)) or sustained_s < 0:
        return "sustained_s must be a non-negative number"
    if ttype == "bool":
        if not isinstance(trigger.get("equals"), bool):
            return "a bool trigger needs equals: true/false"
    else:
        if trigger.get("comparator") not in _COMPARATORS:
            return f"comparator must be one of {sorted(_COMPARATORS)}"
        threshold = trigger.get("threshold")
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
            return "a numeric trigger needs a numeric threshold"
    return None


def build_rule_doc(payload):
    """Validates payload (the POST /api/alerts body) and returns
    (doc_without_topic, None) or (None, error_message). topic is filled
    in by the caller, once it's checked generate_topic() against the DB."""
    if not isinstance(payload, dict):
        return None, "invalid request body"
    triggers_in = payload.get("triggers")
    if not isinstance(triggers_in, list) or not triggers_in:
        return None, "at least one trigger is required"

    triggers = []
    for t in triggers_in:
        err = validate_trigger(t)
        if err:
            return None, err
        trigger = {
            "id": secrets.token_hex(4),
            "field": t["field"],
            "type": t["type"],
            "sustained_s": t.get("sustained_s", 0),
            "active": True,
        }
        if t["type"] == "bool":
            trigger["equals"] = t["equals"]
        else:
            trigger["comparator"] = t["comparator"]
            trigger["threshold"] = t["threshold"]
        triggers.append(trigger)

    label = payload.get("label")
    if label is not None and not isinstance(label, str):
        return None, "label must be a string"

    return {
        "label": (label.strip() or None) if label else None,
        "active": True,
        "created_at": plant_now().isoformat(),
        "triggers": triggers,
    }, None


def _send_ntfy(topic, title, message, tags=None):
    url = f"https://ntfy.sh/{topic}"
    req = urllib.request.Request(url, data=message.encode("utf-8"), method="POST")
    req.add_header("Title", title)
    if tags:
        req.add_header("Tags", ",".join(tags))
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as exc:
        print(f"[alerts] ntfy send failed for topic {topic}: {exc}")


def _send_ntfy_async(topic, title, message, tags=None):
    # Fire-and-forget on its own thread - see module docstring on why
    # this loop must never block on ntfy.sh's response time.
    threading.Thread(target=_send_ntfy, args=(topic, title, message, tags), daemon=True).start()


class AlertEvaluator:
    """Edge-triggered: a rule fires once when its condition has been
    continuously true for >= sustained_s, then stays quiet (no repeat
    pushes while the condition keeps holding) until it clears and trips
    again - nobody wants a notification every 2 seconds for as long as,
    say, Manual mode stays active."""

    def __init__(self, db):
        self._db = db
        # (topic, trigger_id) -> {"since": datetime|None, "fired": bool}
        self._trigger_state = {}

    def _condition_met(self, trigger, doc):
        value = doc.get(trigger["field"])
        if value is None:
            return False
        if trigger["type"] == "bool":
            return bool(value) == bool(trigger.get("equals", True))
        try:
            value = float(value)
        except (TypeError, ValueError):
            return False
        cmp = _COMPARATORS.get(trigger.get("comparator"))
        if cmp is None:
            return False
        return cmp(value, float(trigger.get("threshold", 0)))

    def evaluate(self, doc):
        if not doc:
            return
        now = plant_now()
        rules = list(self._db.alert_rules.find({"active": True}))

        live_keys = set()
        for rule in rules:
            topic = rule["topic"]
            for trigger in rule.get("triggers", []):
                if not trigger.get("active", True):
                    continue
                key = (topic, trigger["id"])
                live_keys.add(key)
                state = self._trigger_state.setdefault(key, {"since": None, "fired": False})

                if not self._condition_met(trigger, doc):
                    state["since"] = None
                    state["fired"] = False
                    continue

                if state["since"] is None:
                    state["since"] = now
                held_s = (now - state["since"]).total_seconds()
                sustained_s = trigger.get("sustained_s") or 0
                if held_s >= sustained_s and not state["fired"]:
                    state["fired"] = True
                    self._fire(rule, trigger, doc)

        # Forget any trigger that's since been deleted/edited away, so a
        # long-running process doesn't leak memory across rule edits.
        for key in set(self._trigger_state) - live_keys:
            del self._trigger_state[key]

    def _fire(self, rule, trigger, doc):
        desc = describe_trigger(trigger)
        value = doc.get(trigger["field"])
        title = rule.get("label") or "Paducah Press Alert"
        message = f"{desc}\ncurrent value: {value}"
        print(f"[alerts] firing {rule['topic']} / {trigger['id']}: {desc} (value={value})")
        _send_ntfy_async(rule["topic"], title, message, tags=["warning"])


def run_alert_loop():
    db = get_db()
    evaluator = AlertEvaluator(db)
    print(f"[alerts] polling press_data for alert rules every {POLL_INTERVAL_S}s")
    while True:
        try:
            doc = db.press_data.find_one({}, sort=[(FLD_DATETIME, -1)])
            evaluator.evaluate(doc)
        except Exception as exc:
            print(f"[alerts] poll error (will retry): {exc}")
        time.sleep(POLL_INTERVAL_S)


def start_background_alert_poller():
    threading.Thread(target=run_alert_loop, daemon=True, name="alert-evaluator").start()

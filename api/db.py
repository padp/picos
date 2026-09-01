"""MongoDB connection helper.

Same connection pattern as the rest of this codebase (Fetch Log Data,
Granco Saw Monitor): username and cluster host inline, only the password
read from an env var (SQL_PASS). Reuses the existing press_db database
(picos already owns press_data there) rather than standing up a new one -
billet_cycles/state_events are just new collections alongside it.
"""
import os

from pymongo import MongoClient

DB_NAME = "press_db"

_client = None


def get_db():
    global _client
    if _client is None:
        sql_pass = os.environ["SQL_PASS"]
        _client = MongoClient(
            f"mongodb+srv://padpress1:{sql_pass}@cluster0.ywwxl.mongodb.net/"
            "?retryWrites=true&w=majority&appName=Cluster0"
        )
    return _client[DB_NAME]


def ensure_indexes():
    db = get_db()
    # billet_key (job_number + both billet counters) rather than an
    # autoincrement id - makes inserts idempotent-safe if the poller ever
    # restarts mid-billet or (in a hypothetical multi-worker deployment)
    # two pollers detect the same completion, since both would compute the
    # same key and upsert into one row instead of duplicating it.
    db.billet_cycles.create_index("billet_key", unique=True)
    db.billet_cycles.create_index("ts")
    # Supports billet_monitor.py's per-(profile, die_copy) gap baseline
    # query (recent same-profile-and-die rows, newest first).
    db.billet_cycles.create_index([("profile", 1), ("die_copy", 1), ("ts", -1)])
    db.state_events.create_index("ts_start")
    # Drop the old ntfy-era unique index on `topic` if it's still there -
    # alert_rules no longer has a topic field (alerts.py moved to Teams
    # webhook_url instead), and MongoDB's unique index treats a missing
    # field as null, so a second webhook_url-only document would
    # otherwise collide with the first on that phantom null value.
    existing = {idx["name"] for idx in db.alert_rules.list_indexes()}
    if "topic_1" in existing:
        db.alert_rules.drop_index("topic_1")

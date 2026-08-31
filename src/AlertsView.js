import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { QRCodeSVG } from 'qrcode.react';
import { PRESS_API_BASE, REQUEST_TIMEOUT } from './Constants';

// One-click shortcuts for the three most common "something needs
// attention" conditions - each is just a pre-filled bool trigger on a
// known tag, so they're nothing the generic builder below couldn't
// already express by hand.
const PRESET_TRIGGERS = [
  { key: 'emergency', label: '+ Emergency Stop', trigger: { field: 'Emergency Mode Active (Bool)', type: 'bool', equals: true, sustained_s: 0 } },
  { key: 'manual', label: '+ Manual Mode', trigger: { field: 'Manual Mode Active (Bool)', type: 'bool', equals: true, sustained_s: 0 } },
  { key: 'setup', label: '+ Setup Mode', trigger: { field: 'Set-Up Mode Active (Bool)', type: 'bool', equals: true, sustained_s: 0 } },
];

function prettyField(field) {
  return field.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function formatDurationShort(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

// Preview-only mirror of alerts.describe_trigger on the backend - what's
// actually stored (and shown once an alert exists) always comes from
// that server-side copy, this just previews a trigger before it's
// created, while it only exists as local staging-list state.
function describeDraft(t) {
  const pretty = prettyField(t.field);
  const core = t.type === 'bool' ? `${pretty} is ${t.equals ? 'True' : 'False'}` : `${pretty} ${t.comparator} ${t.threshold}`;
  const sustainedS = t.sustained_s || 0;
  return sustainedS > 0 ? `${core} for >=${formatDurationShort(sustainedS)}` : core;
}

function emptyDraft() {
  return { field: '', comparator: '<', threshold: '', equals: true, durationValue: '', durationUnit: 1 };
}

function TriggerBuilder({ tags, onAdd }) {
  const [draft, setDraft] = useState(emptyDraft());
  const matchedTag = tags.find((t) => t.field === draft.field);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const canAdd = !!matchedTag && (matchedTag.type === 'bool' || (draft.threshold !== '' && !Number.isNaN(Number(draft.threshold))));

  const handleAdd = () => {
    if (!canAdd) return;
    const sustained_s = draft.durationValue === '' ? 0 : Math.max(0, Number(draft.durationValue) * draft.durationUnit);
    const trigger = matchedTag.type === 'bool'
      ? { field: draft.field, type: 'bool', equals: draft.equals, sustained_s }
      : { field: draft.field, type: 'numeric', comparator: draft.comparator, threshold: Number(draft.threshold), sustained_s };
    onAdd(trigger);
    setDraft(emptyDraft());
  };

  return (
    <div className="trigger-builder">
      <div className="trigger-form-row">
        <label className="trigger-field-label">
          Tag
          <input
            list="alert-tag-options"
            value={draft.field}
            onChange={(e) => update({ field: e.target.value })}
            placeholder="Start typing a tag name…"
          />
          <datalist id="alert-tag-options">
            {tags.map((t) => (
              <option key={t.field} value={t.field} />
            ))}
          </datalist>
        </label>

        {matchedTag && matchedTag.type === 'bool' && (
          <label>
            Alert when it
            <select value={draft.equals ? '1' : '0'} onChange={(e) => update({ equals: e.target.value === '1' })}>
              <option value="1">becomes True</option>
              <option value="0">becomes False</option>
            </select>
          </label>
        )}

        {matchedTag && matchedTag.type === 'numeric' && (
          <>
            <label>
              Condition
              <select value={draft.comparator} onChange={(e) => update({ comparator: e.target.value })}>
                <option value="<">&lt;</option>
                <option value="<=">&le;</option>
                <option value=">">&gt;</option>
                <option value=">=">&ge;</option>
                <option value="==">=</option>
                <option value="!=">&ne;</option>
              </select>
            </label>
            <label>
              Threshold
              <input type="number" value={draft.threshold} onChange={(e) => update({ threshold: e.target.value })} />
            </label>
          </>
        )}

        {matchedTag && (
          <label>
            Hold for at least
            <span className="duration-input">
              <input
                type="number"
                min="0"
                value={draft.durationValue}
                onChange={(e) => update({ durationValue: e.target.value })}
                placeholder="0"
              />
              <select value={draft.durationUnit} onChange={(e) => update({ durationUnit: Number(e.target.value) })}>
                <option value={1}>sec</option>
                <option value={60}>min</option>
              </select>
            </span>
          </label>
        )}

        <button type="button" className="secondary-button" disabled={!canAdd} onClick={handleAdd}>
          + Add Trigger
        </button>
      </div>
      {draft.field && !matchedTag && <p className="stat-sub">Pick a tag from the list to configure its condition.</p>}
    </div>
  );
}

function AlertsView({ onBackToDefault }) {
  const [tags, setTags] = useState([]);
  const [alertList, setAlertList] = useState([]);
  const [stagingTriggers, setStagingTriggers] = useState([]);
  const [label, setLabel] = useState('');
  const [justCreated, setJustCreated] = useState(null);
  const [qrTopicShown, setQrTopicShown] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tagsRes, alertsRes] = await Promise.all([
        axios.get(`${PRESS_API_BASE}/api/alerts/tags`, { timeout: REQUEST_TIMEOUT }),
        axios.get(`${PRESS_API_BASE}/api/alerts`, { timeout: REQUEST_TIMEOUT }),
      ]);
      setTags(tagsRes.data.tags || []);
      setAlertList(alertsRes.data.alerts || []);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addTrigger = (trigger) => {
    setStagingTriggers((list) => [...list, { ...trigger, _key: `${Date.now()}-${Math.random()}` }]);
  };
  const removeStaging = (key) => {
    setStagingTriggers((list) => list.filter((t) => t._key !== key));
  };

  const handleCreate = async () => {
    if (stagingTriggers.length === 0) return;
    setIsSubmitting(true);
    try {
      const triggers = stagingTriggers.map(({ _key, ...t }) => t);
      const res = await axios.post(
        `${PRESS_API_BASE}/api/alerts`,
        { label: label || undefined, triggers },
        { timeout: REQUEST_TIMEOUT }
      );
      setAlertList((list) => [res.data, ...list]);
      setJustCreated(res.data);
      setStagingTriggers([]);
      setLabel('');
    } catch (err) {
      window.alert((err.response && err.response.data && err.response.data.error) || 'Could not create alert.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleActive = async (rule) => {
    try {
      await axios.patch(`${PRESS_API_BASE}/api/alerts/${rule._id}`, { active: !rule.active }, { timeout: REQUEST_TIMEOUT });
      setAlertList((list) => list.map((r) => (r._id === rule._id ? { ...r, active: !rule.active } : r)));
    } catch (err) {
      window.alert('Could not update alert.');
    }
  };

  const deleteRule = async (rule) => {
    if (!window.confirm(`Delete "${rule.label || rule.topic}"? Anyone subscribed will stop getting these alerts.`)) return;
    try {
      await axios.delete(`${PRESS_API_BASE}/api/alerts/${rule._id}`, { timeout: REQUEST_TIMEOUT });
      setAlertList((list) => list.filter((r) => r._id !== rule._id));
      if (justCreated && justCreated._id === rule._id) setJustCreated(null);
    } catch (err) {
      window.alert('Could not delete alert.');
    }
  };

  return (
    <div className="container">
      <div className="default-view-header">
        <h1>Press Alerts</h1>
        <div>
          <button className="secondary-button" onClick={onBackToDefault}>
            &larr; Live Data
          </button>
        </div>
      </div>
      <p className="stat-sub">
        Build a set of conditions on any live press tag, then create an alert to get a topic you scan into
        the ntfy app (free on the App Store / Play Store) - your phone gets a push notification the moment
        any of its conditions trip. Once a condition trips you won't be paged again for it until it clears
        and trips again.
      </p>

      {isLoading ? (
        <p>Loading…</p>
      ) : error ? (
        <p>Could not reach the press API.</p>
      ) : (
        <>
          <h3>New Alert</h3>
          <div className="preset-buttons">
            {PRESET_TRIGGERS.map((p) => (
              <button key={p.key} type="button" className="secondary-button" onClick={() => addTrigger(p.trigger)}>
                {p.label}
              </button>
            ))}
          </div>

          <TriggerBuilder tags={tags} onAdd={addTrigger} />

          {stagingTriggers.length > 0 && (
            <ul className="trigger-list">
              {stagingTriggers.map((t) => (
                <li key={t._key} className="trigger-list-item">
                  <span>{describeDraft(t)}</span>
                  <button type="button" className="secondary-button" onClick={() => removeStaging(t._key)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="trigger-form-row">
            <label className="trigger-field-label">
              Alert name (optional)
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Night shift watch"
              />
            </label>
            <button type="button" onClick={handleCreate} disabled={stagingTriggers.length === 0 || isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Alert'}
            </button>
          </div>

          {justCreated && (
            <div className="qr-panel">
              <h3>{justCreated.label || 'New alert created'}</h3>
              <p className="stat-sub">
                Scan this in the ntfy app to subscribe. Topic: <code>{justCreated.topic}</code>
              </p>
              <QRCodeSVG value={`https://ntfy.sh/${justCreated.topic}`} size={200} />
              <div>
                <button type="button" className="secondary-button" onClick={() => setJustCreated(null)}>
                  Done
                </button>
              </div>
            </div>
          )}

          <h3>Existing Alerts</h3>
          {alertList.length === 0 ? (
            <p className="stat-sub">No alerts created yet.</p>
          ) : (
            alertList.map((rule) => (
              <div key={rule._id} className="alert-card">
                <div className="alert-card-header">
                  <div>
                    <strong>{rule.label || 'Untitled alert'}</strong> <span className="stat-sub">({rule.topic})</span>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setQrTopicShown(qrTopicShown === rule.topic ? null : rule.topic)}
                    >
                      {qrTopicShown === rule.topic ? 'Hide QR' : 'Show QR'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => toggleActive(rule)}>
                      {rule.active ? 'Disable' : 'Enable'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => deleteRule(rule)}>
                      Delete
                    </button>
                  </div>
                </div>
                {!rule.active && <p className="stat-sub">Disabled — won't send notifications.</p>}
                <ul className="trigger-list">
                  {rule.triggers.map((t) => (
                    <li key={t.id} className="trigger-list-item">
                      <span>{t.description}</span>
                    </li>
                  ))}
                </ul>
                {qrTopicShown === rule.topic && (
                  <div className="qr-panel">
                    <QRCodeSVG value={`https://ntfy.sh/${rule.topic}`} size={180} />
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

export default AlertsView;

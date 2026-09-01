import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT } from './Constants';

// One-click shortcuts for the three most common "something needs
// attention" conditions - each is just a pre-filled single-condition
// bool trigger on a known tag, so they're nothing the generic builder
// below couldn't already express by hand. The rest of this file (and
// everything in api/alerts.py) has no press-specific knowledge at all -
// this list, and the tags the API returns, are the only variable.
const PRESET_TRIGGERS = [
  {
    key: 'emergency',
    label: '+ Emergency Stop',
    trigger: { conditions: [{ field: 'Emergency Mode Active (Bool)', type: 'bool', equals: true, mode: 'becomes' }], sustained_s: 0 },
  },
  {
    key: 'manual',
    label: '+ Manual Mode',
    trigger: { conditions: [{ field: 'Manual Mode Active (Bool)', type: 'bool', equals: true, mode: 'becomes' }], sustained_s: 0 },
  },
  {
    key: 'setup',
    label: '+ Setup Mode',
    trigger: { conditions: [{ field: 'Set-Up Mode Active (Bool)', type: 'bool', equals: true, mode: 'becomes' }], sustained_s: 0 },
  },
];

const REPEAT_LABELS = {
  recurring: 'Recurring',
  one_time: 'One-time (removed after it fires)',
};

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

// Preview-only mirror of alerts.describe_condition/describe_trigger on
// the backend - what's actually stored (and shown once an alert exists)
// always comes from that server-side copy, this just previews a
// trigger before it's created, while it's only local staging state.
function describeCondition(c, comparators) {
  const pretty = prettyField(c.field);
  if (c.type === 'bool') {
    const word = c.mode === 'stays' ? 'stays' : 'becomes';
    return `${pretty} ${word} ${c.equals ? 'True' : 'False'}`;
  }
  const match = comparators.find((cc) => cc.value === c.comparator);
  const phrase = match ? match.label : c.comparator;
  return `${pretty} ${c.comparator} ${c.threshold} (${phrase})`;
}

function describeDraft(t, comparators) {
  const core = t.conditions.map((c) => describeCondition(c, comparators)).join(' AND ');
  const sustainedS = t.sustained_s || 0;
  return sustainedS > 0 ? `${core} for >=${formatDurationShort(sustainedS)}` : core;
}

function emptyCondition() {
  return { field: '', type: '', comparator: '', threshold: '', equals: true, mode: 'becomes' };
}

function emptyDraft() {
  return { conditions: [emptyCondition()], durationValue: '', durationUnit: 1 };
}

function ConditionRow({ condition, tags, comparators, boolModes, onChange, onRemove, showRemove }) {
  const matchedTag = tags.find((t) => t.field === condition.field);
  const update = (patch) => onChange({ ...condition, ...patch });

  const handleFieldChange = (field) => {
    const tag = tags.find((t) => t.field === field);
    if (!tag) {
      onChange(emptyCondition());
      return;
    }
    if (tag.type === 'bool') {
      onChange({ field, type: 'bool', equals: true, mode: 'becomes' });
    } else {
      onChange({ field, type: 'numeric', comparator: (comparators[0] || {}).value || '<', threshold: '' });
    }
  };

  return (
    <div className="condition-row">
      <select value={condition.field} onChange={(e) => handleFieldChange(e.target.value)}>
        <option value="">Choose a tag…</option>
        <optgroup label="Boolean tags">
          {tags.filter((t) => t.type === 'bool').map((t) => (
            <option key={t.field} value={t.field}>
              {t.field}
            </option>
          ))}
        </optgroup>
        <optgroup label="Numeric tags">
          {tags.filter((t) => t.type === 'numeric').map((t) => (
            <option key={t.field} value={t.field}>
              {t.field}
            </option>
          ))}
        </optgroup>
      </select>

      {matchedTag && matchedTag.type === 'bool' && (
        <>
          <select value={condition.mode || 'becomes'} onChange={(e) => update({ mode: e.target.value })}>
            {boolModes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={condition.equals ? '1' : '0'} onChange={(e) => update({ equals: e.target.value === '1' })}>
            <option value="1">True</option>
            <option value="0">False</option>
          </select>
        </>
      )}

      {matchedTag && matchedTag.type === 'numeric' && (
        <>
          <select value={condition.comparator} onChange={(e) => update({ comparator: e.target.value })}>
            {comparators.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value} ({c.label})
              </option>
            ))}
          </select>
          <input
            type="number"
            value={condition.threshold}
            onChange={(e) => update({ threshold: e.target.value })}
            placeholder="value"
          />
        </>
      )}

      {showRemove && (
        <button type="button" className="secondary-button condition-remove" onClick={onRemove} title="Remove this condition">
          &times;
        </button>
      )}
    </div>
  );
}

function TriggerBuilder({ tags, comparators, boolModes, onAdd }) {
  const [draft, setDraft] = useState(emptyDraft());

  const updateCondition = (index, next) => {
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => (i === index ? next : c)) }));
  };
  const addCondition = () => {
    setDraft((d) => ({ ...d, conditions: [...d.conditions, emptyCondition()] }));
  };
  const removeCondition = (index) => {
    setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== index) }));
  };

  const isComplete = (c) => {
    if (!c.field) return false;
    if (c.type === 'bool') return true;
    if (c.type === 'numeric') return c.threshold !== '' && !Number.isNaN(Number(c.threshold));
    return false;
  };
  const canAdd = draft.conditions.length > 0 && draft.conditions.every(isComplete);

  const handleAdd = () => {
    if (!canAdd) return;
    const sustained_s = draft.durationValue === '' ? 0 : Math.max(0, Number(draft.durationValue) * draft.durationUnit);
    const conditions = draft.conditions.map((c) =>
      c.type === 'bool'
        ? { field: c.field, type: 'bool', equals: c.equals, mode: c.mode || 'becomes' }
        : { field: c.field, type: 'numeric', comparator: c.comparator, threshold: Number(c.threshold) }
    );
    onAdd({ conditions, sustained_s });
    setDraft(emptyDraft());
  };

  return (
    <div className="trigger-builder">
      {draft.conditions.map((condition, index) => (
        <div key={index} className="condition-row-wrap">
          {index > 0 && <span className="and-label">AND</span>}
          <ConditionRow
            condition={condition}
            tags={tags}
            comparators={comparators}
            boolModes={boolModes}
            onChange={(next) => updateCondition(index, next)}
            onRemove={() => removeCondition(index)}
            showRemove={draft.conditions.length > 1}
          />
          {index === draft.conditions.length - 1 && (
            <button
              type="button"
              className="secondary-button add-condition-button"
              onClick={addCondition}
              title="Add another AND condition (compound alert)"
            >
              +
            </button>
          )}
        </div>
      ))}

      <div className="trigger-form-row">
        <label>
          Hold for at least
          <span className="duration-input">
            <input
              type="number"
              min="0"
              value={draft.durationValue}
              onChange={(e) => setDraft((d) => ({ ...d, durationValue: e.target.value }))}
              placeholder="0"
            />
            <select
              value={draft.durationUnit}
              onChange={(e) => setDraft((d) => ({ ...d, durationUnit: Number(e.target.value) }))}
            >
              <option value={1}>sec</option>
              <option value={60}>min</option>
            </select>
          </span>
        </label>
        <button type="button" className="secondary-button" disabled={!canAdd} onClick={handleAdd}>
          + Add Trigger
        </button>
      </div>
    </div>
  );
}

function WebhookField({ webhookUrl, setWebhookUrl }) {
  const [testState, setTestState] = useState(null); // null | 'sending' | 'ok' | 'error'
  const [testError, setTestError] = useState('');

  const handleTest = async () => {
    setTestState('sending');
    setTestError('');
    try {
      await axios.post(`${PRESS_API_BASE}/api/alerts/test-webhook`, { webhook_url: webhookUrl }, { timeout: REQUEST_TIMEOUT });
      setTestState('ok');
    } catch (err) {
      setTestState('error');
      setTestError((err.response && err.response.data && err.response.data.error) || 'Could not reach that URL.');
    }
  };

  return (
    <div className="trigger-form-row">
      <label className="trigger-field-label">
        Teams webhook URL
        <input
          type="text"
          value={webhookUrl}
          onChange={(e) => {
            setWebhookUrl(e.target.value);
            setTestState(null);
          }}
          placeholder="https://…webhook.office.com/webhookb2/…"
        />
      </label>
      <button type="button" className="secondary-button" disabled={!webhookUrl || testState === 'sending'} onClick={handleTest}>
        {testState === 'sending' ? 'Sending…' : 'Send Test'}
      </button>
      {testState === 'ok' && <span className="test-result test-ok">✓ Sent - check the Teams channel</span>}
      {testState === 'error' && <span className="test-result test-error">✗ {testError}</span>}
    </div>
  );
}

function AlertsView({ onBackToDefault }) {
  const [tags, setTags] = useState([]);
  const [comparators, setComparators] = useState([]);
  const [boolModes, setBoolModes] = useState([]);
  const [repeatModes, setRepeatModes] = useState(['recurring', 'one_time']);
  const [alertList, setAlertList] = useState([]);
  const [stagingTriggers, setStagingTriggers] = useState([]);
  const [label, setLabel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [repeat, setRepeat] = useState('recurring');
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
      setComparators(tagsRes.data.comparators || []);
      setBoolModes(tagsRes.data.bool_modes || []);
      setRepeatModes(tagsRes.data.repeat_modes || ['recurring', 'one_time']);
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
    if (stagingTriggers.length === 0 || !webhookUrl) return;
    setIsSubmitting(true);
    try {
      const triggers = stagingTriggers.map(({ _key, ...t }) => t);
      const res = await axios.post(
        `${PRESS_API_BASE}/api/alerts`,
        { label: label || undefined, repeat, webhook_url: webhookUrl, triggers },
        { timeout: REQUEST_TIMEOUT }
      );
      setAlertList((list) => [res.data, ...list]);
      setStagingTriggers([]);
      setLabel('');
      setWebhookUrl('');
      setRepeat('recurring');
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
    if (!window.confirm(`Delete "${rule.label || 'this alert'}"? Nothing will post to Teams for it anymore.`)) return;
    try {
      await axios.delete(`${PRESS_API_BASE}/api/alerts/${rule._id}`, { timeout: REQUEST_TIMEOUT });
      setAlertList((list) => list.filter((r) => r._id !== rule._id));
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
        Build a set of conditions on any live press tag, then create an alert that posts to a Microsoft
        Teams channel the moment any of its triggers trip. Paste in that channel's webhook URL (Teams:
        channel &rarr; ⋯ &rarr; Connectors &rarr; Incoming Webhook, or the Workflows app's "Post to a channel
        when a webhook request is received"). A recurring alert stays quiet until a trigger clears and trips
        again; a one-time alert is removed automatically right after it fires once.
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

          <TriggerBuilder tags={tags} comparators={comparators} boolModes={boolModes} onAdd={addTrigger} />

          {stagingTriggers.length > 0 && (
            <ul className="trigger-list">
              {stagingTriggers.map((t) => (
                <li key={t._key} className="trigger-list-item">
                  <span>{describeDraft(t, comparators)}</span>
                  <button type="button" className="secondary-button" onClick={() => removeStaging(t._key)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <WebhookField webhookUrl={webhookUrl} setWebhookUrl={setWebhookUrl} />

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
            <label>
              Repeat
              <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                {repeatModes.map((m) => (
                  <option key={m} value={m}>
                    {REPEAT_LABELS[m] || m}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleCreate}
              disabled={stagingTriggers.length === 0 || !webhookUrl || isSubmitting}
            >
              {isSubmitting ? 'Creating…' : 'Create Alert'}
            </button>
          </div>
          {(stagingTriggers.length === 0 || !webhookUrl) && (
            <p className="stat-sub">
              {stagingTriggers.length === 0
                ? 'Add at least one trigger above (a preset, or build one and click + Add Trigger)'
                : 'Enter a Teams webhook URL above'}{' '}
              to enable this.
            </p>
          )}

          <h3>Existing Alerts</h3>
          {alertList.length === 0 ? (
            <p className="stat-sub">No alerts created yet.</p>
          ) : (
            alertList.map((rule) => (
              <div key={rule._id} className="alert-card">
                <div className="alert-card-header">
                  <div>
                    <strong>{rule.label || 'Untitled alert'}</strong>{' '}
                    <span className="stat-sub">(webhook {rule.webhook_url_masked})</span>
                    {rule.repeat === 'one_time' && <span className="stat-sub"> · one-time</span>}
                  </div>
                  <div>
                    <button type="button" className="secondary-button" onClick={() => toggleActive(rule)}>
                      {rule.active ? 'Disable' : 'Enable'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => deleteRule(rule)}>
                      Delete
                    </button>
                  </div>
                </div>
                {!rule.active && <p className="stat-sub">Disabled — won't post to Teams.</p>}
                <ul className="trigger-list">
                  {rule.triggers.map((t) => (
                    <li key={t.id} className="trigger-list-item">
                      <span>{t.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

export default AlertsView;

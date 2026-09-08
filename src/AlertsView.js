import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT } from './Constants';

// The manual trigger builder (condition-row dropdowns, presets, staging
// list, recipient/label/repeat form) that used to live on this page was
// removed - see padp/alert-assistant, a chat-driven front end for the
// same api/alerts.py this page has always talked to (describe a request
// in plain English, confirm the exact trigger it builds, done). It
// wasn't a good fit for people who don't already know this system's own
// tag names/condition vocabulary, which was most people. This view is
// now read-only: view, enable/disable, and delete whatever alerts
// already exist. See git history for the removed builder's code if it's
// ever needed again.

function AlertsView({ onBackToDefault }) {
  const [alertList, setAlertList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${PRESS_API_BASE}/api/alerts`, { timeout: REQUEST_TIMEOUT });
      setAlertList(res.data.alerts || []);
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
        Each alert here messages a recipient on Microsoft Teams the moment any of its triggers trip.
        A recurring alert stays quiet until a trigger clears and trips again; a one-time alert is
        removed automatically right after it fires once.
      </p>

      <div className="alert-card" style={{ borderStyle: 'dashed' }}>
        <p className="stat-sub" style={{ margin: 0 }}>
          To create a new alert, use{' '}
          <a href="https://padp.github.io/alert-assistant/" target="_blank" rel="noopener noreferrer">
            Alert Assistant
          </a>{' '}
          &mdash; describe what you want in plain English and it builds and confirms the exact
          trigger for you.
        </p>
      </div>

      {isLoading ? (
        <p>Loading…</p>
      ) : error ? (
        <p>Could not reach the press API.</p>
      ) : (
        <>
          <h3>Existing Alerts</h3>
          {alertList.length === 0 ? (
            <p className="stat-sub">No alerts created yet.</p>
          ) : (
            alertList.map((rule) => (
              <div key={rule._id} className="alert-card">
                <div className="alert-card-header">
                  <div>
                    <strong>{rule.label || 'Untitled alert'}</strong>
                    {rule.recipient_email ? (
                      <span className="stat-sub"> · to {rule.recipient_email}</span>
                    ) : (
                      <span className="stat-sub"> · default recipient</span>
                    )}
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

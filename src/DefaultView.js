import React from 'react';

function getPressStatus(data) {
  if (data['Emergency Mode Active (Bool)']) return { label: 'Emergency', color: '#e74c3c' };
  if (data['Extrusion Active (Bool)']) return { label: 'Running', color: '#2ecc71' };
  if (data['Die Change Active (Bool)']) return { label: 'Die Change', color: '#f39c12' };
  if (data['Set-Up Mode Active (Bool)']) return { label: 'Setup', color: '#f39c12' };
  if (data['Manual Mode Active (Bool)']) return { label: 'Manual', color: '#3498db' };
  if (data['Automatic Mode Active (Bool)']) return { label: 'Automatic (Idle)', color: '#95a5a6' };
  return { label: 'Idle', color: '#95a5a6' };
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value === undefined || value === null || value === '' ? '—' : value}</div>
    </div>
  );
}

function DefaultView({ data, isLoading, onBuildInterface, onViewUptime, onViewAlerts }) {
  const hasData = Object.keys(data).length > 0;
  const status = hasData ? getPressStatus(data) : null;

  return (
    <div className="container default-view">
      <div className="default-view-header">
        <h1>Paducah Press</h1>
        <div>
          <button className="secondary-button" onClick={onViewUptime}>
            Billet Cycles &amp; Uptime &rarr;
          </button>
          <button className="secondary-button" onClick={onViewAlerts}>
            Alerts &rarr;
          </button>
          <button className="secondary-button" onClick={onBuildInterface}>
            Customize Your Interface &rarr;
          </button>
        </div>
      </div>

      {!hasData ? (
        <p>{isLoading ? 'Loading press data…' : 'No data available.'}</p>
      ) : (
        <>
          <div className="status-badge" style={{ backgroundColor: status.color }}>
            {status.label}
          </div>

          <div className="stat-grid">
            <StatCard label="Profile" value={data['Profile']} />
            <StatCard label="Alloy" value={data['Alloy']} />
            <StatCard label="Job Number" value={data['Job Number (#)']} />
            <StatCard label="Die Copy" value={data['Die Copy']} />
            <StatCard
              label="Billet"
              value={
                data['Billet Number (per Order)'] !== undefined
                  ? `${data['Billet Number (per Order)']} of ${data['Scheduled Billets']}`
                  : undefined
              }
            />
            <StatCard
              label="Ram Speed"
              value={
                data['Current Ram Speed (in/min)'] !== undefined
                  ? `${data['Current Ram Speed (in/min)']} in/min`
                  : undefined
              }
            />
            <StatCard
              label="Profile Speed"
              value={
                data['Profile Speed (ft/min)'] !== undefined
                  ? `${data['Profile Speed (ft/min)']} ft/min`
                  : undefined
              }
            />
            <StatCard
              label="Billet Temp"
              value={
                data['Billet Temperature Actual (F)'] !== undefined
                  ? `${data['Billet Temperature Actual (F)']}°F`
                  : undefined
              }
            />
          </div>

          <p className="last-updated">Last updated: {data['Date/Time']}</p>
        </>
      )}
    </div>
  );
}

export default DefaultView;

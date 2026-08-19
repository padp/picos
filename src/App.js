import React, { useState, useEffect } from 'react';
import DataDisplay from './DataDisplay';
import DefaultView from './DefaultView';
import PressUptimeView from './PressUptimeView';
import usePressData from './usePressData';
import { DEFAULT_PAUSE_TIME } from './Constants';

const saveToLocalStorage = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const loadFromLocalStorage = (key, defaultValue) => {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : defaultValue;
};

// A hash route (not a clean /monitor path) - this deploys to GitHub Pages,
// which serves static files with no server-side rewrite support. A clean
// path 404s on refresh/direct link unless a 404.html SPA-redirect shim is
// added; a hash never leaves the client, so #/monitor works with zero
// extra hosting config. Deliberately NOT persisted as the sticky default
// view (see the mode !== 'uptime' guard below) - landing here should
// always be an explicit destination (the nav button or a shared link),
// never something last-viewed-state silently reopens to.
const MONITOR_HASH = '#/monitor';

function App() {
  const [mode, setMode] = useState(() =>
    window.location.hash === MONITOR_HASH ? 'uptime' : loadFromLocalStorage('viewMode', 'default')
  );
  const [intervalTime, setIntervalTime] = useState(DEFAULT_PAUSE_TIME);
  const { data, isLoading } = usePressData(intervalTime);

  useEffect(() => {
    if (mode !== 'uptime') {
      saveToLocalStorage('viewMode', mode);
    }
    document.title = mode === 'uptime' ? 'Press Monitor' : 'Press 2 Datastream';
  }, [mode]);

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === MONITOR_HASH) {
        setMode('uptime');
      } else {
        setMode((current) => (current === 'uptime' ? loadFromLocalStorage('viewMode', 'default') : current));
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const goToMonitor = () => {
    window.location.hash = '/monitor';
    setMode('uptime');
  };

  const leaveMonitor = () => {
    if (window.location.hash === MONITOR_HASH) {
      window.history.pushState('', document.title, window.location.pathname + window.location.search);
    }
    setMode('default');
  };

  return (
    <div className="App">
      {mode === 'default' ? (
        <DefaultView
          data={data}
          isLoading={isLoading}
          onBuildInterface={() => setMode('builder')}
          onViewUptime={goToMonitor}
        />
      ) : mode === 'uptime' ? (
        <PressUptimeView onBackToDefault={leaveMonitor} />
      ) : (
        <DataDisplay
          data={data}
          intervalTime={intervalTime}
          setIntervalTime={setIntervalTime}
          onBackToDefault={() => setMode('default')}
        />
      )}
    </div>
  );
}

export default App;

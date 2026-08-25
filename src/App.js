import React, { useState, useEffect } from 'react';
import DataDisplay from './DataDisplay';
import DefaultView from './DefaultView';
import PressUptimeView from './PressUptimeView';
import OperatorMonitorView from './OperatorMonitorView';
import usePressData from './usePressData';
import { DEFAULT_PAUSE_TIME } from './Constants';

const saveToLocalStorage = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const loadFromLocalStorage = (key, defaultValue) => {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : defaultValue;
};

// Hash routes (not clean paths) - this deploys to GitHub Pages, which
// serves static files with no server-side rewrite support. A clean path
// 404s on refresh/direct link unless a 404.html SPA-redirect shim is
// added; a hash never leaves the client, so these work with zero extra
// hosting config. Deliberately NOT persisted as the sticky default view
// (see the HASH_MODES guard below) - landing on one should always be an
// explicit destination (a nav button or a shared/bookmarked link, e.g.
// the operator kiosk display pointed straight at #/operator-monitor),
// never something last-viewed-state silently reopens to.
const HASH_ROUTES = {
  '#/monitor': 'uptime',
  '#/operator-monitor': 'operator',
};
const HASH_MODES = new Set(Object.values(HASH_ROUTES));
const TITLES = {
  uptime: 'Press Monitor',
  operator: 'Press Operator Monitor',
};

function App() {
  const [mode, setMode] = useState(() => HASH_ROUTES[window.location.hash] || loadFromLocalStorage('viewMode', 'default'));
  const [intervalTime, setIntervalTime] = useState(DEFAULT_PAUSE_TIME);
  const { data, isLoading } = usePressData(intervalTime);

  useEffect(() => {
    if (!HASH_MODES.has(mode)) {
      saveToLocalStorage('viewMode', mode);
    }
    document.title = TITLES[mode] || 'Press 2 Datastream';
  }, [mode]);

  useEffect(() => {
    const onHashChange = () => {
      const routedMode = HASH_ROUTES[window.location.hash];
      if (routedMode) {
        setMode(routedMode);
      } else {
        setMode((current) => (HASH_MODES.has(current) ? loadFromLocalStorage('viewMode', 'default') : current));
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const goToRoute = (hash, targetMode) => {
    window.location.hash = hash;
    setMode(targetMode);
  };

  const leaveRoute = () => {
    if (HASH_MODES.has(mode)) {
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
          onViewUptime={() => goToRoute('/monitor', 'uptime')}
        />
      ) : mode === 'uptime' ? (
        <PressUptimeView
          onBackToDefault={leaveRoute}
          onOpenOperatorView={() => goToRoute('/operator-monitor', 'operator')}
        />
      ) : mode === 'operator' ? (
        <OperatorMonitorView onBackToDefault={leaveRoute} />
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

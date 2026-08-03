import React, { useState, useEffect } from 'react';
import DataDisplay from './DataDisplay';
import DefaultView from './DefaultView';
import usePressData from './usePressData';
import { DEFAULT_PAUSE_TIME } from './Constants';

const saveToLocalStorage = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const loadFromLocalStorage = (key, defaultValue) => {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : defaultValue;
};

function App() {
  const [mode, setMode] = useState(() => loadFromLocalStorage('viewMode', 'default'));
  const [intervalTime, setIntervalTime] = useState(DEFAULT_PAUSE_TIME);
  const { data, isLoading } = usePressData(intervalTime);

  useEffect(() => {
    saveToLocalStorage('viewMode', mode);
  }, [mode]);

  return (
    <div className="App">
      {mode === 'default' ? (
        <DefaultView data={data} isLoading={isLoading} onBuildInterface={() => setMode('builder')} />
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

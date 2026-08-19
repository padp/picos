import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT, UPTIME_PAUSE_TIME } from './Constants';

function usePressUptime(windowHours) {
  const [status, setStatus] = useState(null);
  const [uptime, setUptime] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [billets, setBillets] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async (signal) => {
    try {
      const [statusRes, uptimeRes, breakdownRes, billetsRes] = await Promise.all([
        axios.get(`${PRESS_API_BASE}/api/press/status`, { timeout: REQUEST_TIMEOUT, signal }),
        axios.get(`${PRESS_API_BASE}/api/press/uptime`, {
          timeout: REQUEST_TIMEOUT, signal, params: { hours: windowHours },
        }),
        axios.get(`${PRESS_API_BASE}/api/press/cycle-breakdown`, {
          timeout: REQUEST_TIMEOUT, signal, params: { hours: windowHours },
        }),
        axios.get(`${PRESS_API_BASE}/api/press/billets/recent`, {
          timeout: REQUEST_TIMEOUT, signal, params: { limit: 25 },
        }),
      ]);
      setStatus(statusRes.data);
      setUptime(uptimeRes.data);
      setBreakdown(breakdownRes.data);
      setBillets(billetsRes.data.billets || []);
      setError(null);
    } catch (err) {
      if (axios.isCancel(err)) return;
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    fetchAll(controller.signal);
    const interval = setInterval(() => fetchAll(controller.signal), UPTIME_PAUSE_TIME);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [fetchAll]);

  return { status, uptime, breakdown, billets, isLoading, error };
}

export default usePressUptime;

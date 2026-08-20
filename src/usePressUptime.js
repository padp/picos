import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { PRESS_API_BASE, REQUEST_TIMEOUT, UPTIME_PAUSE_TIME } from './Constants';

// shiftParams is either null (server picks the current shift) or
// { date, shift } to view a specific one.
function usePressUptime(shiftParams) {
  const [status, setStatus] = useState(null);
  const [uptime, setUptime] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [billets, setBillets] = useState([]);
  const [stoppages, setStoppages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const params = shiftParams ? { date: shiftParams.date, shift: shiftParams.shift } : {};

  const fetchAll = useCallback(async (signal) => {
    try {
      const [statusRes, uptimeRes, breakdownRes, billetsRes, stoppagesRes] = await Promise.all([
        axios.get(`${PRESS_API_BASE}/api/press/status`, { timeout: REQUEST_TIMEOUT, signal }),
        axios.get(`${PRESS_API_BASE}/api/press/uptime`, { timeout: REQUEST_TIMEOUT, signal, params }),
        axios.get(`${PRESS_API_BASE}/api/press/cycle-breakdown`, { timeout: REQUEST_TIMEOUT, signal, params }),
        axios.get(`${PRESS_API_BASE}/api/press/billets/recent`, { timeout: REQUEST_TIMEOUT, signal, params }),
        axios.get(`${PRESS_API_BASE}/api/press/stoppages`, { timeout: REQUEST_TIMEOUT, signal, params }),
      ]);
      setStatus(statusRes.data);
      setUptime(uptimeRes.data);
      setBreakdown(breakdownRes.data);
      setBillets(billetsRes.data.billets || []);
      setStoppages(stoppagesRes.data.stoppages || []);
      setError(null);
    } catch (err) {
      if (axios.isCancel(err)) return;
      setError(err);
    } finally {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftParams && shiftParams.date, shiftParams && shiftParams.shift]);

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

  return { status, uptime, breakdown, billets, stoppages, isLoading, error };
}

export default usePressUptime;

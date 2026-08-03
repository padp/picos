import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URI, FALLBACK_API_URI, REQUEST_TIMEOUT, DEFAULT_PAUSE_TIME } from './Constants';

function usePressData(intervalTime = DEFAULT_PAUSE_TIME) {
  const [data, setData] = useState({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      let response;
      try {
        response = await axios.get(API_URI, { timeout: REQUEST_TIMEOUT });
      } catch (primaryError) {
        console.error('Primary API failed, trying fallback:', primaryError);
        try {
          response = await axios.get(FALLBACK_API_URI, { timeout: REQUEST_TIMEOUT });
        } catch (fallbackError) {
          console.error('Fallback API also failed:', fallbackError);
          if (!cancelled) setIsLoading(false);
          return;
        }
      }

      const fetchedData = response.data[0]; // Assumes data is in the first element
      if (fetchedData && '_id' in fetchedData) {
        delete fetchedData['_id'];
      }
      if (!cancelled && fetchedData && Object.keys(fetchedData).length > 0) {
        setData(fetchedData);
      }
      if (!cancelled) setIsLoading(false);
    };

    fetchData();
    const interval = setInterval(fetchData, intervalTime);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [intervalTime]);

  return { data, isLoading };
}

export default usePressData;

import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URI, DEFAULT_PAUSE_TIME } from './Constants';

function usePressData(intervalTime = DEFAULT_PAUSE_TIME) {
  const [data, setData] = useState({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        const response = await axios.get(API_URI);
        const fetchedData = response.data[0]; // Assumes data is in the first element
        if (fetchedData && '_id' in fetchedData) {
          delete fetchedData['_id'];
        }
        if (!cancelled && fetchedData && Object.keys(fetchedData).length > 0) {
          setData(fetchedData);
        }
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
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

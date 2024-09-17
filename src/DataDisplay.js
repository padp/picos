import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import Select from 'react-select';
import { API_URI, DEFAULT_PAUSE_TIME } from './Constants';
import EditableText from './EditableText';

const ItemTypes = {
  KEY: 'key',
};

// Save to localStorage
const saveToLocalStorage = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

// Load from localStorage
const loadFromLocalStorage = (key, defaultValue) => {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : defaultValue;
};

function WelcomeDialog({ closeDialog }) {
  return (
    <div style={{
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      padding: '20px', backgroundColor: '#fff', boxShadow: '0 4px 8px rgba(0, 0, 0, 0.5)',
      zIndex: 1000, width: '800px', textAlign: 'center', borderRadius: '20px', opacity: '95%', borderStyle: 'solid', borderColor: 'gray'
    }}>
      <h3>Welcome!</h3>
      <p>This video is shown only on your first visit and will show you how to customize your data feed.</p>
      <video
        width="100%" // Ensures the video fills the available width
        autoPlay
        muted
        controls // Adds play/pause controls for the video
      >
        <source src="blob/master/public/Instructions.mp4" type="video/mp4" />
        Your browser does not support the video tag.
      </video>
      <button onClick={closeDialog} style={{
        padding: '10px', backgroundColor: '#3498db', color: '#fff', border: 'none', borderRadius: '5px'
      }}>
        Skip
      </button>
    </div>
  );
}

function DraggableKey({ keyName }) {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: ItemTypes.KEY,
    item: { keyName },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging(),
    }),
  }));

  return (
    <div
      ref={drag}
      style={{
        opacity: isDragging ? 0.5 : 1,
        padding: '8px',
        margin: '4px',
        backgroundColor: 'lightblue',
        cursor: 'move',
        border: '1px solid black',
        borderRadius: '5px',
      }}
    >
      {keyName}
    </div>
  );
}

function DroppableDiv({ keysInDiv = [], setKeysInDiv, data, title, setTitle }) {
  const [{ isOver }, drop] = useDrop(() => ({
    accept: ItemTypes.KEY,
    drop: (item) => {
      setKeysInDiv(item.keyName);
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver(),
    }),
  }));

  const handleRemove = (keyToRemove) => {
    setKeysInDiv((prevKeys) => prevKeys.filter((key) => key !== keyToRemove));
  };

  const handleTextChange = (newText) => {
    setTitle(newText);
  };

  return (
    <div ref={drop} className="droppable-div">
      {/* Title Centered */}
      <h3> <EditableText text={title} onTextChange={handleTextChange} /></h3>

      {/* Flexbox Content */}
      <div className="flex-content">
        {keysInDiv.length === 0 ? (
          <p>Drop keys here</p>
        ) : (
          keysInDiv.map((key) => {
            const list = data[key] || [];
            const lastItem = list.length > 0 ? list[list.length - 1] : 'No data or fetch failed';
            return (
              <div className='key-item' key={key}>
                <strong>{key}:</strong> <p>{lastItem ? JSON.stringify(lastItem) : 'Error retrieving data'}</p>
                <span className="remove-btn" onClick={() => handleRemove(key)}>
                  &times;
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}


function DataDisplay() {
  const [data, setData] = useState({});
  const [availableKeys, setAvailableKeys] = useState([]);
  const [divs, setDivs] = useState(loadFromLocalStorage('divs', [{ keys: [], title: 'Default Title' }])); // Load from localStorage
  const [intervalTime, setIntervalTime] = useState(DEFAULT_PAUSE_TIME);
  const [selectedKey, setSelectedKey] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [title, setTitle] = useState("Double-click me to edit");

  const selectedKeyHandler = (selectedOption) => {
    setSelectedKey(selectedOption);
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await axios.get(API_URI); // Adjust the URL
        const fetchedData = response.data[0]; // Assumes data is in the first element
        if (fetchedData && '_id' in fetchedData) {
          delete fetchedData['_id'];
        }
        if (fetchedData && Object.keys(fetchedData).length > 0) {
          setData(fetchedData);
          if (availableKeys.length === 0) {
            setAvailableKeys(Object.keys(fetchedData)); // Set keys on first fetch
          }
        }
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, intervalTime);
    return () => clearInterval(interval);
  }, [intervalTime, availableKeys, selectedKey]);

  useEffect(() => {
    // Check if the user has visited before
    const hasVisited = localStorage.getItem('hasVisited');

    if (!hasVisited) {
      // If not, show the dialog and set the flag in localStorage
      setShowDialog(true);
      localStorage.setItem('hasVisited', 'true');
    }
  }, []);

  const closeDialog = () => {
    setShowDialog(false);
  };
  
  // Function to add a new empty div with a title
  const addDiv = () => {
    setDivs((prevDivs) => [...prevDivs, { keys: [], title: 'New Container' }]);
  };

  // Correctly updating the keys in the div
  const updateKeysInDiv = (index, newKeyOrFunction) => {
    setDivs((prevDivs) => {
      const updatedDivs = [...prevDivs];

      if (typeof newKeyOrFunction === 'string') {
        updatedDivs[index].keys = [...updatedDivs[index].keys, newKeyOrFunction];
      } else if (Array.isArray(newKeyOrFunction)) {
        updatedDivs[index].keys = [...new Set([...updatedDivs[index].keys, ...newKeyOrFunction])];
      } else if (typeof newKeyOrFunction === 'function') {
        updatedDivs[index].keys = newKeyOrFunction(updatedDivs[index].keys);
      }

      return updatedDivs;
    });
  };

  // Function to update title
  const updateTitle = (index, newTitle) => {
    setDivs((prevDivs) => {
      const updatedDivs = [...prevDivs];
      updatedDivs[index].title = newTitle;
      return updatedDivs;
    });
  };

  // Use useEffect to save divs to localStorage whenever it changes
  useEffect(() => {
    saveToLocalStorage('divs', divs);
  }, [divs]);

  const keyOptions = availableKeys.map((key) => ({
    value: key,
    label: key,
  }));

  return (
    <DndProvider backend={HTML5Backend}>
      {showDialog && <WelcomeDialog closeDialog={closeDialog} />}
      <div className="container">
        <h1>Paducah Press Data</h1>

        <div className="select-container">
          <label htmlFor="keySelect">Select a key:</label>
          <Select
            id="keySelect"
            options={keyOptions}
            onChange={selectedKeyHandler}
            value={selectedKey}
            placeholder="Select a key"
            isSearchable
          />

          {selectedKey && (
            <div style={{ marginTop: '20px' }}>
              <h3>Drag your selected key:</h3>
              <DraggableKey key={selectedKey.value} keyName={selectedKey.value} />
            </div>
          )}
        </div>

        <div className="droppable-areas-container">
          {divs.map((div, index) => (
            <DroppableDiv
              key={index}
              keysInDiv={div.keys || []}
              setKeysInDiv={(newKey) => updateKeysInDiv(index, newKey)}
              data={data}
              title={div.title}
              setTitle={(newTitle) => updateTitle(index, newTitle)}
            />
          ))}
        </div>

        <button className="add-div-button" onClick={addDiv}>Add Container</button>

        <div style={{ marginTop: '20px' }}>
          <label>
            Data Retrieval Interval (milliseconds):
            <input
              type="number"
              value={intervalTime}
              min="1000"
              onChange={(e) => setIntervalTime(Math.max(Number(e.target.value), 1000))}
            />
          </label>
        </div>
      </div>
    </DndProvider>
  );
}

export default DataDisplay;

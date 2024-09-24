import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import Select from 'react-select';
import { API_URI, DEFAULT_PAUSE_TIME } from './Constants';
import EditableText from './EditableText';
import DatalogComponent from './DatalogComponent';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Tooltip from '@mui/material/Tooltip/Tooltip';

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
      zIndex: 1000, width: '90vw', maxWidth: '800px', textAlign: 'center', borderRadius: '20px',
      opacity: '95%', borderStyle: 'solid', borderColor: 'gray'
    }}>
      <h3>Welcome!</h3>
      <p>This video is shown only on your first visit and will show you how to customize your data feed.</p>
      <video
        width="100%" // Ensures the video fills the available width
        autoPlay
        muted
        controls // Adds play/pause controls for the video
      >
        <source src={`${process.env.PUBLIC_URL}/Instructions.mp4`} type="video/mp4" />
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

function DroppableDiv({ keysInDiv = [], setKeysInDiv, data, title, setTitle, selectedKey }) {
  const [{ isOver }, drop] = useDrop(() => ({
    accept: ItemTypes.KEY,
    drop: (item) => {
      setKeysInDiv((prevKeys) => [...new Set([...prevKeys, item.keyName])]); // Avoid duplicates
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

  // Handle click on the plus button to add the selected key
  const handleAddSelectedKey = () => {
    console.log(selectedKey);
    if (selectedKey) {
      setKeysInDiv((prevKeys) => [...new Set([...prevKeys, selectedKey.value])]); // Avoid duplicates
    }
  };

  return (
    <div ref={drop} className="droppable-div" style={{ minHeight: '200px', border: '1px solid black', margin: '10px', backgroundColor: isOver ? 'lightgreen' : 'transparent' }}>
      <div style={{
        cursor: 'pointer',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        margin: '0%',
      }}>
        <Tooltip title="Add selected key to this container">
          <div
            style={addButtonStyle}
            onClick={handleAddSelectedKey}
            onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.95)'} // Click effect
            onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'} // Reset scale after click
            onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'} // Ensure scale is reset if mouse leaves button during click
          >
            Add Selected
            <p style={{ fontSize: '200%', marginTop: '2.5px', marginBottom: '0px', }}><FontAwesomeIcon icon={faPlus} /></p>
          </div>
        </Tooltip>
      </div>

      <h3 style={{ marginTop: '0px' }}> <EditableText text={title} onTextChange={handleTextChange} /></h3>

      <div className="flex-content">
        {keysInDiv.length === 0 ? (
          <p>Drop keys here or use the Add button</p>
        ) : (
          keysInDiv.map((key) => {
            const item = data[key];
            return (
              <div className='key-item' key={key}>
                <strong>{key}:</strong> <p>{typeof item === 'boolean' ? item.toString() : item}</p>
                <span className="remove-btn" onClick={() => handleRemove(key)}>
                  &times;
                </span>
              </div>
            );
          })
        )}
      </div>
      <DatalogComponent data={data} divKeys={keysInDiv} />
    </div>
  );
}

// Add button styles with hover and click effects
const addButtonStyle = {
  fontSize: '50%',
  width: '10%',
  margin: '0%',
  borderRadius: '20px',
  borderColor: '#454a53',
  borderStyle: 'dotted',
  borderWidth: 'thin',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  backgroundColor: '#f4f4f4',
  transition: 'background-color 0.3s ease, transform 0.2s ease',
  padding: '5px',
};

// Hover effect for the Add button
addButtonStyle[':hover'] = {
  backgroundColor: '#e0e0e0',
  transform: 'scale(1.05)',
};

function DataDisplay() {
  const [data, setData] = useState({});
  const [availableKeys, setAvailableKeys] = useState([]);
  const [divs, setDivs] = useState(loadFromLocalStorage('divs', [{ keys: [], title: 'Default Title' }])); // Load from localStorage
  const [intervalTime, setIntervalTime] = useState(DEFAULT_PAUSE_TIME);
  const [selectedKey, setSelectedKey] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  //const [title, setTitle] = useState("Double-click me to edit");

  const selectedKeyHandler = (selectedOption) => {
    setSelectedKey(selectedOption);
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await axios.get(API_URI); // Adjust the URL
        const fetchedData = response.data[0]; // Assumes data is in the first element
        console.log(fetchedData);
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
              selectedKey={selectedKey}
            />
          ))}
        </div>

        <button className="add-div-button" onClick={addDiv}>Add Container</button>

        <div style={{ marginTop: '20px' }}>
          <label>
            Data Retrieval Interval (seconds):
            <input
              type="number"
              value={intervalTime / 1000} // Convert milliseconds to seconds for display
              min="1" // Minimum value in seconds (1 second)
              onChange={(e) => setIntervalTime(Math.max(Number(e.target.value) * 1000, 1000))} // Convert seconds to milliseconds for internal use
            />
          </label>
        </div>
      </div>
    </DndProvider>
  );
}

export default DataDisplay;

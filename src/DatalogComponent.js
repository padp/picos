import React, { useState, useEffect } from 'react'; 
import { openDB } from 'idb';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircle, faStop, faTachometerAlt, faTimes, faCalendarAlt } from '@fortawesome/free-solid-svg-icons';
import Tooltip from '@mui/material/Tooltip/Tooltip';

const initDB = async () => {
    const db = await openDB('DatalogDB', 1, {
        upgrade(db) {
            if (!db.objectStoreNames.contains('datalog')) {
                db.createObjectStore('datalog', { keyPath: 'id', autoIncrement: true });
            }
        },
    });
    return db;
};

const saveKeyValue = async (data) => {
    const db = await initDB();
    await db.add('datalog', data);
};

const getAllKeyValues = async () => {
    const db = await initDB();
    return await db.getAll('datalog');
};

const clearData = async () => {
    const db = await initDB();
    await db.clear('datalog');
};

const DatalogComponent = ({ data, divKeys }) => {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingStartTime, setRecordingStartTime] = useState(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [scheduleTime, setScheduleTime] = useState(null);
    const [maxRecordTime, setMaxRecordTime] = useState(4 * 60 * 60 * 1000); // 4 hours in milliseconds

    // Auto-save relevant data (based on divKeys) on state updates while recording
    useEffect(() => {
        if (isRecording && data) {
            const filteredData = divKeys.reduce((acc, key) => {
                if (data[key] !== undefined) acc[key] = data[key];
                return acc;
            }, {});
            if (Object.keys(filteredData).length > 0) {
                saveKeyValue(filteredData);  // Save the filtered state of the data to IndexedDB
            }
        }
    }, [data, isRecording, divKeys]);

    // Automatically stop recording after the max time
    useEffect(() => {
        if (isRecording && recordingStartTime) {
            const timeout = setTimeout(() => {
                stopRecording();
            }, maxRecordTime);

            return () => clearTimeout(timeout);
        }
    }, [isRecording, recordingStartTime, maxRecordTime]);

    const startRecording = () => {
        setIsRecording(true);
        setRecordingStartTime(new Date().getTime());
        setIsDialogOpen(false);
    };

    const stopRecording = async () => {
        setIsRecording(false);
        setRecordingStartTime(null);

        // Fetch data from IndexedDB and trigger download
        const datas = await getAllKeyValues();
        generateCSV(datas);
        clearData();
    };

    const generateCSV = (datas) => {
        if (datas.length === 0) return;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `datalog-${timestamp}.csv`;

        // Only include relevant keys
        let csvContent = divKeys.join(',') + '\n';
        datas.forEach((dict) => {
            const row = divKeys.map((key) => dict[key] !== undefined ? dict[key] : '').join(',');
            csvContent += row + '\n';
        });

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Schedule the recording
    const scheduleRecording = () => {
        if (scheduleTime) {
            const startTime = new Date(scheduleTime).getTime();
            const now = new Date().getTime();
            if (startTime > now) {
                setTimeout(() => {
                    startRecording();
                }, startTime - now);
            }
            setIsDialogOpen(false);
        }
    };

    return (
        <div>
            {isRecording ? (
                <Tooltip title="Stop Recording Data">
                    <button onClick={stopRecording} style={isRecording ? { ...buttonStyle, ...flashingButtonStyle } : buttonStyle}>
                        <FontAwesomeIcon icon={faStop} style={iconStyle} />
                    </button>
                </Tooltip>
            ) : (
                <Tooltip title="Start Recording Data">
                    <button onClick={() => setIsDialogOpen(true)} style={buttonStyle}>
                        <FontAwesomeIcon icon={faCircle} style={{ ...iconStyle, color: 'red' }} />
                    </button>
                </Tooltip>
            )}

            {isDialogOpen && (
                <div>
                    <h3>Choose Recording Option</h3>
                    <div style={divStyle}>
                        <Tooltip title="Quickstart">
                            <button onClick={startRecording} style={buttonStyle}>
                                <FontAwesomeIcon icon={faTachometerAlt} style={{ ...iconStyle, color: 'black' }} />
                            </button>
                        </Tooltip>
                        <Tooltip title="Schedule Recording">
                            <div>
                                <input
                                    type="datetime-local"
                                    onChange={(e) => setScheduleTime(e.target.value)}
                                    style={{ marginBottom: '10px', fontSize: '14px', padding: '5px' }}
                                />
                                <button onClick={scheduleRecording} style={buttonStyle}>
                                    <FontAwesomeIcon icon={faCalendarAlt} style={{ ...iconStyle, color: 'black' }} />
                                </button>
                            </div>
                        </Tooltip>
                        <Tooltip title="Cancel">
                            <button onClick={() => setIsDialogOpen(false)} style={buttonStyle}>
                                <FontAwesomeIcon icon={faTimes} style={{ ...iconStyle, color: 'black' }} />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            )}
        </div>
    );
};

const divStyle = {
    padding: '1%',
    display: 'flex',
    justifyContent: 'center',
    gap: '2.5%',
};

// Base button style
const buttonStyle = {
    padding: '10px 20px',
    fontSize: '16px',
    backgroundColor: 'rgb(107 117 234 / 36%)',
    border: '1px solid #ccc',
    borderRadius: '5px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    marginBottom: '5px',
    transition: 'background-color 0.3s ease', // for hover effect
};

// Flashing animation while recording
const flashingButtonStyle = {
    animation: 'flashingBackground 1.5s infinite',  // CSS animation
};

// Icon style
const iconStyle = {
    fontSize: '20px',
};

// CSS for keyframe animations
const flashingAnimation = `
@keyframes flashingBackground {
    0% { background-color: rgba(255, 0, 0, 0.5); }
    50% { background-color: rgba(255, 0, 0, 1); }
    100% { background-color: rgba(255, 0, 0, 0.5); }
}
`;

// Injecting the keyframes into the DOM
const styleElement = document.createElement("style");
styleElement.type = "text/css";
styleElement.appendChild(document.createTextNode(flashingAnimation));
document.head.appendChild(styleElement);

export default DatalogComponent;

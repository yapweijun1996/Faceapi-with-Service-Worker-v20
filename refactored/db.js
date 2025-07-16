/**
 * db.js
 * -----
 * This module manages all interactions with IndexedDB for persisting user
 * registration progress. It handles opening the database and saving/loading
 * the current registration state, allowing users to resume an incomplete
 * registration.
 */

import { config } from './config.js';
import { state } from './state.js';
import { addCapturePreview, updateRegistrationProgress } from './ui.js';

/**
 * Opens a connection to the IndexedDB database.
 * @returns {Promise<IDBDatabase>} A promise that resolves with the database instance.
 */
function openProgressDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(config.db.name, config.db.version);
        request.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(config.db.store)) {
                db.createObjectStore(config.db.store, { keyPath: 'id' });
            }
        };
        request.onsuccess = e => resolve(e.target.result);
        request.onerror = e => reject(e.target.error);
    });
}

/**
 * Saves the current registration progress to IndexedDB.
 */
export function saveProgress() {
    const data = {
        id: state.registration.currentUserId,
        name: state.registration.currentUserName,
        descriptors: state.registration.currentUserDescriptors.map(d => Array.from(d)),
        capturedFrames: state.registration.capturedFrames,
    };
    openProgressDB().then(db => {
        const tx = db.transaction(config.db.store, 'readwrite');
        tx.objectStore(config.db.store).put({ id: 'current', data });
    }).catch(e => console.warn('Failed to save progress', e));
}

/**
 * Loads registration progress from IndexedDB.
 */
export function loadProgress() {
    openProgressDB().then(db => {
        const tx = db.transaction(config.db.store, 'readonly');
        const req = tx.objectStore(config.db.store).get('current');
        req.onsuccess = () => {
            const record = req.result;
            if (!record || !record.data || !Array.isArray(record.data.descriptors)) return;

            const data = record.data;
            state.registration.currentUserId = data.id || '';
            state.registration.currentUserName = data.name || '';
            state.registration.currentUserDescriptors = data.descriptors.map(arr => new Float32Array(arr));
            state.registration.capturedFrames = Array.isArray(data.capturedFrames) ? data.capturedFrames : [];

            const idInput = document.getElementById(config.ui.userIdInput);
            const nameInput = document.getElementById(config.ui.userNameInput);
            if (idInput) idInput.value = state.registration.currentUserId;
            if (nameInput) nameInput.value = state.registration.currentUserName;

            state.registration.capturedFrames.forEach(url => addCapturePreview(url));
            updateRegistrationProgress();
        };
    }).catch(e => console.warn('Failed to load progress', e));
}

/**
 * Clears the saved registration progress from IndexedDB.
 */
export function clearProgress() {
    openProgressDB().then(db => {
        const tx = db.transaction(config.db.store, 'readwrite');
        tx.objectStore(config.db.store).delete('current');
    }).catch(() => {});
}

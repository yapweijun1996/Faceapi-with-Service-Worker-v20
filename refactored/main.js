/**
 * main.js
 * -------
 * This is the main entry point for the refactored face verification application.
 * It imports all the necessary modules, initializes the application state,
 * sets up event listeners, and orchestrates the overall workflow.
 */

import { config } from './config.js';
import { state } from './state.js';
import { initializeWorker } from './worker.js';
import { startCamera, stopCamera } from './camera.js';
import {
    video_face_detection,
    retakeLastCapture,
    restartRegistration,
    cancelRegistration,
    restartVerification,
    cancelVerification,
    downloadRegistrationData,
} from './faceApi.js';
import { loadProgress, clearProgress } from './db.js';
import {
    updateRegistrationProgress,
    updateVerificationProgress,
    showModalImage,
    hideModal,
    populateVerificationList,
    showMessage,
} from './ui.js';

/**
 * Adjusts face detection options based on device capabilities.
 */
function adjustDetectionForDevice() {
    try {
        const mem = navigator.deviceMemory || 4;
        const cores = navigator.hardwareConcurrency || 4;
        if (mem <= 2 || cores <= 2) {
            state.faceDetectorOptions.inputSize = 96;
            state.faceDetectorOptions.scoreThreshold = Math.max(state.faceDetectorOptions.scoreThreshold || 0.5, 0.5);
        }
    } catch (err) {
        console.warn('Device capability detection failed', err);
    }
}

/**
 * Handles the selection of JSON files for verification.
 * Reads the files, updates the state, and starts the verification process.
 * @param {Event} event - The file input change event.
 */
async function handleJsonFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0) {
        showMessage('error', 'No files selected.');
        return;
    }

    // Reset previous verification state
    state.verification.registeredUsers = [];
    state.verification.flatRegisteredDescriptors = [];
    state.verification.flatRegisteredUserMeta = [];
    state.verification.verifiedUserIds.clear();
    state.verification.verifiedCount = 0;

    const fileReadPromises = Array.from(files).map(file => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (data && data.id && data.descriptors && Array.isArray(data.descriptors)) {
                        state.verification.registeredUsers.push(data);
                        data.descriptors.forEach(desc => {
                            state.verification.flatRegisteredDescriptors.push(new Float32Array(desc));
                            state.verification.flatRegisteredUserMeta.push({ id: data.id, name: data.name });
                        });
                        resolve();
                    } else {
                        reject(new Error(`Invalid JSON format in ${file.name}`));
                    }
                } catch (err) {
                    reject(new Error(`Error parsing ${file.name}: ${err.message}`));
                }
            };
            reader.onerror = (err) => reject(new Error(`Error reading ${file.name}: ${err.message}`));
            reader.readAsText(file);
        });
    });

    try {
        await Promise.all(fileReadPromises);
    } catch (err) {
        showMessage('error', err.message);
        // Clear the file input so the user can try again
        event.target.value = '';
        return;
    }

    if (state.verification.registeredUsers.length === 0) {
        showMessage('error', 'No valid user data found in the selected files.');
        return;
    }

    state.verification.totalFaces = state.verification.registeredUsers.length;
    populateVerificationList();
    updateVerificationProgress();

    // Switch UI from loading step to verification step
    document.getElementById('loadDataStep').style.display = 'none';
    document.getElementById('verifyStep').style.display = 'block';

    // Start the camera and detection loop
    await startCamera();
    video_face_detection();
}

/**
 * Initializes all event listeners for UI elements.
 */
function initializeEventListeners() {
    // Registration buttons
    document.getElementById(config.ui.retakeBtn)?.addEventListener('click', retakeLastCapture);
    document.getElementById(config.ui.restartBtn)?.addEventListener('click', restartRegistration);
    document.getElementById(config.ui.cancelBtn)?.addEventListener('click', cancelRegistration);
    document.getElementById(config.ui.downloadBtn)?.addEventListener('click', downloadRegistrationData);

    // Verification buttons
    document.getElementById(config.ui.verifyRestartBtn)?.addEventListener('click', restartVerification);
    document.getElementById(config.ui.verifyCancelBtn)?.addEventListener('click', cancelVerification);

    // Image modal events
    const modalEl = document.getElementById(config.ui.imageModal);
    if (modalEl) {
        modalEl.querySelector('.prev')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.registration.currentModalIndex > 0) {
                showModalImage(state.registration.currentModalIndex - 1);
            }
        });
        modalEl.querySelector('.next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.registration.currentModalIndex < state.registration.capturedFrames.length - 1) {
                showModalImage(state.registration.currentModalIndex + 1);
            }
        });
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl || e.target.classList.contains('close')) {
                hideModal();
            }
        });
    }

    // Capture preview click
    document.getElementById(config.ui.capturePreview)?.addEventListener('click', (e) => {
        if (e.target.classList.contains('capture-thumb')) {
            e.stopPropagation();
            showModalImage(parseInt(e.target.dataset.index, 10));
        }
    });

    // Start camera on registration page
    document.getElementById('startRegistrationBtn')?.addEventListener('click', async () => {
        // Hide user info and show capture step
        document.getElementById('userInfoStep').style.display = 'none';
        document.getElementById('captureStep').style.display = 'block';
        await startCamera();
        video_face_detection();
    });

    // Verification file input
    document.getElementById('jsonFileInput')?.addEventListener('change', handleJsonFileSelect);
}

/**
 * Main initialization function for the application.
 */
async function main() {
    document.addEventListener("DOMContentLoaded", async () => {
        clearProgress();
        loadProgress();
        adjustDetectionForDevice();
        initializeEventListeners();
        updateRegistrationProgress();
        updateVerificationProgress();

        await initializeWorker();

        // Set the action based on the current page
        if (window.location.pathname.includes('face_register.html')) {
            state.faceapiAction = 'register';
        } else if (window.location.pathname.includes('face_verify.html')) {
            state.faceapiAction = 'verify';
        }
    });
}

main();

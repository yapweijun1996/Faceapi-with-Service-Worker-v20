/**
 * faceApi.js
 * ----------
 * This module contains the core logic for interacting with the face-api.js
 * library. It handles processing detection results from the worker, managing
 * the registration and verification processes, and drawing visual feedback
 * (like bounding boxes and landmarks) on the canvas overlays.
 */

import { config } from './config.js';
import { state } from './state.js';
import {
    showMessage,
    showVerifyToast,
    updateRegistrationProgress,
    updateVerificationProgress,
    updateUserVerificationStatus,
    addCapturePreview,
    toggleOverlay,
    clearAllCanvases,
    clearCapturePreviews,
    removeLastCapturePreview,
    drawRegistrationOverlay,
} from './ui.js';
import { stopCamera } from './camera.js';
import { saveProgress, clearProgress } from './db.js';

// --- Helper Functions ---

/**
 * Computes the mean of an array of face descriptors.
 * @param {Array<Float32Array>} descriptors - An array of face descriptors.
 * @returns {Float32Array|null} The mean descriptor or null if input is empty.
 */
function computeMeanDescriptor(descriptors) {
    if (!descriptors || descriptors.length === 0) return null;
    const len = descriptors[0].length;
    const mean = new Float32Array(len);
    descriptors.forEach(desc => {
        for (let i = 0; i < len; i++) {
            mean[i] += desc[i];
        }
    });
    for (let i = 0; i < len; i++) {
        mean[i] /= descriptors.length;
    }
    return mean;
}

/**
 * Checks if a new descriptor is consistent with the user's existing captures.
 * @param {Float32Array} descriptor - The new face descriptor.
 * @returns {boolean} True if the descriptor is consistent.
 */
function isConsistentWithCurrentUser(descriptor) {
    if (state.registration.currentUserDescriptors.length === 0) return true;
    return state.registration.currentUserDescriptors.every(refDesc =>
        faceapi.euclideanDistance(descriptor, refDesc) < config.feedback.consistencyThreshold
    );
}

/**
 * Checks if a descriptor is a duplicate of any already registered user.
 * @param {Float32Array} descriptor - The face descriptor to check.
 * @returns {boolean} True if the descriptor is a duplicate.
 */
function isDuplicateAcrossUsers(descriptor) {
    if (!descriptor || state.verification.flatRegisteredDescriptors.length === 0) return false;
    return state.verification.flatRegisteredDescriptors.some(ref =>
        faceapi.euclideanDistance(descriptor, ref) < config.feedback.duplicateThreshold
    );
}

/**
 * Checks if the quality of a detected face is high enough for registration.
 * @param {object} detection - The face detection result.
 * @returns {boolean} True if the quality is sufficient.
 */
function isCaptureQualityHigh(detection) {
    if (!detection || !detection.detection) return false;
    const score = detection.detection._score || 0;
    const box = detection.alignedRect && detection.alignedRect._box;
    if (!box) return false;

    const video = document.getElementById(config.video.id);
    const minArea = (video.videoWidth * video.videoHeight) * config.quality.minArea;
    const area = box._width * box._height;

    return score >= config.quality.minConfidence && area >= minArea;
}

// --- Drawing Functions ---

/**
 * Draws the detected face image and confidence score to a canvas.
 * @param {Array} detections - The detection data from the worker.
 */
function drawImageDataToCanvas(detections) {
    const canvas = document.getElementById(config.video.output);
    if (!canvas) return;
    const context = canvas.getContext("2d");

    if (!Array.isArray(detections) || detections.length < 2) return;
    const results = detections[0];
    const images = detections[1];
    if (!Array.isArray(images) || images.length === 0) return;

    const imageData = images[0];
    let confidence = 0;
    if (Array.isArray(results) && results.length > 0 && results[0] && results[0].detection) {
        confidence = (results[0].detection._score || 0) * 100;
    }

    canvas.width = imageData.width;
    canvas.height = imageData.height;
    context.putImageData(imageData, 0, 0);

    context.font = '20px Arial';
    context.fillStyle = 'white';
    context.fillText(`Confidence: ${confidence.toFixed(2)}%`, 10, 30);
}

/**
 * Draws landmarks and bounding boxes for all detected faces.
 * @param {Array} detectionsArray - An array of face detection results.
 */
function drawAllFaces(detectionsArray) {
    if (!Array.isArray(detectionsArray) || detectionsArray.length === 0) {
        clearAllCanvases();
        return;
    }
    // Implement drawAllLandmarks and drawAllBoxesAndLabels if multi-face is needed
}

// --- Core Logic ---

/**
 * Handles the main face registration logic.
 * @param {Float32Array} descriptor - The new face descriptor to register.
 */
function faceApiRegister(descriptor) {
    if (!descriptor || state.registration.isCompleted) return;

    if (state.registration.currentUserDescriptors.length === 0) {
        state.registration.currentUserId = document.getElementById(config.ui.userIdInput).value.trim();
        state.registration.currentUserName = document.getElementById(config.ui.userNameInput).value.trim();
    }

    let accept = false;
    if (state.registration.currentUserDescriptors.length === 0) {
        accept = true;
    } else {
        const distances = state.registration.currentUserDescriptors.map(d => faceapi.euclideanDistance(descriptor, d));
        const minDist = Math.min(...distances);
        state.registration.attemptDistances.push(minDist);

        if (minDist > config.registration.similarityThreshold) {
            accept = true;
        }
    }

    if (accept) {
        state.registration.currentUserDescriptors.push(descriptor);
        if (state.registration.lastFaceImageData) {
            const cv = document.createElement('canvas');
            cv.width = state.registration.lastFaceImageData.width;
            cv.height = state.registration.lastFaceImageData.height;
            cv.getContext('2d').putImageData(state.registration.lastFaceImageData, 0, 0);
            const url = cv.toDataURL();
            state.registration.capturedFrames.push(url);
            addCapturePreview(url);
        }
        updateRegistrationProgress();
        saveProgress();

        if (state.registration.currentUserDescriptors.length >= config.registration.maxCaptures) {
            alert(`Registration completed for user: ${state.registration.currentUserName} (${state.registration.currentUserId})`);
            state.registration.isCompleted = true;
            stopCamera();
            clearAllCanvases();
            // Finalize UI, e.g., show download button
        }
    }
}

/**
 * Handles the main face verification logic.
 * @param {Float32Array} descriptor - The descriptor of the detected face.
 * @param {ImageData} imageData - The image data of the detected face.
 */
async function faceApiVerify(descriptor, imageData) {
    if (!descriptor || state.verification.isCompleted) return;

    for (let i = 0; i < state.verification.flatRegisteredDescriptors.length; i++) {
        const refDesc = state.verification.flatRegisteredDescriptors[i];
        const distance = faceapi.euclideanDistance(descriptor, refDesc);

        if (distance < config.verification.distanceThreshold) {
            const userMeta = state.verification.flatRegisteredUserMeta[i];
            const uid = userMeta.id;

            if (uid && !state.verification.verifiedUserIds.has(uid)) {
                state.verification.verifiedUserIds.add(uid);
                state.verification.verifiedCount++;

                updateUserVerificationStatus(uid);
                updateVerificationProgress();
                showVerifyToast(`${userMeta.name} (${userMeta.id}) detected`);

                if (state.verification.verifiedCount >= state.verification.totalFaces) {
                    stopCamera();
                    state.verification.isCompleted = true;
                    clearAllCanvases();
                }
            }
            break; // Found a match, stop searching
        }
    }
}

// --- Worker Message Handlers ---

export function handleModelsLoaded() {
    console.log('Face detection models loaded by worker.');
    state.isFaceApiReady = true;
    if (typeof state.resolveFaceApiReady === 'function') {
        state.resolveFaceApiReady();
    }
    toggleOverlay('loadingOverlay', false);
    // Perform warmup
}

export function handleWarmupResult() {
    console.log('Warmup completed by worker.');
}

export function handleDetectionResult(data) {
    const dets = data.detections[0];
    const imageDataForFrame = data.detections[1] && data.detections[1][0];
    state.registration.lastFaceImageData = imageDataForFrame;

    drawImageDataToCanvas(data.detections);
    drawAllFaces(Array.isArray(dets) ? dets : []);

    if (Array.isArray(dets) && dets.length > 0) {
        if (state.faceapiAction === "verify") {
            dets.forEach(d => faceApiVerify(d.descriptor, imageDataForFrame));
        } else if (state.faceapiAction === "register") {
            if (dets.length !== 1) {
                showMessage('error', 'Multiple faces detected. Please ensure only your face is visible.');
            } else {
                const descriptor = dets[0].descriptor;
                if (!isCaptureQualityHigh(dets[0])) {
                    showMessage('error', 'Low-quality capture. Ensure good lighting and face the camera.');
                } else if (isDuplicateAcrossUsers(descriptor)) {
                    showMessage('error', 'This face appears already registered.');
                } else if (!isConsistentWithCurrentUser(descriptor)) {
                    showMessage('error', 'Face angle changed too much. Please turn your head slowly.');
                } else {
                    showMessage('success', 'Face capture accepted.');
                    faceApiRegister(descriptor);
                }
            }
        }
    } else {
        showMessage("error", "No face detected. Make sure your face is fully visible and well lit.");
    }

    state.isDetectingFrame = false;
    if (typeof state.videoDetectionStep === 'function') {
        requestAnimationFrame(state.videoDetectionStep);
    }
}

/**
 * Continuously captures video frames and sends them to the worker for detection.
 */
export function video_face_detection() {
    const video = document.getElementById(config.video.id);
    const canvas = document.getElementById(config.canvas.id);
    if (!video || !canvas) return;

    const context = canvas.getContext("2d");
    canvas.willReadFrequently = true;
    context.willReadFrequently = true;

    const step = () => {
        if (video.paused || video.ended || state.isDetectingFrame) {
            requestAnimationFrame(step);
            return;
        }

        if (canvas.width === 0 || canvas.height === 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            if (canvas.width === 0 || canvas.height === 0) {
                requestAnimationFrame(step);
                return;
            }
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

        state.isDetectingFrame = true;
        if (state.worker) {
            state.worker.postMessage({
                type: 'DETECT_FACES',
                imageData,
                width: canvas.width,
                height: canvas.height,
                face_detector_options: state.faceDetectorOptions,
            });
        }
    };

    state.videoDetectionStep = step;
    requestAnimationFrame(step);
}

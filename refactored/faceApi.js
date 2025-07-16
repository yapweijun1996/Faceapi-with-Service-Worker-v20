/**
 * faceApi.js (Refactored Registration Flow)
 * -----------------------------------------
 * Clean, robust, and user-friendly face registration logic for face-api.js.
 * Handles user info, face capture, progress, and completion with clear feedback.
 */

import * as faceapi from '../js/face-api.js';
import { config } from './config.js';
import { state } from './state.js';
import {
    showMessage,
    updateRegistrationProgress,
    addCapturePreview,
    clearAllCanvases,
    clearCapturePreviews,
    removeLastCapturePreview,
} from './ui.js';
import { stopCamera } from './camera.js';
import { saveProgress, clearProgress } from './db.js';

// --- Helper Functions ---

function euclideanDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

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

function drawAllFaces(detectionsArray) {
    if (!Array.isArray(detectionsArray) || detectionsArray.length === 0) {
        clearAllCanvases();
        return;
    }
    const canvas = document.getElementById(config.canvas.overlay);
    if (!canvas) return;
    canvas.style.display = 'block';
    const video = document.getElementById(config.video.id);
    if (!video) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    detectionsArray.forEach((det) => {
        // Draw bounding box
        if (config.features.showFaceBox && det.alignedRect && det.alignedRect._box) {
            const box = det.alignedRect._box;
            ctx.save();
            ctx.strokeStyle = 'lime';
            ctx.lineWidth = 2;
            ctx.strokeRect(box._x, box._y, box._width, box._height);
            ctx.restore();
        }
        // Draw landmarks
        if (config.features.showLandmarks && det.landmarks && det.landmarks._positions) {
            ctx.save();
            ctx.fillStyle = 'red';
            det.landmarks._positions.forEach(pt => {
                ctx.beginPath();
                ctx.arc(pt._x, pt._y, 2, 0, 2 * Math.PI);
                ctx.fill();
            });
            ctx.restore();
        }
    });
}

// --- Refactored Registration Logic ---

/**
 * Handles the main face registration logic (refactored).
 * @param {Float32Array} descriptor - The new face descriptor to register.
 */
function faceApiRegister(descriptor) {
    if (!descriptor || state.registration.isCompleted) return;

    // Step 1: Set user info on first capture
    if (state.registration.currentUserDescriptors.length === 0) {
        state.registration.currentUserId = document.getElementById(config.ui.userIdInput).value.trim();
        state.registration.currentUserName = document.getElementById(config.ui.userNameInput).value.trim();
        if (!state.registration.currentUserId || !state.registration.currentUserName) {
            showMessage('error', 'Please enter both User ID and Name.');
            return;
        }
    }

    // Step 2: Check for duplicate or inconsistent captures
    const descriptors = state.registration.currentUserDescriptors;
    if (descriptors.some(d => euclideanDistance(descriptor, d) < config.registration.similarityThreshold)) {
        showMessage('error', 'Duplicate capture detected. Please change your pose slightly.');
        return;
    }

    // Step 3: Accept and store the descriptor
    descriptors.push(descriptor);
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

    // Step 4: Check for completion
    if (descriptors.length >= config.registration.maxCaptures) {
        showMessage('success', `Registration completed for ${state.registration.currentUserName} (${state.registration.currentUserId})`);
        state.registration.isCompleted = true;
        stopCamera();
        clearAllCanvases();
        // Show download button or next step
    }
}

/**
 * Handles detection results for registration and verification (refactored).
 * @param {object} data - Detection result from worker.
 */
export function handleDetectionResult(data) {
    const dets = data.detections[0];
    const imageDataForFrame = data.detections[1] && data.detections[1][0];

    // Registration flow
    if (state.faceapiAction === "register") {
        state.registration.lastFaceImageData = imageDataForFrame;
        drawAllFaces(Array.isArray(dets) ? dets : []);
        if (Array.isArray(dets) && dets.length > 0) {
            if (dets.length !== 1) {
                showMessage('error', 'Multiple faces detected. Please ensure only your face is visible.');
            } else {
                const descriptor = dets[0].descriptor;
                if (!isCaptureQualityHigh(dets[0])) {
                    showMessage('error', 'Low-quality capture. Ensure good lighting and face the camera.');
                } else {
                    showMessage('success', 'Face capture accepted.');
                    faceApiRegister(descriptor);
                }
            }
        } else {
            showMessage("error", "No face detected. Make sure your face is fully visible and well lit.");
        }
    }

    // Verification flow
    if (state.faceapiAction === "verify") {
        drawAllFaces(Array.isArray(dets) ? dets : []);
        if (Array.isArray(dets) && dets.length > 0) {
            // Only consider the first detected face for verification
            const descriptor = dets[0].descriptor;
            if (!isCaptureQualityHigh(dets[0])) {
                showMessage('error', 'Low-quality capture. Ensure good lighting and face the camera.');
            } else {
                faceApiVerify(descriptor);
            }
        } else {
            showMessage("error", "No face detected. Make sure your face is fully visible and well lit.");
        }
    }

    state.isDetectingFrame = false;
    if (typeof state.videoDetectionStep === 'function') {
        requestAnimationFrame(state.videoDetectionStep);
    }
}

/**
 * Handles the main face verification logic (refactored).
 * @param {Float32Array} descriptor - The descriptor of the detected face.
 */
function faceApiVerify(descriptor) {
    if (!descriptor || state.verification.isCompleted) return;

    let matchedUserIndex = -1;
    let minDistance = Infinity;

    // Find the closest match among all registered descriptors
    for (let i = 0; i < state.verification.flatRegisteredDescriptors.length; i++) {
        const refDesc = state.verification.flatRegisteredDescriptors[i];
        const distance = euclideanDistance(descriptor, refDesc);
        if (distance < minDistance) {
            minDistance = distance;
            matchedUserIndex = i;
        }
    }

    // Check if the closest match is within the threshold
    if (
        matchedUserIndex !== -1 &&
        minDistance < config.verification.distanceThreshold
    ) {
        const userMeta = state.verification.flatRegisteredUserMeta[matchedUserIndex];
        const uid = userMeta.id;

        if (uid && !state.verification.verifiedUserIds.has(uid)) {
            state.verification.verifiedUserIds.add(uid);
            state.verification.verifiedCount++;

            // UI feedback and progress
            import('./ui.js').then(ui => {
                ui.updateUserVerificationStatus(uid);
                ui.updateVerificationProgress();
                ui.showVerifyToast(`${userMeta.name} (${userMeta.id}) verified`);
            });

            // Complete verification if all users are verified
            if (state.verification.verifiedCount >= state.verification.totalFaces) {
                stopCamera();
                state.verification.isCompleted = true;
                clearAllCanvases();
                // Show verification complete overlay
                const overlay = document.getElementById('verifyCompleteOverlay');
                if (overlay) overlay.style.display = 'block';
            }
        }
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

/**
 * Handles the event when face-api.js models are loaded by the worker.
 */
export function handleModelsLoaded() {
    console.log('Face detection models loaded by worker.');
    state.isFaceApiReady = true;
    if (typeof state.resolveFaceApiReady === 'function') {
        state.resolveFaceApiReady();
    }
    // Hide loading overlay if present
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

/**
 * Handles the event when the worker completes warmup.
 */
export function handleWarmupResult() {
    console.log('Warmup completed by worker.');
}

// --- Registration Controls ---

export function restartRegistration() {
    state.registration.currentUserDescriptors = [];
    state.registration.capturedFrames = [];
    state.registration.isCompleted = false;
    clearCapturePreviews();
    updateRegistrationProgress();
    clearProgress();
    showMessage('success', 'Registration restarted.');
}

export function cancelRegistration() {
    stopCamera();
    window.location.href = 'index.html';
}

export function retakeLastCapture() {
    if (state.registration.currentUserDescriptors.length > 0) {
        state.registration.currentUserDescriptors.pop();
        state.registration.capturedFrames.pop();
        removeLastCapturePreview();
        updateRegistrationProgress();
        saveProgress();
        showMessage('success', 'Last capture removed.');
    }
}

export function downloadRegistrationData() {
    if (state.registration.currentUserDescriptors.length < config.registration.maxCaptures) {
        alert('Please complete the registration before downloading.');
        return;
    }
    const data = {
        id: state.registration.currentUserId,
        name: state.registration.currentUserName,
        descriptors: state.registration.currentUserDescriptors.map(d => Array.from(d)),
        capturedFrames: state.registration.capturedFrames,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.registration.currentUserId}_${state.registration.currentUserName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

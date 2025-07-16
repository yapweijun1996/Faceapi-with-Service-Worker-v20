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
    console.log(`[drawAllFaces] Drawing ${detectionsArray.length} detection(s).`);
    const canvas = document.getElementById(config.canvas.overlay);
    const video = document.getElementById(config.video.id);
    if (!canvas || !video) return;

    // Ensure video metadata is loaded
    if (!video.videoWidth || !video.videoHeight) return;

    // Match canvas display size to video element's display size
    const displayWidth = video.clientWidth;
    const displayHeight = video.clientHeight;
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
    }
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate the scaling factor and offset to handle "letterboxing"
    // This ensures the overlay aligns with the video content, respecting aspect ratio
    const videoAspectRatio = video.videoWidth / video.videoHeight;
    const canvasAspectRatio = canvas.width / canvas.height;
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;

    if (videoAspectRatio > canvasAspectRatio) {
        // Video is wider than canvas, so it's letterboxed vertically
        scale = canvas.width / video.videoWidth;
        offsetY = (canvas.height - video.videoHeight * scale) / 2;
    } else {
        // Video is taller than canvas, so it's letterboxed horizontally
        scale = canvas.height / video.videoHeight;
        offsetX = (canvas.width - video.videoWidth * scale) / 2;
    }

    detectionsArray.forEach((det) => {
        // Draw bounding box, scaled and offset correctly
        if (config.features.showFaceBox && det.alignedRect && det.alignedRect._box) {
            const box = det.alignedRect._box;
            ctx.save();
            ctx.strokeStyle = 'lime';
            ctx.lineWidth = 2;
            ctx.strokeRect(
                box._x * scale + offsetX,
                box._y * scale + offsetY,
                box._width * scale,
                box._height * scale
            );
            ctx.restore();
        }
        // Draw landmarks, scaled and offset correctly
        if (config.features.showLandmarks && det.landmarks && det.landmarks._positions) {
            ctx.save();
            ctx.fillStyle = 'red';
            det.landmarks._positions.forEach(pt => {
                ctx.beginPath();
                ctx.arc(
                    pt._x * scale + offsetX,
                    pt._y * scale + offsetY,
                    2, 0, 2 * Math.PI
                );
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
    const dets = (data && data.detections && data.detections[0]) ? data.detections[0] : [];
    const imageDataForFrame = (data && data.detections && data.detections[1]) ? data.detections[1][0] : null;

    // Always draw the detections we received for this frame.
    drawAllFaces(dets);

    // Registration flow
    if (state.faceapiAction === "register") {
        state.registration.lastFaceImageData = imageDataForFrame;
        console.log(`[Register Flow] Received ${dets.length} detections.`);

        if (dets.length === 0) {
            showMessage("error", "No face detected. Make sure your face is fully visible and well lit.");
        } else if (dets.length > 1) {
            showMessage('error', 'Multiple faces detected. Please ensure only your face is visible.');
        } else {
            // Exactly one face detected, check its quality.
            const detection = dets[0];
            if (!detection.detection || !detection.alignedRect) {
                console.error("Invalid detection object received:", detection);
                return;
            }
            const quality = {
                score: detection.detection._score,
                area: detection.alignedRect._box._width * detection.alignedRect._box._height,
            };
            console.log(`Detection quality: score=${quality.score.toFixed(3)}, area=${quality.area.toFixed(0)}`);

            if (isCaptureQualityHigh(detection)) {
                showMessage('success', 'Face capture accepted.');
                faceApiRegister(detection.descriptor);
            } else {
                showMessage('error', 'Low-quality capture. Move closer or improve lighting.');
            }
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

/* --- Registration Controls --- */

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

/* --- Verification Controls --- */

export function restartVerification() {
    state.verification.verifiedUserIds.clear();
    state.verification.verifiedCount = 0;
    state.verification.isCompleted = false;
    // Optionally reset UI list and progress
    import('./ui.js').then(ui => {
        ui.resetVerificationList();
        ui.updateVerificationProgress();
    });
    showMessage('success', 'Verification restarted.');
}

export function cancelVerification() {
    stopCamera();
    window.location.href = 'index.html';
}

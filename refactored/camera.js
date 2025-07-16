/**
 * camera.js
 * ---------
 * This module manages all interactions with the device's camera. It handles
 * requesting permissions, starting the video stream, and stopping it cleanly.
 * Encapsulating camera logic simplifies its use across the application.
 */

import { config } from './config.js';
import { showMessage } from './ui.js';
import { state } from './state.js';

/**
 * Starts the camera and streams the video to the designated video element.
 * @returns {Promise<void>} A promise that resolves when the camera is playing.
 */
export async function startCamera() {
    const video = document.getElementById(config.video.id);
    if (!video) {
        console.error("Video element not found");
        return;
    }

    // Ensure parent container is visible (for verification step)
    const verifyStep = document.getElementById('verifyStep');
    if (verifyStep) {
        verifyStep.style.display = 'block';
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('getUserMedia not supported');
        showMessage('error', 'Camera not supported in this browser.');
        return;
    }

    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('autoplay', '');
    video.style.display = 'block';
    console.log('Camera started, video element set to display:block');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            video.play().catch(e => console.warn('video.play() failed:', e));
        };

        video.onerror = e => console.error('Video error event:', e);

    } catch (err) {
        console.error('Error accessing webcam:', err);
        showMessage('error', `Unable to access camera: ${err.message}`);
    }
}

/**
 * Stops the camera stream and resets the video element.
 */
export function stopCamera() {
    const video = document.getElementById(config.video.id);
    if (video && video.srcObject) {
        const stream = video.srcObject;
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
        video.pause();
    }
    state.isDetectingFrame = false;
    state.videoDetectionStep = null;
}

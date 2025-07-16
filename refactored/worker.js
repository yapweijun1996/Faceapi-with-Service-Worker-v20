/**
 * worker.js
 * ---------
 * This module manages the background workers (Service Worker and Web Worker)
 * responsible for running the face detection models. It handles worker
 * initialization, message passing, and the fallback strategy for browsers
 * that do not support Service Workers.
 */

import { config } from './config.js';
import { state } from './state.js';
import { toggleOverlay, showMessage } from './ui.js';
import { handleDetectionResult, handleModelsLoaded, handleWarmupResult } from './faceApi.js';

/**
 * Handles incoming messages from the worker.
 * @param {MessageEvent} event - The message event from the worker.
 */
function handleWorkerMessage(event) {
    console.log('Received message from worker:', event.data.type);
    switch (event.data.type) {
        case 'MODELS_LOADED':
            handleModelsLoaded();
            break;
        case 'DETECTION_RESULT':
            handleDetectionResult(event.data.data);
            break;
        case 'WARMUP_RESULT':
            handleWarmupResult();
            break;
        default:
            console.log('Unknown message type from worker:', event.data.type);
    }
}

/**
 * Registers the Service Worker and waits for it to become active.
 * @returns {Promise<ServiceWorker>} The active Service Worker instance.
 */
async function registerServiceWorker() {
    const swScope = './js/';
    let registration = await navigator.serviceWorker.getRegistration(swScope);

    if (!registration || !registration.active || !registration.active.scriptURL.endsWith(config.workers.serviceWorker)) {
        console.log('Registering new service worker...');
        try {
            registration = await navigator.serviceWorker.register(config.workers.serviceWorkerPath, { scope: swScope });
        } catch (err) {
            console.error('Service worker registration failed:', err);
            throw err;
        }
    }

    if (!registration.active) {
        console.log('Waiting for service worker to activate...');
        await new Promise(resolve => {
            const installingWorker = registration.installing || registration.waiting;
            if (!installingWorker || installingWorker.state === 'activated') {
                return resolve();
            }
            installingWorker.addEventListener('statechange', (evt) => {
                if (evt.target.state === 'activated') {
                    resolve();
                }
            });
        });
    }

    return registration.active;
}

/**
 * Initializes the Service Worker, sets up event listeners, and loads the models.
 */
async function initServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        throw new Error('Service workers are not supported in this browser.');
    }

    console.log("Registering service worker...");
    state.worker = await registerServiceWorker();

    console.log("Adding event listeners...");
    navigator.serviceWorker.addEventListener('message', handleWorkerMessage);

    await new Promise(resolve => setTimeout(resolve, 500)); // Delay to ensure worker is ready

    console.log("Loading models via Service Worker...");
    state.worker.postMessage({ type: 'LOAD_MODELS' });
}

/**
 * Initializes the Web Worker as a fallback.
 */
async function initWebWorker() {
    console.log("Falling back to Web Worker.");
    if (!window.Worker) {
        console.error("Web Workers are not supported in this browser.");
        toggleOverlay('loadingOverlay', false);
        showMessage('error', 'Face detection is not supported on this browser.');
        return;
    }

    state.worker = new Worker(config.workers.webWorkerPath);
    state.worker.onmessage = handleWorkerMessage;
    state.worker.onerror = (error) => {
        console.error("Web Worker error:", error);
        toggleOverlay('loadingOverlay', false);
        showMessage('error', 'An error occurred with the Web Worker.');
    };

    console.log("Loading models via Web Worker...");
    state.worker.postMessage({ type: 'LOAD_MODELS' });
}

/**
 * Initializes the appropriate worker (Service Worker or Web Worker fallback).
 */
export async function initializeWorker() {
    const swSupported = 'serviceWorker' in navigator;
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined';

    if (swSupported && offscreenSupported) {
        try {
            await initServiceWorker();
        } catch (e) {
            console.warn("Service Worker initialization failed, falling back to Web Worker", e);
            await initWebWorker();
        }
    } else {
        console.warn("Service Worker not supported, using Web Worker fallback.");
        await initWebWorker();
    }
}

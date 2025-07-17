/**
 * modelLoaderWorker.js
 * --------------------
 * A dedicated Web Worker for loading face-api.js models in the background.
 * This prevents the main UI thread from freezing, which is crucial for
 * environments like iOS where Service Workers with OffscreenCanvas are not
 * supported.
 *
 * How it works:
 *  1. Imports the main face-api.js library.
 *  2. Listens for a 'LOAD_MODELS' message from the main thread.
 *  3. Loads the required neural network models.
 *  4. Sends a 'MODELS_LOADED' message back to the main thread upon completion.
 */

// Import the patch to polyfill the browser environment
importScripts('faceEnvWorkerPatch.js');
// Import the face-api.js library. The path is relative to this worker script.
importScripts('face-api.min.js');

self.onmessage = async (event) => {
  if (event.data.type === 'LOAD_MODELS') {
    try {
      console.log('Worker: Received request to load models.');
      
      // Load all the required models from the /models directory.
      await faceapi.nets.tinyFaceDetector.loadFromUri('../models');
      await faceapi.nets.faceLandmark68Net.loadFromUri('../models');
      await faceapi.nets.faceRecognitionNet.loadFromUri('../models');
      
      console.log('Worker: Models loaded successfully.');
      
      // Notify the main thread that loading is complete.
      self.postMessage({ type: 'MODELS_LOADED' });
      
    } catch (error) {
      console.error('Worker: Error loading models.', error);
      // Optionally, send an error message back to the main thread
      self.postMessage({ type: 'LOAD_ERROR', error: error.message });
    }
  }
};

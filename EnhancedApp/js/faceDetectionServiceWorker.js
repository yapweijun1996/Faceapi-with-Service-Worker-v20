// faceDetectionServiceWorker.js
importScripts('faceEnvWorkerPatch.js');
importScripts('face-api.min.js');

let isModelLoaded = false;

// Helper to post messages to all clients
function postToAllClients(message) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
    if (!clients || clients.length === 0) {
      console.log("No clients to post message to.");
      return;
    }
    clients.forEach(client => {
      client.postMessage(message);
    });
  });
}

const FaceDetectorOptionsDefault = new faceapi.TinyFaceDetectorOptions({
  inputSize: 128,
  scoreThreshold: 0.1,
  maxDetectedFaces: 1,
});
let face_for_loading_options = FaceDetectorOptionsDefault;

async function loadModels() {
  const post = (message) => postToAllClients({ type: 'MODEL_LOADING_PROGRESS', message });

  post('Loading face detector...');
  await faceapi.nets.tinyFaceDetector.loadFromUri('../models');
  post('Loading face landmarks...');
  await faceapi.nets.faceLandmark68Net.loadFromUri('../models');
  post('Loading face recognition...');
  await faceapi.nets.faceRecognitionNet.loadFromUri('../models');

  isModelLoaded = true;
  postToAllClients({ type: 'MODELS_LOADED' });
}

async function checkModelsLoaded() {
  if (isModelLoaded) {
    console.log("checkModelsLoaded : Models are loaded.");
    postToAllClients({ type: 'MODELS_LOADED' });
  } else {
    console.log("checkModelsLoaded : Models are not loaded yet.");
    await loadModels();
  }
}

async function detectFaces(imageData, width, height) {
  if (!isModelLoaded) {
    console.log('Models not loaded yet');
    return;
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);

  const detections = await faceapi
    .detectAllFaces(canvas, face_for_loading_options)
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (detections.length > 0) {
    const landmarks = detections[0].landmarks;

    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const centerX = (leftEye[0].x + rightEye[0].x) / 2;
    const centerY = (leftEye[0].y + rightEye[0].y) / 2;

    const regionsToExtract = [
      new faceapi.Rect(centerX - 200, centerY - 100, 450, 450)
    ];

    const faceCanvas = await faceapi.extractFaces(canvas, regionsToExtract);

    const imageDatas = faceCanvas.map(face => {
      const faceCtx = face.getContext('2d');
      return faceCtx.getImageData(0, 0, face.width, face.height);
    });

    return [detections, imageDatas];
  } else {
    console.log('No face detected');
    return [null, []];
  }
}

self.addEventListener('message', async function(event) {
  const { type, imageData, width, height, face_detector_options } = event.data;
  if (typeof face_detector_options === "undefined" || face_detector_options === "undefined") {
    face_for_loading_options = FaceDetectorOptionsDefault;
  } else {
    face_for_loading_options = new faceapi.TinyFaceDetectorOptions(face_detector_options);
  }

  let detections;
  switch (type) {
    case 'LOAD_MODELS':
      await checkModelsLoaded();
      break;
    case 'DETECT_FACES':
      detections = await detectFaces(imageData, width, height);
      postToAllClients({
        type: 'DETECTION_RESULT',
        data: {
          detections: detections,
          displaySize: { width, height }
        }
      });
      break;
    case 'WARMUP_FACES':
      // Create a dummy canvas for warmup
      const warmupCanvas = new OffscreenCanvas(1, 1);
      await faceapi.detectAllFaces(warmupCanvas, face_for_loading_options);
      postToAllClients({ type: 'WARMUP_RESULT' });
      break;
    case 'WARMUP_WITH_IMAGE':
      try {
        console.log('Worker: Starting warmup with static image...');
        const response = await fetch('../models/face_for_loading.png');
        if (!response.ok) {
          throw new Error(`Failed to fetch warmup image: ${response.statusText}`);
        }
        const imageBlob = await response.blob();
        const imageBitmap = await createImageBitmap(imageBlob);

        // Use the image bitmap to perform a detection
        const warmupCanvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        const ctx = warmupCanvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);
        
        await faceapi.detectAllFaces(warmupCanvas, face_for_loading_options);
        console.log('Worker: Warmup detection successful.');
        postToAllClients({ type: 'WARMUP_RESULT' });
      } catch (error) {
        console.error('Worker: Warmup with image failed:', error);
        // Optionally, notify the client of the failure
        postToAllClients({ type: 'WARMUP_FAILED', error: error.message });
      }
      break;
    default:
      console.log('Unknown message type:', type);
  }
});

self.addEventListener('messageerror', function(event) {
  console.error('Service Worker message error: ', event);
});

// Ensure the worker activates as soon as it finishes installing and takes control
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

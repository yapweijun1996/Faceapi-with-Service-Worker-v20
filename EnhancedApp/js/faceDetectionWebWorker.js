/**
 * faceDetectionWebWorker.js
 * -------------------------
 * A dedicated Web Worker for loading face-api.js models and performing face detection
 * in the background, mirroring faceDetectionServiceWorker.js logic.
 */

importScripts('faceEnvWorkerPatch.js');
importScripts('face-api.min.js');

let isModelLoaded = false;

const FaceDetectorOptionsDefault = new faceapi.TinyFaceDetectorOptions({
  inputSize: 128,
  scoreThreshold: 0.1,
  maxDetectedFaces: 1,
});
let faceDetectorOptions = FaceDetectorOptionsDefault;

async function loadModels() {
  await faceapi.nets.tinyFaceDetector.loadFromUri('../models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('../models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('../models');
  isModelLoaded = true;
  self.postMessage({ type: 'MODELS_LOADED' });
}

async function detectFaces(imageData, width, height) {
  if (!isModelLoaded) {
    console.warn('WebWorker: Models not loaded yet');
    return [null, []];
  }

  // Guard against invalid dimensions
  if (!width || !height) {
    console.error('WebWorker: Invalid dimensions for OffscreenCanvas');
    return [null, []];
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);

  const detections = await faceapi
    .detectAllFaces(canvas, faceDetectorOptions)
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
    const faceCanvases = await faceapi.extractFaces(canvas, regionsToExtract);
    const imageDatas = faceCanvases.map(faceCanvas => {
      const faceCtx = faceCanvas.getContext('2d');
      return faceCtx.getImageData(0, 0, faceCanvas.width, faceCanvas.height);
    });
    return [detections, imageDatas];
  } else {
    return [[], []];
  }
}

self.onmessage = async (event) => {
  const { type, imageData, width, height, face_detector_options } = event.data;
  if (typeof face_detector_options !== 'undefined') {
    faceDetectorOptions = new faceapi.TinyFaceDetectorOptions(face_detector_options);
  } else {
    faceDetectorOptions = FaceDetectorOptionsDefault;
  }

  switch (type) {
    case 'LOAD_MODELS':
      await loadModels();
      break;
    case 'DETECT_FACES': {
      const result = await detectFaces(imageData, width, height);
      self.postMessage({
        type: 'DETECTION_RESULT',
        data: { detections: result, displaySize: { width, height } }
      });
      break;
    }
    case 'WARMUP_FACES': {
      const result = await detectFaces(imageData, width, height);
      self.postMessage({
        type: 'WARMUP_RESULT',
        data: { detections: result, displaySize: { width, height } }
      });
      break;
    }
    case 'PING':
      self.postMessage({ type: 'PONG' });
      break;
    default:
      console.warn('WebWorker: Unknown message type:', type);
  }
};

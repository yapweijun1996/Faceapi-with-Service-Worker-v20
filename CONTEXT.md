# Project Context: FaceAPI with Service Worker

This document provides the necessary context for AI assistants to effectively contribute to this project.

## 1. High-Level Goal

The primary objective of this project is to... 
*(Please fill in the main goal. e.g., "...build a reliable, performant face verification system that runs efficiently in the browser using a Service Worker.")*

---

## 2. Architecture Overview

This application is structured as follows:

*   **Main Thread (`index.html`, `face_register.html`, `face_verify.html`)**: Handles the user interface and user interactions.
*   **`faceapi_warmup.js`**: Contains the core logic for initializing the face-api models and the Service Worker.
*   **Service Worker (`faceDetectionServiceWorker.js`)**: Performs the heavy-lifting of face detection and recognition in the background to keep the UI responsive.
*   **Web Worker (`faceDetectionWebWorker.js`)**: An alternative offloading mechanism for browsers that may have issues with Service Workers. The current implementation seems to favor the Service Worker.
*   **Models (`/models`)**: Contains the pre-trained models for face-api.js.

---

## 3. Coding Style and Conventions

*   **Language**: JavaScript (ES6+).
*   **Style**: Please adhere to modern JavaScript best practices. Use `async/await` for asynchronous operations.
*   **Documentation**: Add JSDoc comments to new functions to explain their purpose, parameters, and return values.
*   **Dependencies**: The project relies on `face-api.js`. No other external libraries should be added without discussion.

---

## 4. Current Tasks & Priorities

*(Please outline the current development priorities here.)*

*   **Priority 1**: 
*   **Priority 2**: 
*   **Priority 3**: 

---

## 5. How to Get Help

If you (the AI) are stuck, please refer to this document first. If the answer is not here, you can ask for clarification.

# Engineering Guide: Serverless Face Verification System
**Project:** Enhanced Face Registration & Verification System (Serverless)
**Last Updated:** 2025-07-17
**Maintainer:** Wei Jun Yap

---

## 1. Project Goal & Core Principles

This project provides a **privacy-first, serverless face verification system** that runs entirely in the user's browser. All biometric data is processed and stored locally on the client's device, ensuring that sensitive information never leaves their control.

**Core Principles:**
-   **Privacy by Design**: No backend server, no cloud storage. All data remains in the user's browser.
-   **Performance**: A fast, "instant-on" user experience is achieved by pre-loading and pre-warming ML models in a background thread.
-   **Responsiveness**: The UI remains fluid and responsive by offloading heavy ML computations to a separate worker thread.
-   **Cross-Platform Compatibility**: The system is designed to be robust on both desktop and mobile browsers, with fallbacks for platform-specific limitations (e.g., iOS Service Worker behavior).

---

## 2. System Architecture

The application follows a decoupled, multi-threaded architecture to ensure a non-blocking user experience.

**High-Level Diagram:**
```
+----------------------------------+      +---------------------------------+
|         Browser UI Thread        |      |      Background Worker Thread   |
| (index/register/verify.html)     |      | (Service Worker / Web Worker)   |
+----------------------------------+      +---------------------------------+
| - Renders HTML/CSS               |      | - Loads face-api.js models      |
| - Captures video stream          |      | - Performs all ML inference     |
| - Handles user interactions      |      |   (detection, recognition)      |
| - Manages UI state               |      | - Computes mean descriptors     |
+------------------^---------------+      +-----------------^---------------+
                   |                                        |
      (postMessage)| Messages:                              |
                   | - { cmd: 'init', modelsPath: '...' }     |
                   | - { cmd: 'detect', image: ... }          |
                   | - { cmd: 'ping' }                        |
                   |                                        |
                   v                                        v
+------------------+---------------+      +-----------------+---------------+
|         Message Listener         |      |         Message Listener        |
|  (Receives results & updates UI) |      | (Receives commands & executes)  |
+----------------------------------+      +---------------------------------+
                   |                                        |
                   | (postMessage) Results:                 |
                   | - { status: 'ready' }                  |
                   | - { data: descriptors }                |
                   | - { status: 'pong' }                   |
                   +----------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
|                            Browser Storage                               |
|                          (IndexedDB: 'user_db')                          |
+--------------------------------------------------------------------------+
| - Stores user profiles (ID, name)                                        |
| - Stores face descriptors (Float32Array)                                 |
+--------------------------------------------------------------------------+
```

---

## 3. Core Components Explained

### a. Background Worker (Service Worker vs. Web Worker)

To prevent the UI from freezing during intensive ML model loading and inference, all `face-api.js` operations are delegated to a background thread.

-   **Primary Choice: Service Worker (`faceDetectionServiceWorker.js`)**:
    -   **Why?**: It has a lifecycle independent of the main browser window. This means it can continue running even if the user navigates away from the page, making it ideal for pre-warming models and handling background tasks. It is the more modern and powerful choice.
    -   **Limitation**: iOS and some browsers can be aggressive in terminating idle Service Workers to save battery, which required implementing a health check.

-   **Fallback: Web Worker (`faceDetectionWebWorker.js`)**:
    -   **Why?**: It serves as a robust fallback for environments where Service Workers are unsupported or unreliable (e.g., older browsers, private browsing modes, or historically on iOS).
    -   **Limitation**: A Web Worker is tied to the lifecycle of the page that created it. If the user closes the tab, the worker is terminated.

The application automatically detects Service Worker support and falls back to a Web Worker if necessary.

### b. IndexedDB (`user_db`)

-   **Why?**: IndexedDB was chosen as the local storage solution because it is a transactional, object-oriented database perfect for storing structured data like user profiles and the complex `Float32Array` face descriptors. Unlike `localStorage`, it is asynchronous and won't block the main thread.
-   **Structure**:
    -   **Database Name**: `user_db`
    -   **Object Store**: `users`
    -   **Key**: `id` (The user's unique identifier)
    -   **Data**: `{ id, name, descriptors }`

### c. Worker Communication Protocol

Communication between the UI thread and the background worker is handled via `postMessage`. The protocol is defined by a `cmd` field in the message object.

| Command (`cmd`) | Direction | Description                                                                                             |
|-----------------|-----------|---------------------------------------------------------------------------------------------------------|
| `init`          | UI -> Worker | Tells the worker to load the `face-api.js` models from the specified path. The worker responds with `{ status: 'ready' }` on success. |
| `detect`        | UI -> Worker | Sends an `ImageBitmap` to the worker for face detection and recognition. The worker returns the computed descriptors. |
| `ping`          | UI -> Worker | A health check command to ensure the worker is alive and responsive. The worker must reply with `{ status: 'pong' }`. |

---

## 4. Detailed Data & Logic Flow

### a. User Registration Flow

1.  **Page Load (`index.html`)**: The main page immediately calls `initFaceApi()`, which starts the Service/Web Worker and sends the `init` command to begin pre-warming the ML models.
2.  **User Input (`face_register.html`)**: The user provides their ID and Name.
3.  **Start Capture**: The UI validates the input and starts the camera. For each video frame, it creates an `ImageBitmap` and sends it to the worker via a `{ cmd: 'detect', ... }` message.
4.  **Worker Processing**: The worker receives the image, runs the full `face-api.js` pipeline (`detectSingleFace`, `withFaceLandmarks`, `withFaceDescriptor`), and returns the resulting 128-point `Float32Array` descriptor to the UI thread.
5.  **Descriptor Aggregation**: The UI collects 20 valid descriptors.
6.  **Mean Descriptor Calculation**: Upon collecting 20 descriptors, the UI computes a "mean descriptor" by averaging them. This mean descriptor is more robust for matching than any single capture.
7.  **User Submission**: The user clicks "Submit." The UI creates a user profile object containing the ID, name, and all 21 descriptors (20 raw + 1 mean).
8.  **Database Storage**: The profile object is saved to the `users` object store in IndexedDB.

### b. User Verification Flow (Optimized)

1.  **Load Profiles & Initialize Matcher (`face_verify.html`)**: On page load, the application fetches all user profiles from IndexedDB. It then creates a `faceapi.FaceMatcher` instance, pre-loading it with the mean descriptor of every registered user. This matcher becomes the single source of truth for identifying faces.
2.  **Start Camera**: The camera is activated. For each video frame, an `ImageBitmap` is sent to the worker for processing.
3.  **Optimized Real-time Matching**:
    -   The worker computes the descriptor for the face in the current video frame.
    -   The UI thread receives this new descriptor and uses the pre-loaded `faceMatcher.findBestMatch()` method to efficiently find the most likely user.
    -   If a match is found with a high enough confidence (i.e., the distance is below the threshold and the label is not 'unknown'), the user is marked as verified.
4.  **Dynamic Matcher Updates for Performance**:
    -   **Crucially**, once a user is successfully verified, their descriptors are **removed** from the live `FaceMatcher` instance.
    -   The `FaceMatcher` is rebuilt with only the remaining, unverified users. This ensures that subsequent frames are only compared against people who have not yet been found, drastically reducing computational load as the verification session progresses.
5.  **UI Feedback**: The video overlay is updated in real-time to show a green box (match) with the user's name or a red box (no match).
6.  **Completion**: The process continues until the `FaceMatcher` is empty (all users are verified) or the user manually stops the process.

---

## 5. Operational Details

-   **Worker Health Check**: A `PING`/`PONG` mechanism is used to verify that the background worker is still active, especially when the browser tab regains focus. If no `PONG` is received within a timeout period, the worker is considered terminated and is re-initialized.
-   **Structured Logging**: A global `DEBUG_MODE` flag controls a simple logging utility to provide detailed console output for easier debugging.
-   **Known Issues & Future Work**: (This section will be retained as is).

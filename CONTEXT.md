# Content Engineering Context
**Project:** Enhanced Face Registration & Verification System (Serverless)
**Last Updated:** 2025-07-17
**Maintainer:** Wei Jun Yap

---

## Project Summary (At a Glance)

| Field            | Details                                                                                             |
|------------------|-----------------------------------------------------------------------------------------------------|
| System Name      | Enhanced Face Registration & Verification System (Serverless)                                       |
| Directory        | `EnhancedApp/`                                                                                      |
| Technologies     | HTML5, CSS3, JavaScript (ES6+), IndexedDB, Service Worker, Web Worker, **face-api.js**                |
| Key Models       | `tinyFaceDetector`, `faceLandmark68Net`, `faceRecognitionNet`                                       |
| UX Target        | Mobile & Desktop, pure client-side, privacy-first                                                 |
| Data Storage     | IndexedDB only; no backend server                                                                   |
| Key Flows        | User Registration, Face Verification, Profile Management                                            |
| Deployment       | Static deployment via GitHub Pages                                                                  |

---

## 1. Purpose & Principles

- Deliver a **privacy-respecting face verification system** that runs entirely in the user's browser.
- **No backend, no cloud**—all data is stored locally on the user's device, aligning with GDPR principles.
- Provide a fast, "instant-on" experience by **pre-warming** machine learning models in the background.
- Ensure the user experience and codebase are robust against browser and platform differences, especially on iOS and Android.

---

## 2. Key Design Decisions

- **IndexedDB for Storage**: Chosen for its ability to handle complex data structures like face descriptors and user profiles, and for its persistence across browser sessions.
- **Service Worker with Web Worker Fallback**: Heavy machine learning operations are offloaded to a separate thread to keep the UI responsive. A Web Worker fallback ensures compatibility with iOS and older browsers where Service Worker support may be limited or unreliable.
- **Model Pre-warming**: The application begins loading the face detection models as soon as the main page is opened, significantly reducing latency when the user navigates to the registration or verification pages.
- **Serverless Architecture**: The decision to avoid a central server simplifies deployment, enhances user privacy, and eliminates infrastructure maintenance.

---

## 3. Terminology & Glossary

| Term            | Definition                                                                                             |
|-----------------|--------------------------------------------------------------------------------------------------------|
| **Pre-warming** | The process of preloading `face-api.js` models in a background thread on the initial page load to enable fast feature switching. |
| **Descriptor**  | A numerical vector (a `Float32Array` of 128 numbers) that represents a face, used for recognition and matching. |
| **IndexedDB**   | A browser-native, object-oriented database used for storing structured data locally.                   |
| **Service Worker** | A background script that acts as a network proxy, enabling offline capabilities, background processing, and push notifications. |
| **Web Worker**  | A lightweight background JavaScript thread used as a fallback if the Service Worker fails or is unsupported. |

---

## 4. Content/Data Structures

### User Profile (Stored in IndexedDB `users` object store)
```javascript
{
  id: "A12345",             // User’s unique ID (string)
  name: "Alice Tan",            // Display name (string)
  descriptors: [              // Array of Float32Array face descriptors
    // 20 captured descriptors...
    [...],
    // Plus one computed mean descriptor at the end
    [...],
  ]
}
```

### Page Flows

-   **`index.html`**: The main landing page. It initiates `initFaceApi()` to pre-warm the models in the background.
-   **`face_register.html`**: A guided, mobile-first registration page that captures face descriptors and saves the user profile to IndexedDB.
-   **`face_verify.html`**: Loads all registered users, starts the camera, and performs a real-time matching loop to verify faces.
-   **`profile_management.html`**: Allows users to view, edit (rename), and delete their stored profiles.

---

## 5. User Experience Flow

### Registration

1.  **User Input**: The user enters their ID and name into a form.
2.  **Initiate Capture**: Clicking "Start Registration" validates the input, hides the form, and activates the camera.
3.  **Guided Capture**: The application provides on-screen guidance and automatically captures 20 valid face frames. Real-time quality checks ensure only suitable frames are kept.
4.  **User Confirmation**: After capture is complete, a "Submit" button appears. The profile is only saved to IndexedDB when the user clicks this button.
5.  **Completion & Navigation**: Upon successful submission, the user is redirected to the main page. A "Cancel" button is available throughout the process to discard the registration.

### Verification

1.  Loads all user profiles from IndexedDB and displays their names and IDs.
2.  The user starts the camera, which displays a live video feed with overlay graphics.
3.  Faces detected in the video are compared against all stored descriptors in real-time.
4.  The on-screen overlay indicates the result: a **green** box for a match (displaying the user's name) or a **red** box for no match.
5.  Upon completion or cancellation, the user is redirected to the main page.

---

## 6. Implemented Features

-   **Profile Management**: A dedicated page (`profile_management.html`) allows users to view, edit (rename), and delete their profiles from IndexedDB.
-   **Robust Worker Health Check**: The application uses a `PING`/`PONG` mechanism to check the health of the background worker when the tab becomes visible, automatically re-initializing the Face API if the worker has been terminated by the browser.
-   **Structured Logging**: A logging utility with multiple levels (`info`, `warn`, `error`, `debug`) and a global `DEBUG_MODE` flag is used for cleaner and more effective debugging.

---

## 7. Known Issues & Edge Cases

-   **iOS Worker Unreliability**: iOS may unpredictably terminate or block Service Workers. The Web Worker fallback mitigates this, but it remains a platform constraint.
-   **Storage Limitations**: IndexedDB quotas can be low or non-existent in incognito/private browsing modes.
-   **Data Loss**: If the user clears their browser's local storage, all registered profiles will be permanently lost.
-   **(Fixed)** Worker initialization could hang if the Service Worker failed silently. This was resolved with a more robust `try...catch` block and a reliable fallback to the Web Worker.
-   **(Fixed)** The worker health check could fail due to a timeout. This was resolved by implementing a direct `PING`/`PONG` messaging system between the main thread and the worker.

---

## 8. Future Enhancements

-   Implement a more user-friendly error UI for common browser and camera issues.
-   Add support for different `face-api.js` models to allow users to choose between performance and accuracy.
-   Integrate liveness detection (e.g., blink or head turn checks) to prevent spoofing.
-   Refactor all helper scripts into modern ES Modules for better code organization.
-   Implement multi-user/multi-session handling for shared devices.
-   Add a data export/import feature for profile migration and backup.

---

## 9. Related References

-   [face-api.js GitHub Repository](https://github.com/justadudewhohacks/face-api.js)
-   [MDN: IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)
-   [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
-   [MDN: ResizeObserver API](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)

---

## 10. Open Questions / TODO

-   Should the face descriptor size be standardized across all models?
-   What is the best policy for local data expiry or deletion on shared devices?
-   What is the accessibility and UI plan for visually impaired users?

---
# END

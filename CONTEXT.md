# Content Engineering Context  
**Project:** Enhanced Face Registration & Verification System (Serverless)  
**Last Updated:** 2025-07-17  
**Maintainer:** Wei Jun Yap

---

## Project Summary (At a Glance)

| Field            | Details                                                     |
|------------------|------------------------------------------------------------|
| System Name      | Enhanced Face Registration & Verification System (Serverless) |
| Directory        | EnhancedApp                                                |
| Technologies     | HTML, CSS, JS (ES6+), IndexedDB, Service Worker, Web Worker, face-api.js |
| UX Target        | Mobile & Desktop, pure client-side, privacy-first          |
| Data Storage     | IndexedDB only, no backend                                 |
| Key Flows        | Registration, Verification                                |

---

## 1. Purpose & Principles

- Deliver a **privacy-respecting face verification system** running fully in-browser.
- No backend, no cloud—**all data is local** to user device (GDPR-friendly).
- Fast, “instant-on” experience via **pre-warming** of ML models.
- UX & code are robust against browser/platform differences, esp. iOS/Android.

---

## 2. Key Design Decisions

- **IndexedDB** for storage: Handles images, descriptors, profiles, and persists across reloads.
- **Service Worker + fallback Web Worker:** Heavy ML ops offloaded for UI smoothness; fallback ensures iOS/old browser support.
- **Pre-warming:** Load face detection models as soon as app opens, hiding latency.
- **No central server:** Simplicity, privacy, zero infra maintenance.

---

## 3. Terminology & Glossary

| Term            | Definition                                                                                  |
|-----------------|--------------------------------------------------------------------------------------------|
| Pre-warming     | Preloading face-api.js models in background on first page load for fast feature switching   |
| Descriptor      | Numerical vector representing a face (Float32Array; used for recognition/matching)          |
| IndexedDB       | Browser-native database for complex structured data                                         |
| Service Worker  | Background script for caching, offloading, push, etc.                                      |
| Web Worker      | Lightweight background JS thread (used as fallback if SW fails or unsupported)             |

---

## 4. Content/Data Structures

### User Profile (IndexedDB “userProfiles” store)
```js
{
  userId: "A12345",             // User’s unique ID (string)
  name: "Alice Tan",            // Display name (string)
  descriptors: [Float32Array],  // Array of 128-d face descriptors
  // Optionally: profileImage: "data:image/png;base64,..." (for thumbnails)
}
````

### Page Flows

* **index.html:** Loads on first visit; triggers `initFaceApi()` and shows loading state.
* **face\_register.html:** Step-by-step, guided, mobile-first registration; saves to DB.
* **face\_verify.html:** Loads users, starts camera, real-time matching loop.

### Helper Functions (for modular refactor)

* `initFaceApi()`: Initializes workers, loads ML models.
* `initDB()`: Opens/creates IndexedDB, manages versioning.
* `saveUser(profile)`: Adds new user profile.
* `getAllUsers()`: Returns all profiles.
* `faceapi_register()`: Orchestrates registration and descriptor capture.
* `faceapi_verify()`: Matches current face to stored descriptors.

---

## 5. User Experience Flow

### Registration

1. User enters ID & name → camera activates.
2. App overlays guide, auto-captures 20 valid face frames (quality-checked).
3. Extracts descriptors, stores `{userId, name, descriptors}` to IndexedDB.
4. Shows completion UI + thumbnails for user review.
5. After successful registration, the user is automatically redirected to the main page. The "Cancel" button also provides an exit route back to the main page.

### Verification

1. Loads all user profiles (names/IDs).
2. User starts camera; live video + overlays.
3. Faces detected in video are compared to stored descriptors.
4. Overlay: Green (match, name displayed), Red (no match).
5. Upon completion, the user is redirected to the main page. The "Cancel" button also provides an exit route back to the main page.

### Error/Edge Handling

* SW fallback to WW on failure (esp. on iOS, after 15s timeout).
* Misaligned overlay fixed with ResizeObserver.
* UI never blocks; model load progress is visible.
* All local data persists through browser reloads/installations.
* **Worker Re-initialization**: The Page Visibility API is used to detect when the user returns to the tab. A health check is sent to the worker, and if it fails, the Face API is automatically re-initialized to ensure the application remains responsive.

---

## 6. Content Lifecycle

* **Create:** Through registration flow.
* **Edit:** Users can rename their profiles via the Profile Management page.
* **Delete:** Users can delete their profiles via the Profile Management page.
* **Retention:** Data remains on device until user clears it/browser storage is wiped.
* **Versioning:** IndexedDB schema should be forward-compatible for easy upgrades.

---

## 7. Style, Formatting & UX Conventions

* All text is clear, actionable, and friendly.
* Instructions always visible during registration/verification.
* All user-captured images have privacy banner/warning (if used for production).
* Code is modular; future: convert helpers to ES Modules.
* **Logging**: A structured logging utility is used to provide clear, prefixed messages. It supports multiple levels (`info`, `warn`, `error`, `debug`) and can be controlled via a global `DEBUG_MODE` flag for easier debugging.
* Mobile-first: responsive layouts, large buttons, minimum 48px tap targets.
* Alt text for images/canvas; ARIA attributes as appropriate.

---

## 8. Design Rationale / FAQ

* **Why IndexedDB?**

  * Handles binary (images, descriptors), large datasets, persists across sessions.
* **Why fallback to Web Worker?**

  * Service Worker unreliable on iOS/Safari; fallback ensures universal operation.
* **Why no backend?**

  * Maximum privacy, easy offline/PWA use, less regulatory complexity.

---

## 9. Known Issues & Edge Cases

* iOS sometimes blocks or unloads Service Workers unpredictably.
* IndexedDB quota can be low on incognito/private mode.
* OffscreenCanvas constructor errors (now handled with explicit dims).
* If local storage is cleared, all registered profiles are lost.
* **(Fixed)** Worker initialization could hang indefinitely if the Service Worker failed silently. The logic has been updated with a more robust `try...catch` block to ensure a proper fallback to the Web Worker.
* No liveness/spoofing detection yet (future work).

---

## 10. Future Enhancements

* **(Implemented)** Profile management page (view/edit/delete).
* Friendly error UI for all common browser/camera issues.
* Support for multiple face-api.js models (performance vs. accuracy).
* Liveness/anti-spoofing (blink/head turn).
* Full ES Module refactor for all helpers.
* Multi-user/multi-session handling (if device is shared).
* Data export/import for migration or backup.

---

## 11. Related References

* [face-api.js Docs](https://github.com/justadudewhohacks/face-api.js)
* [MDN: IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)
* [MDN: Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
* [MDN: ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)

---

## 12. Open Questions / TODO

* Standardize face descriptor size for all models?
* Policy for local data expiry/deletion if device is shared?
* Mechanism for backup/export/import if users request it?
* What’s the accessibility/UI plan for visually impaired users?

---

# END

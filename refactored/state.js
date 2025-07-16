/**
 * state.js
 * --------
 * This module centralizes the dynamic state of the face verification application.
 * By managing state in a single, structured object, we can avoid global variables,
 * improve predictability, and make it easier to track changes throughout the app.
 */

export const state = {
    // Worker and Model Status
    isWorkerReady: false,
    isFaceApiReady: false,
    faceApiReadyPromise: null,
    resolveFaceApiReady: null,
    worker: null,
    isDetectingFrame: false,
    videoDetectionStep: null,

    // Application Mode
    faceapiAction: null, // "register" or "verify"

    // User Registration State
    registration: {
        currentUserId: '',
        currentUserName: '',
        currentUserDescriptors: [],
        capturedFrames: [],
        isCompleted: false,
        startTime: null,
        timer: null,
        timeLeft: 0,
        currentAttempt: 0,
        bestCandidate: {
            descriptor: null,
            minDist: 0,
        },
        attemptDistances: [],
        lastFaceImageData: null,
        currentModalIndex: -1,
    },

    // User Verification State
    verification: {
        registeredUsers: [],
        flatRegisteredDescriptors: [],
        flatRegisteredUserMeta: [],
        lastLoadedJson: '',
        results: [],
        isCompleted: false,
        totalFaces: 0,
        verifiedCount: 0,
        verifiedUserIds: new Set(),
    },

    // Face Detector Options (can be adjusted dynamically)
    faceDetectorOptions: {
        inputSize: 128,
        scoreThreshold: 0.1,
        maxDetectedFaces: 1,
    },
};

// Initialize the promise for face-api readiness
state.faceApiReadyPromise = new Promise(resolve => {
    state.resolveFaceApiReady = resolve;
});

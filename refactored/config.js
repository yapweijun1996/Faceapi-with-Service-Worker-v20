/**
 * config.js
 * ---------
 * This file contains the static configuration for the face verification application.
 * It includes DOM element IDs, model paths, and default settings for face detection.
 * Centralizing these values makes it easier to manage and update the application's
 * configuration without altering the core logic.
 */

export const config = {
    // DOM Element IDs
    video: {
        id: "video",
        output: "canvas_output",
    },
    canvas: {
        id: "canvas",
        overlay: "canvas",
        box: "canvas",
    },
    ui: {
        progressText: "progressText",
        progressFill: "progressFill",
        retakeBtn: "retakeBtn",
        restartBtn: "restartBtn",
        cancelBtn: "cancelBtn",
        downloadBtn: "downloadBtn",
        verifyRestartBtn: "verifyRestartBtn",
        verifyCancelBtn: "verifyCancelBtn",
        verifyProgressText: "verifyProgressText",
        verifyProgressFill: "verifyProgressFill",
        verifyPersonList: "verifyPersonList",
        registrationMessage: "registrationMessage",
        verifyToast: "verifyToast",
        loadingOverlay: "loadingOverlay",
        permissionOverlay: "permissionOverlay",
        timeoutOverlay: "timeoutOverlay",
        capturePreview: "capturePreview",
        imageModal: "imageModal",
        timerText: "timerText",
        userIdInput: "userIdInput",
        userNameInput: "userNameInput",
        userFaceIdJson: ".user_face_id_json",
        faceVerificationResult: ".face_verification_result",
        allFaceIdForVerification: ".all_face_id_for_verification",
        progressContainer: "progressContainer",
        verifyProgressContainer: "verifyProgressContainer",
        faceDetectionContainer: ".face-detection-container",
    },

    // File Paths
    models: {
        warmupFace: "./models/face_for_loading.png",
    },
    workers: {
        serviceWorker: "faceDetectionServiceWorker.js",
        serviceWorkerPath: "./js/faceDetectionServiceWorker.js",
        webWorkerPath: "./js/faceDetectionWebWorker.js",
    },

    // Face Detection Settings
    faceDetector: {
        inputSize: 128,
        scoreThreshold: 0.1,
        maxDetectedFaces: 1,
    },
    registration: {
        similarityThreshold: 0.15, // Min Euclidean distance to accept a new capture
        maxAttempts: 20, // Max attempts per descriptor slot
        maxCaptures: 20, // Number of captures required for registration
        timeout: 60 * 1000, // 1 minute
    },
    verification: {
        distanceThreshold: 0.3, // Max Euclidean distance for a match
    },
    quality: {
        minConfidence: 0.5, // Minimum detection confidence
        minArea: 0.05, // Minimum face area as a percentage of the video frame
    },
    feedback: {
        duplicateThreshold: 0.3, // Threshold for detecting a duplicate face across users
        consistencyThreshold: 0.3, // Max distance from previous captures for the same user
    },

    // Feature Flags
    features: {
        showLandmarks: true,
        showFaceBox: true,
        allowMultipleFaces: true,
    },

    // Other Settings
    db: {
        name: "FaceRegProgressDB",
        version: 1,
        store: "progress",
    },
    stepFps: 16.67, // ~60 FPS
};

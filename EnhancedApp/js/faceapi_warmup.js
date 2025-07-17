/**
* faceapi_warmup.js
* ------------------
* Helper utilities that sit on top of face-api.js + a Service Worker.
* The script is responsible for:
*   • Boot-strapping the Service Worker that loads the neural-network models in a
*     separate thread (avoids blocking the main UI).
*   • Handling camera start / stop, reading frames and forwarding them to the
*     worker for inference.
*   • Drawing helper overlays: raw frame, bounding box, facial landmarks, etc.
*   • Performing basic registration / verification logic using Euclidean
*     distance between face descriptors.
*
* NOTE: For brevity the implementation uses a bunch of global variables. If you
* intend to maintain / extend the code consider wrapping it inside an IIFE or
* converting it to an ES Module to avoid polluting the global scope.
*
* The registration UI shows a progress panel containing thumbnail previews of
* each captured frame.  Users can tap these thumbnails to view them in a modal
* while the underlying video feed is paused.  Progress is persisted in
* IndexedDB so a partially completed registration survives a page reload.
*/
var videoId = "video";
/**
* ID of the hidden canvas used for capturing raw video frames for inference.
* @type {string}
*/
var canvasId = "canvas";
var canvasId2 = "canvas2";
var canvasId3 = "canvas3";
/**
* ID of the snapshot canvas used to display the detected face image with confidence percentage.
* @type {string}
*/
var canvasOutputId = "canvas_output";
var step_fps = 16.67 ; // 1000 / 16.67 = 60 FPS
var vle_face_landmark_position_yn = "y" ; // y / n
var vle_facebox_yn = "y" ; // y / n


var isWorkerReady = false;
var isFaceApiReady = false;
var faceApiReadyPromise;
var resolveFaceApiReady;
faceApiReadyPromise = new Promise(resolve => {
    resolveFaceApiReady = resolve;
});
var worker = "";
var serviceWorkerFileName = "faceDetectionServiceWorker.js";
var serviceWorkerFilePath = "./js/faceDetectionServiceWorker.js";
var imgFaceFilePathForWarmup = "./models/face_for_loading.png";

if(typeof face_detector_options_setup === "undefined" || face_detector_options_setup === "undefined"){
	var face_detector_options_setup = {
		inputSize: 128,
		scoreThreshold: 0.1,
		maxDetectedFaces: 1,
	};
}

var isDetectingFrame = false;          // Prevent overlapping detection requests
var videoDetectionStep = null;         // Reference to the next frame callback

// Add user registration support
var currentUserId = '';
var currentUserName = '';
var currentUserDescriptors = [];
var registeredUsers = [];
var flatRegisteredDescriptors = [];
var flatRegisteredUserMeta = [];
var lastLoadedVerificationJson = '';
var verificationResults = [];
// Flag to allow multiple face detection ("y" = allow multiple, else single)
var multiple_face_detection_yn = "y";

// ---------------------------------------------------------------------------
// IndexedDB Integration for Persistent Storage
// ---------------------------------------------------------------------------
// We use IndexedDB to store user profiles (ID, name, and face descriptors)
// persistently in the browser. This avoids the need for manual file handling
// and creates a more seamless experience.

const DB_NAME = 'faceDatabase';
const DB_VERSION = 1;
const STORE_NAME = 'users';
let db;

async function initDB() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'id' });
			}
		};

		request.onsuccess = (event) => {
			db = event.target.result;
			resolve(db);
		};

		request.onerror = (event) => {
			console.error('IndexedDB error:', event.target.error);
			reject(event.target.error);
		};
	});
}

async function saveUser(user) {
	if (!db) await initDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction([STORE_NAME], 'readwrite');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.put(user);

		request.onsuccess = () => resolve();
		request.onerror = (event) => {
			console.error('Failed to save user:', event.target.error);
			reject(event.target.error);
		};
	});
}

async function getAllUsers() {
	if (!db) await initDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction([STORE_NAME], 'readonly');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.getAll();

		request.onsuccess = (event) => {
			resolve(event.target.result);
		};

		request.onerror = (event) => {
			console.error('Failed to get all users:', event.target.error);
			reject(event.target.error);
		};
	});
}

// The functions saveProgress, loadProgress, and clearProgress are now obsolete
// and will be removed. The new IndexedDB helpers above will be used instead.
function saveProgress() { /* no-op */ }
function loadProgress() { /* no-op */ }
function clearProgress() { /* no-op */ }

// Adjust detection options for low-end devices
function adjustDetectionForDevice() {
	try {
		const mem = navigator.deviceMemory || 4;
		const cores = navigator.hardwareConcurrency || 4;
		if (mem <= 2 || cores <= 2) {
			face_detector_options_setup.inputSize = 96;
			// Increase threshold slightly for performance
			face_detector_options_setup.scoreThreshold = Math.max(face_detector_options_setup.scoreThreshold || 0.5, 0.5);
		}
	} catch (err) {
		console.warn('Device capability detection failed', err);
	}
}

// Similarity filtering settings for registration
var registrationSimilarityThreshold = 0.15; // minimum Euclidean distance to accept new capture
var maxRegistrationAttempts = 20;            // maximum attempts per descriptor slot
var currentRegistrationAttempt = 0;          // attempt counter for current slot
var bestCandidateDescriptor = null;          // best diverse descriptor seen so far
var bestCandidateMinDist = 0;                // its distance
// Track descriptor distances for calibration insight
var registrationAttemptDistances = [];

// Add helper functions for improved registration checks and feedback
const duplicateThreshold = 0.3; // threshold for duplicate across users; local-only
const consistencyThreshold = 0.3; // max allowed distance from previous captures

function showMessage(type, message) {
	const msgEl = document.getElementById('registrationMessage');
	if (msgEl) {
		msgEl.innerText = message;
		msgEl.style.color = type === 'error' ? 'red' : 'green';
		msgEl.style.display = message ? 'inline-block' : 'none';
		if (msgEl._hideTimer) {
			clearTimeout(msgEl._hideTimer);
		}
		if (message) {
			msgEl._hideTimer = setTimeout(() => {
				msgEl.innerText = '';
				msgEl.style.display = 'none';
			}, 5000);
		}
	}
}

function showVerifyToast(message) {
	const toast = document.getElementById('verifyToast');
	if (!toast) return;
	toast.innerText = message;
	toast.classList.add('show');
	if (toast._hideTimer) {
		clearTimeout(toast._hideTimer);
	}
	toast._hideTimer = setTimeout(() => {
		toast.classList.remove('show');
	}, 3000);
}

function showLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

/**
 * Updates the model loading status message on the UI.
 * @param {string} message - The message to display.
 * @param {boolean} isError - If true, the message will be displayed in red.
 */
function updateModelStatus(message, isError = false) {
    const statusEl = document.getElementById('model-status');
    if (statusEl) {
        statusEl.innerText = message;
        statusEl.style.color = isError ? 'red' : '#555';
    }
}


/*
function updateProgress() {
	const el = document.getElementById('progressText');
	if (el) {
		el.innerText = `${currentUserDescriptors.length}/${maxCaptures} captures`;
	}
	const fill = document.getElementById('progressFill');
	if (fill) {
		const pct = Math.min(100, (currentUserDescriptors.length / maxCaptures) * 100);
		fill.style.width = pct + '%';
	}
	const show = currentUserDescriptors.length > 0;
	const retake = document.getElementById('retakeBtn');
	const restart = document.getElementById('restartBtn');
	if (retake) retake.style.display = show ? 'inline-block' : 'none';
	if (restart) restart.style.display = 'inline-block';
}
*/

/*
function updateVerifyProgress() {
	const el = document.getElementById('verifyProgressText');
	if (el) {
		el.innerText = `${verifiedCount}/${totalVerifyFaces} verified.`;
	}
	const fill = document.getElementById('verifyProgressFill');
	if (fill) {
		const pct = totalVerifyFaces ? Math.min(100, (verifiedCount / totalVerifyFaces) * 100) : 0;
		fill.style.width = pct + '%';
	}
}
*/

/*
function addCapturePreview(dataUrl) {
	if (!dataUrl) return;
	const preview = document.getElementById('capturePreview');
	if (!preview) return;
	const img = document.createElement('img');
	img.src = dataUrl;
	img.className = 'capture-thumb';
	img.dataset.index = capturedFrames.length - 1;
	preview.appendChild(img);
	
	const count = preview.querySelectorAll('textarea[id^="capturePreview_"]').length + 1;
	const ta = document.createElement('textarea');
	ta.id = `capturePreview_${count}`;
	ta.name = `capturePreview_${count}`; 
	ta.className = 'capture-data';
	ta.style.display = 'none';
	ta.value = dataUrl;
	preview.appendChild(ta);
	
	requestAnimationFrame(() => {
		img.classList.add('show');
		preview.scrollLeft = preview.scrollWidth;
	});
}
*/

/*
function retakeLastCapture() {
	if (currentUserDescriptors.length === 0) return;
	currentUserDescriptors.pop();
	capturedFrames.pop();
	const preview = document.getElementById('capturePreview');
	if (preview) {
		if (preview.lastChild) preview.removeChild(preview.lastChild); // textarea
		if (preview.lastChild) preview.removeChild(preview.lastChild); // image
	}
	updateProgress();
	saveProgress();
}

function restartRegistration() {
	if (!isFaceApiReady) {
        showMessage('error', 'Face API is not ready yet. Please wait.');
        return;
    }
	stopRegistrationTimer();
	currentUserDescriptors = [];
	capturedFrames = [];
	const preview = document.getElementById('capturePreview');
	if (preview) preview.innerHTML = '';
	registrationStartTime = null;
	registrationCompleted = false;
	faceapi_action = 'register';
	const downloadBtn = document.getElementById('downloadBtn');
	if (downloadBtn) downloadBtn.style.display = 'none';
	updateProgress();
	clearProgress();
	clear_all_canvases();
	const container = document.querySelector('.face-detection-container');
	if (container) container.style.display = 'flex';
	camera_start().then(() => {
		if (!videoDetectionStep) {
			video_face_detection();
		}
	});
}

function cancelRegistration() {
	camera_stop();
	faceapi_action = null;
	registrationCompleted = true;
	stopRegistrationTimer();
	currentUserDescriptors = [];
	capturedFrames = [];
	const preview = document.getElementById('capturePreview');
	if (preview) preview.innerHTML = '';
	const downloadBtn = document.getElementById('downloadBtn');
	if (downloadBtn) downloadBtn.style.display = 'none';
	updateProgress();
	clearProgress();
	clear_all_canvases();
	const container = document.querySelector('.face-detection-container');
	if (container) container.style.display = 'none';
}
*/

/*
function restartVerification() {
	if (!isFaceApiReady) {
        showMessage('error', 'Face API is not ready yet. Please wait.');
        return;
    }
	verifiedCount = 0;
	verifiedUserIds = new Set();
	verificationCompleted = false;
	const list = document.getElementById('verifyPersonList');
	if (list) {
		Array.from(list.querySelectorAll('li')).forEach(li => {
			li.classList.remove('verified');
			const status = li.querySelector('.status');
			if (status) status.textContent = 'pending';
		});
	}
	verificationResults = registeredUsers.map(u => ({ id: u.id, name: u.name, verified: false }));
	updateVerificationResultTextarea();
	updateVerifyProgress();
	faceapi_action = 'verify';
	camera_start().then(() => {
		if (!videoDetectionStep) {
			video_face_detection();
		}
	});
}

function cancelVerification() {
	camera_stop();
	faceapi_action = null;
	// Preserve current verification progress and results.
	// Only clear the canvas overlays and stop the camera so the
	// user can restart verification later if desired.
	clear_all_canvases();
}
*/

/*
function populateUserFaceIdTextarea() {
	if (currentUserDescriptors.length === 0) return null;
	const meanDescriptor = computeMeanDescriptor(currentUserDescriptors);
	const downloadData = [{
		id: currentUserId,
		name: currentUserName,
		descriptors: [
			...currentUserDescriptors.map(d => Array.from(d)),
			Array.from(meanDescriptor)
		]
	}];
	const jsonData = JSON.stringify(downloadData, null, 2);
	const ta = document.querySelector('.user_face_id_json');
	if (ta) {
		ta.value = jsonData;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	}
	return jsonData;
}

function downloadRegistrationData() {
	const jsonData = populateUserFaceIdTextarea();
	if (!jsonData) return;
	const blob = new Blob([jsonData], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'faceid_with_users.json';
	link.click();
	URL.revokeObjectURL(url);
}
*/

function updateVerificationResultTextarea() {
	const ta = document.querySelector('.face_verification_result');
	if (ta) {
		ta.value = JSON.stringify(verificationResults, null, 2);
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	}
}

function captureAndSaveVerifiedUserImage(imageData, metadata) {
	if (!imageData) return null;

	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	canvas.width = imageData.width;
	canvas.height = imageData.height;
	ctx.putImageData(imageData, 0, 0);

	// Add timestamp and metadata
	const now = new Date();
	const timestamp = now.toLocaleString();
	ctx.fillStyle = 'white';
	ctx.font = '12px Arial';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'bottom';

	let yPos = canvas.height - 5;
	const lineHeight = 14;

	if (metadata.gps) {
		const gpsText = `GPS: ${metadata.gps.latitude.toFixed(4)}, ${metadata.gps.longitude.toFixed(4)}`;
		ctx.fillText(gpsText, 5, yPos);
		yPos -= lineHeight;
	}
	if (metadata.timeZone) {
		const tzText = `TimeZone: ${metadata.timeZone} (UTC${metadata.timeZoneOffset})`;
		ctx.fillText(tzText, 5, yPos);
		yPos -= lineHeight;
	}
	if (metadata.deviceName) {
		ctx.fillText(`Device: ${metadata.deviceName}`, 5, yPos);
		yPos -= lineHeight;
	}
	if (metadata.deviceModel) {
		ctx.fillText(`Model: ${metadata.deviceModel}`, 5, yPos);
		yPos -= lineHeight;
	}
	if (metadata.utcTime) {
		ctx.fillText(`UTC: ${metadata.utcTime}`, 5, yPos);
		yPos -= lineHeight;
	}
	ctx.fillText(`Local: ${timestamp}`, 5, yPos);


	return canvas.toDataURL('image/jpeg', 0.5);
}

async function getGpsCoordinates() {
	return new Promise((resolve) => {
		const askForPermission = () => {
			navigator.geolocation.getCurrentPosition(
				(position) => {
					resolve({
						latitude: position.coords.latitude,
						longitude: position.coords.longitude,
					});
				},
				(error) => {
					if (error.code === error.PERMISSION_DENIED) {
						alert("GPS permission is required for verification. Please allow access to continue.");
						setTimeout(askForPermission, 1000); // Ask again after a short delay
					} else {
						console.error("Error getting GPS location:", error);
						resolve(null); // Resolve with null if there's another error
					}
				}
			);
		};
		askForPermission();
	});
}

async function getDeviceMetadata() {
	const gps = await getGpsCoordinates();
	const now = new Date();
	const utcTime = now.toUTCString();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const offsetMinutes = now.getTimezoneOffset();
	const offsetHours = -offsetMinutes / 60;
	const timeZoneOffset = (offsetHours >= 0 ? '+' : '') + offsetHours;
	const userAgent = navigator.userAgent;

	const parser = new UAParser();
	const result = parser.getResult();

	const deviceName = result.device.vendor ? `${result.device.vendor} ${result.device.type || ''}`.trim() : 'Unknown';
	const deviceModel = result.os.name ? `${result.os.name} ${result.os.version || ''}`.trim() : 'Unknown';

	return { gps, utcTime, timeZone, timeZoneOffset, deviceName, deviceModel, deviceUserAgent: userAgent };
}

function isConsistentWithCurrentUser(descriptor) {
	if (currentUserDescriptors.length === 0) return true;
	return currentUserDescriptors.every(refDesc =>
	faceapi.euclideanDistance(descriptor, refDesc) < consistencyThreshold
	);
}

function isDuplicateAcrossUsers(descriptor) {
	if (!descriptor || flatRegisteredDescriptors.length === 0) return false;
	return flatRegisteredDescriptors.some(ref =>
	faceapi.euclideanDistance(descriptor, ref) < duplicateThreshold
	);
}

// Check if descriptor matches current user's existing captures
function isRecognizedAsCurrentUser(descriptor) {
	return currentUserDescriptors.some(refDesc =>
	faceapi.euclideanDistance(descriptor, refDesc) < consistencyThreshold
	);
}

function isCaptureQualityHigh(detection) {
	if (!detection || !detection.detection) return false;
	const score = detection.detection._score || 0;
	const box = detection.alignedRect && detection.alignedRect._box;
	if (!box) return false;
	const video = document.getElementById(videoId);
	const minArea = (video.videoWidth * video.videoHeight) * 0.05; // at least 5% of frame
	const area = box._width * box._height;
	return score >= 0.5 && area >= minArea;
}

function computeMeanDescriptor(descriptors) {
	if (!descriptors || descriptors.length === 0) return null;
	const len = descriptors[0].length;
	const mean = new Float32Array(len);
	descriptors.forEach(desc => {
		for (let i = 0; i < len; i++) {
			mean[i] += desc[i];
		}
	});
	for (let i = 0; i < len; i++) {
		mean[i] /= descriptors.length;
	}
	return mean;
}

function logCalibrationSummary() {
	if (registrationAttemptDistances.length === 0) return;
	const sum = registrationAttemptDistances.reduce((a, b) => a + b, 0);
	const avg = sum / registrationAttemptDistances.length;
	console.log('Average registration distance:', avg.toFixed(3));
	registrationAttemptDistances = [];
}

// Draw bounding box and label for registration/recognition overlay
function drawRegistrationOverlay(detection) {
	const video = document.getElementById(videoId);
	const canvas = document.getElementById(canvasId3);
	const ctx = canvas.getContext('2d');
	canvas.style.display = 'block';
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	// Clear previous drawings
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	const box = detection.alignedRect._box;
	const MX = canvas.width - box._x - box._width;
	const MY = box._y;
	const recognized = isRecognizedAsCurrentUser(detection.descriptor);
	const color = recognized ? 'green' : 'red';
	// Draw bounding box
	ctx.beginPath(); ctx.rect(MX, MY, box._width, box._height);
	ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
	// Draw label text above box
	ctx.font = '18px Arial'; ctx.fillStyle = color;
	ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
	const labelText = recognized ? `${currentUserName} (${currentUserId})` : 'Unknown';
	ctx.fillText(labelText, MX, MY - 10);
}

async function camera_start() {
  const video = document.getElementById(videoId);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('getUserMedia not supported');
    if (typeof showPermissionOverlay === 'function') showPermissionOverlay();
    showMessage('error', 'Camera not supported in this browser.');
    return;
  }

  // Add playsinline etc. attributes programmatically
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.setAttribute('autoplay', '');
  video.style.display = 'block';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;

    // Try to play video after metadata loads
    video.onloadedmetadata = () => {
      video.play().catch(e => {
        console.warn('video.play() failed:', e);
      });
    };

    // Add error handlers to video
    video.onerror = e => console.error('Video error event:', e);
    video.onpause = () => console.log('Video paused');
    video.onplay = () => console.log('Video playing');

    const overlay = document.getElementById('permissionOverlay');
    if (overlay) overlay.style.display = 'none';
  } catch (err) {
    console.error('Error accessing webcam:', err);
    if (typeof showPermissionOverlay === 'function') showPermissionOverlay();
    showMessage('error', 'Unable to access camera: ' + err.message);
  }
}


async function camera_stop() {
	var video = document.getElementById(videoId);
	if (video.srcObject) {
		const stream = video.srcObject;
		const tracks = stream.getTracks();
		tracks.forEach(track => track.stop());
		video.srcObject = null;
		video.pause();
	}
	isDetectingFrame = false;
	videoDetectionStep = null;
}

/*
async function handleJsonFileInput(event) {
	const files = event.target.files;
	if (!files || files.length === 0) return;
	let allUsers = [];
	let errorFiles = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		try {
			const text = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = e => resolve(e.target.result);
				reader.onerror = reject;
				reader.readAsText(file);
			});
			const data = JSON.parse(text);
			if (Array.isArray(data) && data.length > 0 && data[0].hasOwnProperty('id')) {
				allUsers = allUsers.concat(data);
			} else {
				// Old format: array of descriptors (not recommended for multi-user)
				// Wrap as a dummy user
				allUsers.push({ id: null, name: null, descriptors: data });
			}
		} catch (err) {
			errorFiles.push(file.name);
		}
	}
	if (errorFiles.length > 0) {
		showMessage('error', 'Failed to load: ' + errorFiles.join(', ') + '. Check the file format and try again.');
	}
	if (allUsers.length > 0) {
		const jsonStr = JSON.stringify(allUsers);
		const ta = document.querySelector('.all_face_id_for_verification');
		if (ta) {
			ta.value = jsonStr;
			ta.dispatchEvent(new Event('input', { bubbles: true }));
		} else {
			await load_face_descriptor_json(jsonStr, true);
			showMessage('success', `Loaded ${allUsers.length} users from ${files.length} file(s).`);
		}
	}
}

async function load_face_descriptor_json(warmupFaceDescriptorJson, merge = false) {
	await faceApiReadyPromise; // Wait for models to load
	if (!isFaceApiReady) {
        console.warn('Face API not ready, deferring JSON load.');
        // Optionally, you could queue this to run after API is ready
        return;
    }
	try {
		const data = JSON.parse(warmupFaceDescriptorJson);
		if (Array.isArray(data) && data.length > 0 && data[0].hasOwnProperty('id')) {
			if (!merge) {
				registeredUsers = data;
			} else {
				registeredUsers = (registeredUsers || []).concat(data);
			}
			flatRegisteredDescriptors = [];
			flatRegisteredUserMeta = [];
			registeredUsers.forEach(user => {
				user.descriptors.forEach((descArr, idx) => {
					if (idx === user.descriptors.length - 1 && user.descriptors.length > 1) {
						// Skip mean descriptor to reduce matching overhead
						return;
					}
					flatRegisteredDescriptors.push(new Float32Array(descArr));
					flatRegisteredUserMeta.push({ id: user.id, name: user.name });
				});
			});
			registeredDescriptors = flatRegisteredDescriptors;
		} else {
			// Old format: array of descriptors
			const descriptors = Object.values(data).map(descriptor => {
				if (Array.isArray(descriptor) || typeof descriptor === 'object' && descriptor !== null) {
					return new Float32Array(Object.values(descriptor));
				} else {
					return null;
				}
			}).filter(descriptor => descriptor !== null);
			registeredDescriptors = descriptors;
			flatRegisteredDescriptors = descriptors;
			flatRegisteredUserMeta = descriptors.map(() => ({ id: null, name: null }));
		}
		
		const listEl = document.getElementById('verifyPersonList');
		if (listEl) {
			listEl.innerHTML = '';
			registeredUsers.forEach(u => {
				const li = document.createElement('li');
				li.dataset.userId = u.id;
				const name = u.name || 'Unknown';
				li.innerHTML = `${name} (${u.id}) – <span class="status">pending</span>`;
				listEl.appendChild(li);
			});
		}
		
		verificationResults = registeredUsers.map(u => ({
			id: u.id,
			name: u.name,
			verified: false,
			capturedImage: null,
			utcTime: null,
			timeZone: null,
			timeZoneOffset: null,
			gps: null,
			device: null,
			deviceName: null,
			deviceModel: null,
			deviceUserAgent: null
		}));
		updateVerificationResultTextarea();
		
		totalVerifyFaces = registeredUsers.length;
		verifiedCount = 0;
		verifiedUserIds = new Set();
		updateVerifyProgress();
		
		camera_start();
		video_face_detection();
	} catch (error) {
		showMessage('error', 'Error loading face descriptors: ' + error.message + '. Please verify the JSON structure.');
	}
}
*/

/**
* Continuously captures video frames and sends them to the service worker for face detection.
* Draws the raw frame into the hidden canvas (canvasId) for inference.
*/
function video_face_detection() {
	var video = document.getElementById(videoId);
	var canvas = document.getElementById(canvasId);
	canvas.willReadFrequently = true;
	var context = canvas.getContext("2d");
	context.willReadFrequently = true;
	
	video.addEventListener('play', () => {
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		function step() {
			// Skip processing if video is paused/ended or a detection is already running
			if (video.paused || video.ended) {
				return;
			}
			if (isDetectingFrame) {
				// Wait until the previous detection result returns
				requestAnimationFrame(step);
				return;
			}
			
			// Ensure canvas has valid dimensions before drawing
			if (canvas.width === 0 || canvas.height === 0) {
				canvas.width = video.videoWidth || video.width;
				canvas.height = video.videoHeight || video.height;
				// If still zero, wait for the next frame
				if (canvas.width === 0 || canvas.height === 0) {
					requestAnimationFrame(step);
					return;
				}
			}
			
			// Capture current frame
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
			
			// Mark a detection in-flight and send the frame to the worker
			isDetectingFrame = true;
			if (navigator.serviceWorker && navigator.serviceWorker.controller) {
				navigator.serviceWorker.controller.postMessage({
					type: 'DETECT_FACES',
					imageData,
					width: canvas.width,
					height: canvas.height,
					face_detector_options: face_detector_options_setup,
				});
			} else if (worker && typeof worker.postMessage === 'function') {
				worker.postMessage({
					type: 'DETECT_FACES',
					imageData,
					width: canvas.width,
					height: canvas.height,
					face_detector_options: face_detector_options_setup,
				});
			}
			
			// Schedule the next frame – this will be skipped if detection is still running
			// Next frame will be scheduled when the worker returns the detection result
		}
		
		// Store reference so we can trigger a new cycle from the worker callback
		videoDetectionStep = step;
		requestAnimationFrame(step);
	});
}

async function unregisterAllServiceWorker() {
	navigator.serviceWorker.getRegistrations().then(registrations => {
		registrations.forEach(registration => {
			registration.unregister();
		});
	});
}

/**
* Draws the captured face image and confidence percentage onto the snapshot canvas (canvasOutputId).
* @param {Array} detections - Array containing face detection results and raw ImageData.
* @param {string} canvasId - ID of the canvas to draw the snapshot on.
*/
async function drawImageDataToCanvas(detections, canvasId) {
	const canvas = document.getElementById(canvasId);
	const context = canvas.getContext("2d");
	
	// Expect [results, imageDataArray]; guard against invalid shapes
	if (!Array.isArray(detections) || detections.length < 2) {
		console.log('No image data to draw');
		return;
	}
	
	const results = detections[0];
	const images = detections[1];
	
	if (!Array.isArray(images) || images.length === 0) {
		console.log('No image data to draw');
		return;
	}
	
	const imageData = images[0];
	
	// Determine confidence if available
	let confidence = 0;
	if (Array.isArray(results) && results.length > 0 && results[0] && results[0].detection) {
		const score = results[0].detection._score;
		if (typeof score === 'number') {
			confidence = score * 100;
		}
	}
	
	// Set canvas dimensions to match the imageData
	canvas.width = imageData.width;
	canvas.height = imageData.height;
	
	// Draw the ImageData onto the canvas
	context.putImageData(imageData, 0, 0);
	
	// Display confidence percentage
	context.font = '20px Arial';
	context.fillStyle = 'white';
	context.fillText(`Confidence: ${confidence.toFixed(2)}%`, 10, 30);
}

/* Overlay Canvas Elements:
*   #canvas        – hidden canvas capturing raw video frames for worker inference.
*   #canvas2       – overlay for drawing facial landmarks (mirrored to match video).
*   #canvas3       – overlay for drawing bounding boxes and confidence (mirrored to match video).
*   #canvas_output – snapshot canvas showing captured face image with confidence.
*
* Canvas Functions:
*   video_face_detection    – continuously grabs video frames and sends to service worker for detection.
*   drawImageDataToCanvas   – displays the detected-face snapshot and confidence on #canvas_output.
*   drawLandmarks           – draws mirrored landmark points on #canvas2 overlay.
*   draw_face_box           – draws mirrored face bounding box and upright confidence text on #canvas3 overlay.
*   draw_face_landmarks     – draws detailed mirrored landmark shapes on #canvas2 overlay.
*/

/**
* Draws mirrored facial landmark dots onto the landmarks overlay canvas (canvasId2).
* @param {Array<{ x: number, y: number }>} landmarks - Array of landmark point coordinates.
*/
function drawLandmarks(landmarks) {
	// Legacy stub: forward to full spline glow style
	draw_face_landmarks();
}

/**
* Draws a mirrored face bounding box and confidence percentage onto the bounding box overlay canvas (canvasId3).
* @param {string} canvas_id - ID of the canvas to draw the bounding box.
* @param {Object} box - Bounding box object with _x, _y, _width, and _height properties.
* @param {number} confidence - Confidence score (0 to 1) of the face detection.
*/
function draw_face_box(canvas_id, box, confidence) {
	const canvas = document.getElementById(canvas_id);
	const ctx = canvas.getContext('2d');
	const video = document.getElementById(videoId);
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	canvas.style.display = 'block';
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	const mx = canvas.width - box._x - box._width;
	const my = box._y;
	let boxColor = 'red';
	if (confidence >= 0.8) boxColor = 'green'; else if (confidence >= 0.5) boxColor = 'yellow';
	ctx.beginPath(); ctx.rect(mx, my, box._width, box._height);
	ctx.lineWidth = 3; ctx.strokeStyle = boxColor; ctx.stroke();
	ctx.font = '16px Arial'; ctx.fillStyle = boxColor;
	ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
	ctx.fillText(`${Math.round(confidence * 100)}%`, mx + box._width - 5, my - 10);
}

/**
* Draws detailed facial landmarks with optional connecting lines onto the landmarks overlay canvas (canvasId2).
*/
function draw_face_landmarks(detection) {
	if (!detection || !detection.landmarks || !detection.landmarks._positions) return;
	const video = document.getElementById(videoId);
	const canvas = document.getElementById(canvasId2);
	const ctx = canvas.getContext('2d');
	canvas.style.display = 'block';
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	const width = canvas.width;
	const height = canvas.height;
	// Extract and mirror landmark positions
	const raw = detection.landmarks._positions;
	const pts = raw.map(pt => ({ x: width - pt._x, y: pt._y }));
	ctx.clearRect(0, 0, width, height);
	// Draw each landmark as a small white circle with corporate-blue outline
	ctx.fillStyle = '#ffffff';
	ctx.strokeStyle = '#007ACC';
	ctx.lineWidth = 1;
	pts.forEach(({ x, y }) => {
		ctx.beginPath();
		ctx.arc(x, y, 2, 0, 2 * Math.PI);
		ctx.fill();
		ctx.stroke();
	});
	// Define facial feature groups by landmark indices
	const groups = {
		jaw: [...Array(17).keys()],
		leftBrow: [17,18,19,20,21],
		rightBrow: [22,23,24,25,26],
		noseBridge: [27,28,29,30],
		noseBottom: [31,32,33,34,35],
		leftEye: [36,37,38,39,40,41,36],
		rightEye: [42,43,44,45,46,47,42],
		outerLips: [48,49,50,51,52,53,54,55,56,57,58,59,48],
		innerLips: [60,61,62,63,64,65,66,67,60]
	};
	// Draw subtle gray lines for each group
	ctx.strokeStyle = '#555555';
	ctx.lineWidth = 1;
	for (const idxs of Object.values(groups)) {
		ctx.beginPath();
		idxs.forEach((i, k) => {
			const p = pts[i];
			if (k === 0) ctx.moveTo(p.x, p.y);
			else ctx.lineTo(p.x, p.y);
		});
		ctx.stroke();
	}
}

/**
* Clears the landmarks overlay canvas and hides it.
*/
function clear_landmarks() {
	const canvas = document.getElementById(canvasId2);
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.style.display = 'none';
}

/**
* Clears the face bounding box overlay canvas and hides it.
*/
function clear_boxes() {
	const canvas = document.getElementById(canvasId3);
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.style.display = 'none';
}

/**
* Clears all overlay canvases used during detection/registration.
*/
function clear_all_canvases() {
	[canvasId, canvasId2, canvasId3, canvasOutputId].forEach(id => {
		const c = document.getElementById(id);
		if (c) {
			const ctx = c.getContext('2d');
			ctx.clearRect(0, 0, c.width, c.height);
			c.style.display = 'none';
		}
	});
}

var registeredDescriptors = [];
var maxCaptures = 20;
var registrationCompleted = false;
var verificationCompleted = false;
var totalVerifyFaces = 0;
var verifiedCount = 0;
var verifiedUserIds = new Set();
var capturedFrames = [];
var lastFaceImageData = null;

/*
var registrationStartTime = null;
var registrationTimeout = 1 * 60 * 1000; // 1 minute
var registrationTimer = null;
var timeLeft = registrationTimeout;
var currentModalIndex = -1;

function showModalImage(index) {
	const modal = document.getElementById('imageModal');
	if (!modal || index < 0 || index >= capturedFrames.length) return;
	const imgEl = modal.querySelector('img');
	if (imgEl) imgEl.src = capturedFrames[index];
	modal.style.display = 'flex';
	currentModalIndex = index;
}

function startRegistrationTimer() {
	stopRegistrationTimer();
	timeLeft = registrationTimeout / 1000;
	updateTimerText();
	registrationTimer = setInterval(() => {
		timeLeft--;
		updateTimerText();
		if (timeLeft <= 0) {
			stopRegistrationTimer(true);
		}
	}, 1000);
}

function updateTimerText() {
	const el = document.getElementById('timerText');
	if (el) {
		el.innerText = `Time left: ${timeLeft}s`;
	}
}

function stopRegistrationTimer(triggerTimeout = false) {
	if (registrationTimer) {
		clearInterval(registrationTimer);
		registrationTimer = null;
	}
	const el = document.getElementById('timerText');
	if (el) {
		el.innerText = '';
	}
	if (triggerTimeout && !registrationCompleted) {
		showMessage('error', 'Registration timed out. Ensure you are well lit and try again.');
		if (typeof showTimeoutOverlay === 'function') showTimeoutOverlay();
		faceapi_action = null;
		camera_stop();
		registrationCompleted = true;
	}
}

function pauseRegistrationTimer() {
	if (registrationTimer) {
		clearInterval(registrationTimer);
		registrationTimer = null;
	}
}

function resumeRegistrationTimer() {
	if (!registrationTimer && timeLeft > 0) {
		registrationTimer = setInterval(() => {
			timeLeft--;
			updateTimerText();
			if (timeLeft <= 0) {
				stopRegistrationTimer(true);
			}
		}, 1000);
	}
}
*/

function faceapi_register(descriptor) {
    if (!descriptor || registrationCompleted) {
        return;
    }

    let accept = false;
    if (currentUserDescriptors.length === 0) {
        accept = true;
    } else {
        const distances = currentUserDescriptors.map(d => faceapi.euclideanDistance(descriptor, d));
        const minDist = Math.min(...distances);
        if (minDist > registrationSimilarityThreshold) {
            accept = true;
        }
    }

    if (accept) {
        currentUserDescriptors.push(descriptor);
        if (lastFaceImageData) {
            const canvas = document.createElement('canvas');
            canvas.width = lastFaceImageData.width;
            canvas.height = lastFaceImageData.height;
            canvas.getContext('2d').putImageData(lastFaceImageData, 0, 0);
            const dataUrl = canvas.toDataURL();
            if (typeof addCapturePreview === 'function') {
                addCapturePreview(dataUrl);
            }
        }
        if (typeof updateProgress === 'function') {
            updateProgress();
        }
    }
}

var vle_distance_rate = 0.3;

/**
* Threshold used by face-api.js Euclidean distance to decide whether two
* face descriptors correspond to the same person.
*
* A lower value makes the verification stricter (fewer false positives but
* more false negatives). 0.3 is a commonly used starting point that works
* well in good lighting conditions. Adjust empirically for your setup.
*/
async function faceapi_verify(descriptor) {
    if (!descriptor || verificationCompleted) {
        return;
    }

    // Use FaceMatcher to find the best match
    const faceMatcher = new faceapi.FaceMatcher(registeredUsers.map(u => new faceapi.LabeledFaceDescriptors(u.name, u.descriptors.map(d => new Float32Array(d)))));
    const bestMatch = faceMatcher.findBestMatch(descriptor);

    if (bestMatch.label !== 'unknown') {
        const user = registeredUsers.find(u => u.name === bestMatch.label);
        if (user && !verifiedUserIds.has(user.id)) {
            verifiedUserIds.add(user.id);
            if (typeof updateVerificationStatus === 'function') {
                updateVerificationStatus();
            }
        }
    }
}

function handleWorkerMessage(event) {
    console.log('Received message from worker:', event.data.type);
    switch (event.data.type) {
        case 'MODEL_LOADING_PROGRESS':
            updateModelStatus(event.data.message);
            break;
        case 'MODELS_LOADED':
            console.log('Face detection models loaded by worker.');
            updateModelStatus('Models loaded. Starting camera for warmup...');
            // The new warmup process will handle setting isFaceApiReady.
            faceapi_warmup();
            break;
        case 'DETECTION_RESULT':
            const dets = event.data.data.detections[0];
            const imageDataForFrame = event.data.data.detections[1] && event.data.data.detections[1][0];
            lastFaceImageData = imageDataForFrame;
            drawImageDataToCanvas(event.data.data.detections, canvasOutputId);
            drawAllFaces(Array.isArray(dets) ? dets : []);

            if (Array.isArray(dets) && dets.length > 0) {
                if (faceapi_action === "verify") {
                    dets.forEach(d => faceapi_verify(d.descriptor, imageDataForFrame));
                } else if (faceapi_action === "register") {
                    if (dets.length !== 1) {
                        if (typeof showMessage === 'function') showMessage('error', 'Multiple faces detected. Please ensure only your face is visible.');
                    } else {
                        const descriptor = dets[0].descriptor;
                        if (!isCaptureQualityHigh(dets[0])) {
                            if (typeof showMessage === 'function') showMessage('error', 'Low-quality capture. Ensure good lighting and face the camera.');
                        } else if (isDuplicateAcrossUsers(descriptor)) {
                            if (typeof showMessage === 'function') showMessage('error', 'This face appears already registered.');
                        } else if (!isConsistentWithCurrentUser(descriptor)) {
                            if (typeof showMessage === 'function') showMessage('error', 'Face angle changed too much. Please turn your head slowly.');
                        } else {
                            if (typeof showMessage === 'function') showMessage('success', 'Face capture accepted.');
                            if (navigator.vibrate) navigator.vibrate(100);
                            faceapi_register(descriptor);
                        }
                    }
                }
            } else {
                showMessage("error", "No face detected. Make sure your face is fully visible and well lit.");
            }

            if (typeof vle_face_landmark_position_yn === "string" && vle_face_landmark_position_yn == "y") {
                if (Array.isArray(dets) && dets.length > 0 && dets[0]) {
                    draw_face_landmarks(dets[0]);
                } else {
                    clear_landmarks();
                }
            }

            if (multiple_face_detection_yn !== "y" && typeof vle_facebox_yn === "string" && vle_facebox_yn == "y") {
                if (dets && dets.length > 0 && dets[0] && dets[0].alignedRect && dets[0].alignedRect._box) {
                    draw_face_box(canvasId3, dets[0].alignedRect._box, dets[0].detection._score);
                } else {
                    clear_boxes();
                }
            }

            if (faceapi_action === "register" && Array.isArray(dets) && dets.length > 0 && dets[0]) {
                drawRegistrationOverlay(dets[0]);
            }

            isDetectingFrame = false;
            if (typeof videoDetectionStep === 'function') {
                requestAnimationFrame(videoDetectionStep);
            }
            break;
        case 'WARMUP_RESULT':
            console.log('Warmup completed by worker.');
            updateModelStatus('Ready.');
            if (typeof warmup_completed !== 'undefined' && Array.isArray(warmup_completed)) {
                warmup_completed.forEach(func => func());
            }
            break;
        default:
            console.log('Unknown message type from worker:', event.data.type);
    }
}

async function initWorkerAddEventListener() {
    navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
}

async function workerRegistration() {
	if (!('serviceWorker' in navigator)) {
		console.error('Service workers are not supported in this browser.');
		return;
	}
	
	// Ensure the scope of the SW covers the current page (script directory by default)
	const swScope = './js/';
	
	// Attempt to find an existing registration for our SW file within scope
	const registrations = await navigator.serviceWorker.getRegistrations();
	let registration = registrations.find(reg => reg.active && reg.active.scriptURL.endsWith(serviceWorkerFileName));
	
	if (!registration) {
		console.log('Registering new service worker');
		try {
			registration = await navigator.serviceWorker.register(serviceWorkerFilePath, { scope: swScope });
		} catch (err) {
			console.error('Service worker registration failed:', err);
			throw err;
		}
	}
	
	// Wait until the service worker is activated. Avoid using navigator.serviceWorker.ready
	if (!registration.active) {
		console.log('Waiting for service worker to activate...');
		
		await new Promise(resolve => {
			// If there is an installing worker listen for state changes
			const installingWorker = registration.installing || registration.waiting;
			if (!installingWorker) {
				// No worker yet (very unlikely) – resolve immediately
				return resolve();
			}
			
			if (installingWorker.state === 'activated') {
				return resolve();
			}
			
			installingWorker.addEventListener('statechange', evt => {
				if (evt.target.state === 'activated') {
					resolve();
				}
			});
		});
	}
	
	// After activation grab the worker reference
	worker = registration.active || registration.waiting || registration.installing;
	return worker;
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function load_model() {
	if (!worker) {
		// Ensure we have a reference – this should usually not happen because
		// initWorker already awaited workerRegistration(), but keep it as a
		// safeguard.
		await workerRegistration();
	}
	
	if (worker) {
		if (navigator.serviceWorker && navigator.serviceWorker.controller) {
			navigator.serviceWorker.controller.postMessage({ type: 'LOAD_MODELS' });
		} else if (worker && typeof worker.postMessage === 'function') {
			worker.postMessage({ type: 'LOAD_MODELS' });
		}
	} else {
		console.error('Unable to post message, worker is undefined');
	}
}

/**
 * Enhanced warm-up process.
 * This function now ensures that models are loaded, the camera is active,
 * and a first successful face detection has occurred before resolving the
 * faceApiReadyPromise.
 */
async function faceapi_warmup() {
    updateModelStatus('Warming up: Verifying models with static image...');

    // We need to wait for the first successful detection using a static image.
    // This confirms the model is functional without requiring immediate camera access.
    const warmupDetectionPromise = new Promise((resolve, reject) => {
        const originalHandler = handleWorkerMessage;

        // Create a timeout for the warmup process
        const warmupTimeout = setTimeout(() => {
            console.error('Warmup timed out. Worker did not respond.');
            updateModelStatus('Warmup failed. Please reload.', true);
            handleWorkerMessage = originalHandler; // Restore handler
            reject(new Error('Warmup timed out'));
        }, 10000); // 10-second timeout

        handleWorkerMessage = (event) => {
            // We still want the original handler to process other messages
            originalHandler(event);
            if (event.data.type === 'WARMUP_RESULT') {
                clearTimeout(warmupTimeout); // Clear the timeout on success
                handleWorkerMessage = originalHandler; // Restore the original handler
                resolve();
            }
        };
    });

    // Trigger a dummy detection using a static image
    if (worker) {
        worker.postMessage({ type: 'WARMUP_WITH_IMAGE' });
    } else {
        console.error("Worker not available for warmup.");
        updateModelStatus('Initialization error.', true);
        return;
    }

    try {
        await warmupDetectionPromise;
        console.log('Warmup complete: Models loaded and verified with a static image.');
        updateModelStatus('Ready.');
        isFaceApiReady = true;
        if (typeof resolveFaceApiReady === 'function') {
            resolveFaceApiReady();
        }
    } catch (error) {
        console.error('Face API warmup failed:', error);
        // The status is already updated by the timeout handler
    }
}

/**
 * Initializes the Web Worker as a fallback.
 * This is called if the Service Worker fails to initialize.
 */
async function startWebWorker() {
    console.log("Service Worker failed. Falling back to Web Worker.");
    updateModelStatus('Using Web Worker fallback...');

    if (window.Worker) {
        worker = new Worker('./js/faceDetectionWebWorker.js');
        worker.onmessage = handleWorkerMessage;
        worker.onerror = (error) => {
            console.error("Web Worker error:", error);
            updateModelStatus('Web Worker error.', true);
        };
        worker.postMessage({ type: 'LOAD_MODELS' });
    } else {
        console.error("Web Workers are not supported in this browser.");
        updateModelStatus('Face detection not supported.', true);
    }
}

/**
 * Initializes the face detection API.
 * It first tries to use a Service Worker for background processing.
 * If that fails, it falls back to a standard Web Worker.
 */
async function initializeFaceApi() {
    updateModelStatus('Initializing...');
    const swSupported = 'serviceWorker' in navigator;
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined';

    if (swSupported && offscreenSupported) {
        try {
            console.log("Attempting to initialize Service Worker...");
            // Use the more robust, existing workerRegistration function
            const sw = await workerRegistration();
            if (!sw) {
                throw new Error("Service Worker registration failed to return an active worker.");
            }

            // The global 'worker' variable is now set by workerRegistration.
            // Add the message listener.
            navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
            
            console.log("Service Worker is active. Loading models.");
            updateModelStatus('Loading models via Service Worker...');

            // The controller is the safest way to post a message.
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'LOAD_MODELS' });
            } else {
                // Fallback to the worker reference if controller is not yet available.
                sw.postMessage({ type: 'LOAD_MODELS' });
            }
            isWorkerReady = true;

        } catch (error) {
            console.error("Service Worker initialization failed:", error);
            await startWebWorker(); // Fallback to Web Worker
        }
    } else {
        console.warn("Service Worker or OffscreenCanvas not supported. Using Web Worker fallback.");
        await startWebWorker();
    }
}

// --- App Initialization ---
document.addEventListener("DOMContentLoaded", async function(event) {
    adjustDetectionForDevice();
    setupCanvasResizeObserver(); // Set up the observer for responsive canvases
    await initializeFaceApi();
    // Any other setup that depends on the face API can be chained here
});

// Add multi-face drawing utilities
function drawAllLandmarks(detectionsArray) {
	const video = document.getElementById(videoId);
	const canvas = document.getElementById(canvasId2);
	const ctx = canvas.getContext('2d');
	canvas.style.display = 'block';
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	detectionsArray.forEach(det => {
		const raw = det.landmarks._positions;
		const pts = raw.map(pt => ({ x: canvas.width - pt._x, y: pt._y }));
		ctx.fillStyle = '#ffffff';
		ctx.strokeStyle = '#007ACC';
		ctx.lineWidth = 1;
		pts.forEach(p => {
			ctx.beginPath();
			ctx.arc(p.x, p.y, 2, 0, 2 * Math.PI);
			ctx.fill();
			ctx.stroke();
		});
	});
}

function drawAllBoxesAndLabels(detectionsArray) {
	const video = document.getElementById(videoId);
	const canvas = document.getElementById(canvasId3);
	const ctx = canvas.getContext('2d');
	canvas.style.display = 'block';
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	detectionsArray.forEach(det => {
		const box = det.alignedRect._box;
		const confidence = det.detection._score;
		const mx = canvas.width - box._x - box._width;
		const my = box._y;
		let boxColor = 'red';
		if (confidence >= 0.8) boxColor = 'green'; else if (confidence >= 0.5) boxColor = 'yellow';
		ctx.beginPath(); ctx.rect(mx, my, box._width, box._height);
		ctx.lineWidth = 3; ctx.strokeStyle = boxColor; ctx.stroke();
		// Match user for label
		let matchedUser = { name: 'Unknown', id: 'Unknown' };
		let minDist = Infinity;
		flatRegisteredDescriptors.forEach((ref, idx) => {
			const dist = faceapi.euclideanDistance(det.descriptor, ref);
			if (dist < minDist && dist < vle_distance_rate) {
				minDist = dist;
				matchedUser = flatRegisteredUserMeta[idx];
			}
		});
		const labelText = `${matchedUser.name} (${matchedUser.id})`;
		ctx.font = '16px Arial';
		ctx.fillStyle = boxColor;
		ctx.textAlign = 'left';
		ctx.fillText(labelText, mx + 5, my + 15);
	});
}

function drawAllFaces(detectionsArray) {
	if (!Array.isArray(detectionsArray) || detectionsArray.length === 0) {
		clear_landmarks();
		clear_boxes();
		return;
	}
	drawAllLandmarks(detectionsArray);
	drawAllBoxesAndLabels(detectionsArray);
}

/**
 * Sets up a ResizeObserver to keep canvas overlays perfectly aligned with the video element.
 * This is crucial for responsive layouts, especially on mobile devices.
 */
function setupCanvasResizeObserver() {
    const video = document.getElementById(videoId);
    const canvases = [canvasId, canvasId2, canvasId3].map(id => document.getElementById(id));

    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const { width, height } = entry.contentRect;
            canvases.forEach(canvas => {
                if (canvas) {
                    canvas.width = width;
                    canvas.height = height;
                }
            });
        }
    });

    if (video) {
        resizeObserver.observe(video);
    }
}

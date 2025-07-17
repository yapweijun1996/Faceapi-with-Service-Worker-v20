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
// Persisting registration progress
// ---------------------------------------------------------------------------
// Captured descriptors and thumbnails are stored in IndexedDB so that a user can
// refresh the page or come back later without losing their partially completed
// registration.  The helpers below handle saving/loading that state.

async function openProgressDB() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('FaceRegProgressDB', 1);
		request.onupgradeneeded = e => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains('progress')) {
				db.createObjectStore('progress', { keyPath: 'id' });
			}
		};
		request.onsuccess = e => resolve(e.target.result);
		request.onerror = e => reject(e.target.error);
	});
}

function saveProgress() {
	const data = {
		id: currentUserId,
		name: currentUserName,
		descriptors: currentUserDescriptors.map(d => Array.from(d)),
		frames: capturedFrames
	};
	openProgressDB().then(db => {
		const tx = db.transaction('progress', 'readwrite');
		tx.objectStore('progress').put({ id: 'current', data });
	}).catch(e => console.warn('Failed to save progress', e));
}

function loadProgress() {
	openProgressDB().then(db => {
		const tx = db.transaction('progress', 'readonly');
		const req = tx.objectStore('progress').get('current');
		req.onsuccess = () => {
			const record = req.result;
			if (!record || !record.data || !Array.isArray(record.data.descriptors)) return;
			const data = record.data;
			currentUserId = data.id || '';
			currentUserName = data.name || '';
			currentUserDescriptors = data.descriptors.map(arr => new Float32Array(arr));
			capturedFrames = Array.isArray(data.frames) ? data.frames : [];
			const idInput = document.getElementById('userIdInput');
			const nameInput = document.getElementById('userNameInput');
			if (idInput) idInput.value = currentUserId;
			if (nameInput) nameInput.value = currentUserName;
			capturedFrames.forEach(url => addCapturePreview(url));
			updateProgress();
		};
	}).catch(e => console.warn('Failed to load progress', e));
}

function clearProgress() {
	openProgressDB().then(db => {
		const tx = db.transaction('progress', 'readwrite');
		tx.objectStore('progress').delete('current');
	}).catch(() => {});
}

// ---------------------------------------------------------------------------
// Persisting user profiles to IndexedDB
// ---------------------------------------------------------------------------
let db;

async function initDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            return resolve(db);
        }
        const request = indexedDB.open('UserDB', 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('users')) {
                db.createObjectStore('users', { keyPath: 'id' });
            }
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
        request.onerror = (event) => {
            console.error('Database error:', event.target.error);
            reject(event.target.error);
        };
    });
}

async function saveUser(user) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['users'], 'readwrite');
        const store = transaction.objectStore('users');
        const request = store.put(user);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject('Error saving user: ' + event.target.error);
    });
}

async function getAllUsers() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['users'], 'readonly');
        const store = transaction.objectStore('users');
        const request = store.getAll();
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject('Error getting all users: ' + event.target.error);
    });
}

async function deleteUser(userId) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['users'], 'readwrite');
        const store = transaction.objectStore('users');
        const request = store.delete(userId);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject('Error deleting user: ' + event.target.error);
    });
}

async function updateUser(userId, newName) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['users'], 'readwrite');
        const store = transaction.objectStore('users');
        const request = store.get(userId);
        request.onerror = (event) => reject('Error finding user: ' + event.target.error);
        request.onsuccess = (event) => {
            const user = event.target.result;
            if (user) {
                user.name = newName;
                const updateRequest = store.put(user);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = (event) => reject('Error updating user: ' + event.target.error);
            } else {
                reject('User not found');
            }
        };
    });
}

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
	window.location.href = 'index.html';
}

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
	window.location.href = 'index.html';
}

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
var registrationStartTime = null;
var registrationTimeout = 1 * 60 * 1000; // 1 minute
var registrationTimer = null;
var timeLeft = registrationTimeout;
var capturedFrames = [];
var lastFaceImageData = null;
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

function faceapi_register(descriptor) {
	if (!descriptor || registrationCompleted) {
		return;
	}
	// On first capture, read user info
	if (currentUserDescriptors.length === 0) {
		currentUserId = document.getElementById('userIdInput').value.trim();
		currentUserName = document.getElementById('userNameInput').value.trim();
	}
	let accept = false;
	// Always accept the first descriptor
	if (currentUserDescriptors.length === 0) {
		accept = true;
	} else {
		// Compute minimum distance to existing descriptors
		const distances = currentUserDescriptors.map(d => faceapi.euclideanDistance(descriptor, d));
		const minDist = Math.min(...distances);
		registrationAttemptDistances.push(minDist);
		console.log('Registration distance:', minDist.toFixed(3));
		// Update best candidate if more distinct
		currentRegistrationAttempt++;
		if (minDist > bestCandidateMinDist) {
			bestCandidateMinDist = minDist;
			bestCandidateDescriptor = descriptor;
		}
		// Accept if sufficiently different
		if (minDist > registrationSimilarityThreshold) {
			accept = true;
		} else if (currentRegistrationAttempt >= maxRegistrationAttempts) {
			// Max attempts reached, accept best candidate so far
			accept = true;
			descriptor = bestCandidateDescriptor || descriptor;
		}
	}
	if (accept) {
		currentUserDescriptors.push(descriptor);
		if (lastFaceImageData) {
			const cv = document.createElement('canvas');
			cv.width = lastFaceImageData.width;
			cv.height = lastFaceImageData.height;
			cv.getContext('2d').putImageData(lastFaceImageData, 0, 0);
			const url = cv.toDataURL();
			capturedFrames.push(url);
			addCapturePreview(url);
		}
		updateProgress();
		saveProgress();
		// Reset attempt tracking
		currentRegistrationAttempt = 0;
		bestCandidateDescriptor = null;
		bestCandidateMinDist = 0;
		// Check if registration is complete
		if (currentUserDescriptors.length >= maxCaptures) {
			registrationCompleted = true;
			stopRegistrationTimer();
			faceapi_action = null;
			camera_stop();
			clear_all_canvases();
			
			const meanDescriptor = computeMeanDescriptor(currentUserDescriptors);
			const user = {
				id: currentUserId,
				name: currentUserName,
				descriptors: [
					...currentUserDescriptors.map(d => Array.from(d)),
					Array.from(meanDescriptor)
				]
			};

			saveUser(user).then(() => {
				alert("Registration completed and saved for user: " + currentUserName + " (" + currentUserId + ")");
				// Optionally clear progress after successful save
				clearProgress();
				// Hide registration UI elements and show success message
				const container = document.getElementById('progressContainer');
				if (container) container.classList.add('expanded');
				const downloadBtn = document.getElementById('downloadBtn');
				if (downloadBtn) downloadBtn.style.display = 'none'; // No more download
				updateProgress();
				setTimeout(() => {
					window.location.href = 'index.html';
				}, 2000);
			}).catch(err => {
				console.error(err);
				showMessage('error', 'Failed to save user profile.');
			});
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
async function faceapi_verify(descriptor, imageData){
	if (descriptor && !verificationCompleted) {
		let matchFound = false;
		let distance;
		let matchedIndex = -1;
		
		for (let i = 0; i < registeredDescriptors.length; i++) {
			if (descriptor.length === registeredDescriptors[i].length) {
				distance = faceapi.euclideanDistance(descriptor, registeredDescriptors[i]);
				if (distance < vle_distance_rate) {
					matchFound = true;
					matchedIndex = i;
					break;
				}
			}
		}
		
		if (matchFound) {
			const userMeta = flatRegisteredUserMeta[matchedIndex] || { name: 'Unknown', id: 'Unknown' };
			const uid = userMeta.id;
			if (uid && !verifiedUserIds.has(uid)) {
				verifiedUserIds.add(uid);
				verifiedCount++;

				const metadata = await getDeviceMetadata();
				const capturedImage = captureAndSaveVerifiedUserImage(imageData, metadata);

				const li = document.querySelector(`#verifyPersonList li[data-user-id="${uid}"]`);
				if (li) {
					const status = li.querySelector('.status');
					if (status) status.textContent = 'verified';
					li.classList.add('verified');
				}
				verificationResults = verificationResults.map(r => {
					if (r.id === uid) {
						return { ...r, verified: true, capturedImage, ...metadata };
					}
					return r;
				});
				updateVerificationResultTextarea();
				updateVerifyProgress();
				showVerifyToast(`${userMeta.name} (${userMeta.id}) detected`);
				if (verifiedCount >= totalVerifyFaces) {
					camera_stop();
					verificationCompleted = true;
					faceapi_action = null;
					if (typeof showVerifyCompleteOverlay === 'function') showVerifyCompleteOverlay();
					clear_all_canvases();
				}
			}
			if (multiple_face_detection_yn !== "y") {
				console.log(`Face Verified: ${userMeta.name} (${userMeta.id}), distance: ${distance.toFixed(3)}`);
			} else {
				console.log(`Face Detected: ${userMeta.name} (${userMeta.id}), distance: ${distance.toFixed(3)}`);
			}
		} else {
			// No match found
		}
	}
}

function handleWorkerMessage(event) {
    console.log('Received message from worker:', event.data.type);
    switch (event.data.type) {
        case 'MODELS_LOADED':
            console.log('Face detection models loaded by worker. Starting warmup...');
            // Models are loaded, now trigger the warmup process.
            // The UI loader will remain visible until the warmup is also complete.
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
                    if (registrationStartTime === null) {
                        registrationStartTime = Date.now();
                        startRegistrationTimer();
                    }
                    if (Date.now() - registrationStartTime > registrationTimeout) {
                        stopRegistrationTimer(true);
                    } else if (dets.length !== 1) {
                        showMessage('error', 'Multiple faces detected. Please ensure only your face is visible.');
                    } else {
                        const descriptor = dets[0].descriptor;
                        if (!isCaptureQualityHigh(dets[0])) {
                            showMessage('error', 'Low-quality capture. Ensure good lighting and face the camera.');
                        } else if (isDuplicateAcrossUsers(descriptor)) {
                            showMessage('error', 'This face appears already registered.');
                        } else if (!isConsistentWithCurrentUser(descriptor)) {
                            showMessage('error', 'Face angle changed too much. Please turn your head slowly.');
                        } else {
                            showMessage('success', 'Face capture accepted.');
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
            console.log('Warmup completed by worker. Face API is now fully ready.');
            // Now that models are loaded and warmed up, the API is ready.
            isFaceApiReady = true;
            if (typeof resolveFaceApiReady === 'function') {
                resolveFaceApiReady();
            }
            // Hide the loading overlay as the final step.
            hideLoadingOverlay();
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

async function initWorker() {
	if ('serviceWorker' in navigator) {
		try {
			// Optionally uncomment if needed
			// await unregisterAllServiceWorker();
			
			console.log("Registering service worker...");
			await workerRegistration(); // Wait for worker registration
			
			console.log("Adding event listeners...");
			await initWorkerAddEventListener(); // Wait for event listeners to be added
			
			console.log("Waiting for 1 second...");
			await delay(500); // Wait for 1 second to give the service worker some time to activate. If not, when the service worker is created for the first time, posting a message will cause an error and stop everything.
			
			console.log("Loading model...");
			await load_model(); // Wait for the model to load
			
			isWorkerReady = true; // Set the worker as ready
			console.log("Worker initialized successfully. Waiting for model and warmup confirmation...");
		} catch (error) {
			console.error("Error initializing worker:", error);
			hideLoadingOverlay(); // Hide loader on failure
		}
	} else {
		console.error('Service workers are not supported in this browser.');
	}
}


function faceapi_warmup() {
	var img_face_for_loading = imgFaceFilePathForWarmup;
	if (img_face_for_loading) {
		var img = new Image();
		img.src = img_face_for_loading;
		img.onload = () => {
			
			// Create the canvas element
			let canvas_hidden = document.createElement('canvas');
			canvas_hidden.willReadFrequently = true;
			canvas_hidden.style.display = 'none'; // Hide the canvas
			document.body.appendChild(canvas_hidden); // Append to the body
			let context = canvas_hidden.getContext("2d");
			
			canvas_hidden.width = img.width;
			canvas_hidden.height = img.height;
			context.drawImage(img, 0, 0, img.width, img.height);
			var imageData = context.getImageData(0, 0, img.width, img.height);
			if (navigator.serviceWorker && navigator.serviceWorker.controller) {
				navigator.serviceWorker.controller.postMessage({
					type: 'WARMUP_FACES',
					imageData,
					width: img.width,
					height: img.height
				});
			} else if (worker && typeof worker.postMessage === 'function') {
				worker.postMessage({
					type: 'WARMUP_FACES',
					imageData,
					width: img.width,
					height: img.height
				});
			}
			canvas_hidden.remove();
		};
	}
}

// Initialize the Web Worker fallback
async function startWebWorker() {
    console.log("Service Worker not supported, falling back to Web Worker.");
    showLoadingOverlay();

    if (window.Worker) {
        worker = new Worker('./js/faceDetectionWebWorker.js');

        // Listen for messages from the Web Worker
        worker.onmessage = (event) => {
            // Use the same event listener logic as the Service Worker
            handleWorkerMessage(event);
        };

        worker.onerror = (error) => {
            console.error("Web Worker error:", error);
            hideLoadingOverlay();
            showMessage('error', 'An error occurred with the Web Worker.');
        };

        // Start loading models in the Web Worker
        worker.postMessage({ type: 'LOAD_MODELS' });
    } else {
        console.error("Web Workers are not supported in this browser.");
        hideLoadingOverlay();
        showMessage('error', 'Face detection is not supported on this browser.');
    }
}

// Global init function for face-api
async function initFaceApi() {
    if (isWorkerReady) {
        console.log("Face API already initialized or in progress.");
        return faceApiReadyPromise;
    }
    console.log("Initializing Face API...");
    showLoadingOverlay();

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const swSupported = 'serviceWorker' in navigator;
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined';

    // Prefer Service Worker, but have a robust fallback
    if (swSupported && offscreenSupported && !isIOS) {
        console.log("Attempting to initialize with Service Worker.");
        try {
            await initWorker();
            console.log("Service Worker initialized successfully.");
        } catch (error) {
            console.error("Service Worker initialization failed. Falling back to Web Worker.", error);
            await startWebWorker();
        }
    } else {
        let reason = !swSupported ? "ServiceWorker not supported" :
                     !offscreenSupported ? "OffscreenCanvas not supported" :
                     "iOS detected";
        console.warn(`${reason}. Forcing Web Worker fallback.`);
        await startWebWorker();
    }
    return faceApiReadyPromise;
}

// Initialize either service worker or fallback to web worker
document.addEventListener("DOMContentLoaded", async function(event) {
    // On pages that need face-api, we call initFaceApi and wait for it to complete.
    // On index.html, it's called but we don't wait, allowing it to load in the background.
    if (window.location.pathname.endsWith('face_register.html') || window.location.pathname.endsWith('face_verify.html') || window.location.pathname.endsWith('profile_management.html')) {
        try {
            await initFaceApi();
            console.log("Face API is ready, proceeding with page setup.");
        } catch (error) {
            console.error("Failed to initialize Face API for the page:", error);
            // Optionally, show an error message to the user
        }
    }

	clearProgress();
	loadProgress();
	adjustDetectionForDevice();
	
	// Add ResizeObserver to keep canvas overlays aligned with the video
    const video = document.getElementById(videoId);
    if (video) {
        const observer = new ResizeObserver(() => {
            const overlays = [canvasId, canvasId2, canvasId3].map(id => document.getElementById(id));
            overlays.forEach(canvas => {
                if (canvas) {
                    canvas.width = video.clientWidth;
                    canvas.height = video.clientHeight;
                }
            });
        });
        observer.observe(video);
    }

	updateProgress();
	updateVerifyProgress();
	const retake = document.getElementById('retakeBtn');
	const restart = document.getElementById('restartBtn');
	const cancel = document.getElementById('cancelBtn');
	const download = document.getElementById('downloadBtn');
	if (retake) retake.addEventListener('click', retakeLastCapture);
	if (restart) restart.addEventListener('click', restartRegistration);
	if (cancel) cancel.addEventListener('click', cancelRegistration);
	if (download) download.addEventListener('click', downloadRegistrationData);
	const verifyRestart = document.getElementById('verifyRestartBtn');
	const verifyCancel = document.getElementById('verifyCancelBtn');
	if (verifyRestart) verifyRestart.addEventListener('click', restartVerification);
	if (verifyCancel) verifyCancel.addEventListener('click', cancelVerification);
	
	const verifyContainer = document.getElementById('verifyProgressContainer');
	if (verifyContainer) {
		const videoEl = document.getElementById('video');
		verifyContainer.addEventListener('click', e => {
			if (e.target.classList.contains('capture-thumb')) return;
			verifyContainer.classList.toggle('expanded');
			if (verifyContainer.classList.contains('expanded')) {
				if (videoEl) videoEl.pause();
			} else {
				if (videoEl) videoEl.play();
			}
			e.stopPropagation();
		});
		document.addEventListener('click', e => {
			if (!verifyContainer.contains(e.target)) {
				const wasExpanded = verifyContainer.classList.contains('expanded');
				verifyContainer.classList.remove('expanded');
				if (wasExpanded && videoEl) videoEl.play();
			}
		});
	}
	
	const verifyTa = document.querySelector('.all_face_id_for_verification');
	if (verifyTa) {
		const tryStartVerification = () => {
			const txt = verifyTa.value.trim();
			if (!txt) return;
			try {
				if (txt !== lastLoadedVerificationJson) {
					JSON.parse(txt);
					lastLoadedVerificationJson = txt;
					load_face_descriptor_json(txt);
				}
			} catch (err) {
				console.error('Invalid verification JSON', err);
			}
		};
		verifyTa.addEventListener('input', tryStartVerification);
		tryStartVerification();
	}
	// ----- Preview thumbnail interaction -----
	// Each captured frame is rendered as a small thumbnail inside the progress
	// container.  When the user taps on a thumbnail we want to show a larger
	// preview without collapsing the container.  The handler below expands the
	// progress container if it isn't already, pauses the video stream, then
	// displays the clicked image inside a modal dialog.
	const capturePreviewEl = document.getElementById('capturePreview');
	if (capturePreviewEl) {
		capturePreviewEl.addEventListener('click', e => {
			// Only react when one of the <img class="capture-thumb"> elements is clicked
			if (e.target.classList.contains('capture-thumb')) {
				// Prevent the click from triggering the container's toggle logic
				e.stopPropagation();
				
				const progressContainer = document.getElementById('progressContainer');
				const video = document.getElementById('video');
				
				// Automatically expand the progress panel so the enlarged image
				// is visible, and pause the camera feed to avoid confusion.
				if (progressContainer && !progressContainer.classList.contains('expanded')) {
					progressContainer.classList.add('expanded');
					if (video) video.pause();
					if (typeof pauseRegistrationTimer === 'function') pauseRegistrationTimer();
				}
				
				showModalImage(parseInt(e.target.dataset.index));
			}
		});
	}
	const modalEl = document.getElementById('imageModal');
	if (modalEl) {
		const prevBtn = modalEl.querySelector('.prev');
		const nextBtn = modalEl.querySelector('.next');
		const imgInModal = modalEl.querySelector('img');
		if (prevBtn) prevBtn.addEventListener('click', e => {
			e.stopPropagation();
			if (currentModalIndex > 0) {
				showModalImage(currentModalIndex - 1);
			}
		});
		if (nextBtn) nextBtn.addEventListener('click', e => {
			e.stopPropagation();
			if (currentModalIndex < capturedFrames.length - 1) {
				showModalImage(currentModalIndex + 1);
			}
		});
		if (imgInModal) imgInModal.addEventListener('click', e => {
			e.stopPropagation();
		});
		let touchStartX = 0;
		modalEl.addEventListener('touchstart', e => {
			if (e.touches && e.touches.length > 0) {
				touchStartX = e.touches[0].screenX;
			}
		});
		modalEl.addEventListener('touchend', e => {
			if (e.changedTouches && e.changedTouches.length > 0) {
				const diff = e.changedTouches[0].screenX - touchStartX;
				if (Math.abs(diff) > 30) {
					if (diff < 0 && currentModalIndex < capturedFrames.length - 1) {
						showModalImage(currentModalIndex + 1);
					} else if (diff > 0 && currentModalIndex > 0) {
						showModalImage(currentModalIndex - 1);
					}
				}
			}
		});
		modalEl.addEventListener('click', e => {
			if (e.target === modalEl || e.target.classList.contains('close')) {
				modalEl.style.display = 'none';
			}
		});
	}
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

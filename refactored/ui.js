/**
 * ui.js
 * -----
 * This module handles all interactions with the DOM. It is responsible for
 * updating visual elements, displaying messages, and managing UI components
 * like overlays and modals. By isolating DOM manipulation, we keep the core
 * application logic separate from the presentation layer.
 */

import { config } from './config.js';
import { state } from './state.js';

/**
 * Gets a DOM element by its ID from the config.
 * @param {string} idKey - The key for the element's ID in the config.
 * @returns {HTMLElement|null} The DOM element or null if not found.
 */
function getElement(idKey) {
    const id = config.ui[idKey];
    return id ? document.getElementById(id) : null;
}

/**
 * Gets a DOM element using a query selector from the config.
 * @param {string} selectorKey - The key for the element's selector in the config.
 * @returns {HTMLElement|null} The DOM element or null if not found.
 */
function querySelector(selectorKey) {
    const selector = config.ui[selectorKey];
    return selector ? document.querySelector(selector) : null;
}

/**
 * Shows a message to the user (e.g., for registration feedback).
 * @param {string} type - The type of message ('error' or 'success').
 * @param {string} message - The message text to display.
 */
export function showMessage(type, message) {
    const msgEl = getElement('registrationMessage');
    if (!msgEl) return;

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

/**
 * Shows a short-lived toast notification for verification events.
 * @param {string} message - The message to display in the toast.
 */
export function showVerifyToast(message) {
    const toast = getElement('verifyToast');
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

/**
 * Shows or hides a UI overlay.
 * @param {string} overlayKey - The key for the overlay ID in the config.
 * @param {boolean} show - True to show the overlay, false to hide it.
 */
export function toggleOverlay(overlayKey, show) {
    const overlay = getElement(overlayKey);
    if (overlay) {
        overlay.style.display = show ? 'flex' : 'none';
    }
}

/**
 * Updates the registration progress bar and text.
 */
export function updateRegistrationProgress() {
    const el = getElement('progressText');
    if (el) {
        el.innerText = `${state.registration.currentUserDescriptors.length}/${config.registration.maxCaptures} captures`;
    }

    const fill = getElement('progressFill');
    if (fill) {
        const pct = Math.min(100, (state.registration.currentUserDescriptors.length / config.registration.maxCaptures) * 100);
        fill.style.width = `${pct}%`;
    }

    const show = state.registration.currentUserDescriptors.length > 0;
    const retake = getElement('retakeBtn');
    const restart = getElement('restartBtn');
    if (retake) retake.style.display = show ? 'inline-block' : 'none';
    if (restart) restart.style.display = 'inline-block';
}

/**
 * Updates the verification progress bar and text.
 */
export function updateVerificationProgress() {
    const el = getElement('verifyProgressText');
    if (el) {
        el.innerText = `${state.verification.verifiedCount}/${state.verification.totalFaces} verified.`;
    }

    const fill = getElement('verifyProgressFill');
    if (fill) {
        const pct = state.verification.totalFaces ? Math.min(100, (state.verification.verifiedCount / state.verification.totalFaces) * 100) : 0;
        fill.style.width = `${pct}%`;
    }
}

/**
 * Adds a thumbnail preview of a captured frame to the UI.
 * @param {string} dataUrl - The data URL of the captured image.
 */
export function addCapturePreview(dataUrl) {
    if (!dataUrl) return;
    const preview = getElement('capturePreview');
    if (!preview) return;

    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'capture-thumb';
    img.dataset.index = state.registration.capturedFrames.length - 1;
    preview.appendChild(img);

    const ta = document.createElement('textarea');
    ta.style.display = 'none';
    ta.value = dataUrl;
    preview.appendChild(ta);

    requestAnimationFrame(() => {
        img.classList.add('show');
        preview.scrollLeft = preview.scrollWidth;
    });
}

/**
 * Removes the last captured frame's thumbnail from the UI.
 */
export function removeLastCapturePreview() {
    const preview = getElement('capturePreview');
    if (preview) {
        if (preview.lastChild) preview.removeChild(preview.lastChild); // textarea
        if (preview.lastChild) preview.removeChild(preview.lastChild); // image
    }
}

/**
 * Clears all captured frame thumbnails from the UI.
 */
export function clearCapturePreviews() {
    const preview = getElement('capturePreview');
    if (preview) preview.innerHTML = '';
}

/**
 * Updates the registration timer display.
 */
export function updateTimerText() {
    const el = getElement('timerText');
    if (el) {
        el.innerText = `Time left: ${state.registration.timeLeft}s`;
    }
}

/**
 * Clears the timer text from the display.
 */
export function clearTimerText() {
    const el = getElement('timerText');
    if (el) {
        el.innerText = '';
    }
}

/**
 * Populates the verification list with registered users.
 */
export function populateVerificationList() {
    const listEl = getElement('verifyPersonList');
    if (!listEl) return;

    listEl.innerHTML = '';
    state.verification.registeredUsers.forEach(u => {
        const li = document.createElement('li');
        li.dataset.userId = u.id;
        const name = u.name || 'Unknown';
        li.innerHTML = `${name} (${u.id}) – <span class="status">pending</span>`;
        listEl.appendChild(li);
    });
}

/**
 * Updates the status of a user in the verification list.
 * @param {string} userId - The ID of the user to update.
 */
export function updateUserVerificationStatus(userId) {
    const listEl = getElement('verifyPersonList');
    if (!listEl) return;

    const li = listEl.querySelector(`li[data-user-id="${userId}"]`);
    if (li) {
        const status = li.querySelector('.status');
        if (status) status.textContent = 'verified';
        li.classList.add('verified');
    }
}

/**
 * Resets the verification list to its initial "pending" state.
 */
export function resetVerificationList() {
    const listEl = getElement('verifyPersonList');
    if (listEl) {
        Array.from(listEl.querySelectorAll('li')).forEach(li => {
            li.classList.remove('verified');
            const status = li.querySelector('.status');
            if (status) status.textContent = 'pending';
        });
    }
}

/**
 * Shows the image modal with the specified image.
 * @param {number} index - The index of the captured frame to show.
 */
export function showModalImage(index) {
    const modal = getElement('imageModal');
    if (!modal || index < 0 || index >= state.registration.capturedFrames.length) return;

    const imgEl = modal.querySelector('img');
    if (imgEl) imgEl.src = state.registration.capturedFrames[index];
    modal.style.display = 'flex';
    state.registration.currentModalIndex = index;
}

/**
 * Hides the image modal.
 */
export function hideModal() {
    const modal = getElement('imageModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Clears all canvas overlays.
 */
export function clearAllCanvases() {
    const canvas = document.getElementById(config.canvas.id);
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

// === noscreen — Pusher-based live transcript viewer ===

// === State ===
let segments = [];
let autoScroll = true;
let speed = 4;
let isPaused = false;
const WORDS_PER_CHUNK = 100;
let wordBuffer = [];
let hasLiveBox = false;

// === Pusher config (from nojumper) ===
const PUSHER_KEY = '4ab173182785b58e2f84';
const PUSHER_CLUSTER = 'us2';
let pusherInstance = null;
let pusherChannel = null;
let currentSessionId = null;

// === DOM ===
const connectScreen = document.getElementById('connect-screen');
const sessionInput = document.getElementById('session-input');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const scrollEl = document.getElementById('transcript-scroll');
const segmentsEl = document.getElementById('transcript-segments');
const bottomBar = document.getElementById('bottom-bar');
const shortcutsRow = document.getElementById('shortcuts-row');
const modeLabel = document.getElementById('mode-label');
const scrollTag = document.getElementById('scroll-tag');
const opacityTag = document.getElementById('opacity-tag');
const speedBtns = document.querySelectorAll('.speed-btn');

// === Extract session ID from nojumper URL or raw ID ===
function extractSessionId(input) {
  input = input.trim();
  if (!input) return null;

  // Try URL patterns
  try {
    let url = input;
    if (!url.startsWith('http')) url = 'https://' + url;
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // /view/{id}
    const viewIdx = parts.indexOf('view');
    if (viewIdx !== -1 && parts[viewIdx + 1]) return parts[viewIdx + 1];
    // Single path segment = session ID
    if (parts.length === 1) return parts[0];
  } catch (e) { /* not a URL */ }

  // Raw alphanumeric session ID
  if (/^[a-zA-Z0-9_-]+$/.test(input)) return input;
  return null;
}

// === Show transcript UI, hide connect screen ===
function showTranscriptView() {
  connectScreen.style.display = 'none';
  scrollEl.style.display = '';
  bottomBar.style.display = '';
  shortcutsRow.style.display = '';
}

// === Show connect screen, hide transcript UI ===
function showConnectScreen(errorMsg) {
  connectScreen.style.display = '';
  scrollEl.style.display = 'none';
  bottomBar.style.display = 'none';
  shortcutsRow.style.display = 'none';
  if (errorMsg) connectError.textContent = errorMsg;
}

// === Connect handler ===
function handleConnect() {
  const raw = sessionInput.value;
  const sessionId = extractSessionId(raw);

  if (!sessionId) {
    connectError.textContent = 'Invalid link or session ID. Paste the full nojumper URL.';
    return;
  }

  connectError.textContent = '';
  currentSessionId = sessionId;
  showTranscriptView();

  // Tell main process to switch to click-through
  if (window.noscreen && window.noscreen.notifyConnected) {
    window.noscreen.notifyConnected();
  }

  connectPusher(sessionId);
}

connectBtn.addEventListener('click', handleConnect);
sessionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleConnect();
});

// Focus input on load
setTimeout(() => sessionInput.focus(), 100);

// === Pusher connection ===
function connectPusher(sessionId) {
  if (typeof Pusher === 'undefined') {
    showConnectScreen('Pusher library failed to load. Check your internet connection.');
    return;
  }

  // Clean up previous connection
  if (pusherInstance) {
    pusherInstance.disconnect();
    pusherInstance = null;
    pusherChannel = null;
  }

  modeLabel.textContent = 'Connecting…';

  pusherInstance = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER, forceTLS: true });
  const channelName = `transcript-${sessionId}`;
  pusherChannel = pusherInstance.subscribe(channelName);

  pusherChannel.bind('pusher:subscription_succeeded', () => {
    console.log('[noscreen] Connected to', channelName);
    isPaused = false;
    modeLabel.textContent = 'Live';

    // Clear and show waiting message
    resetTranscript();
    addSegment('Connected to session ' + sessionId + '. Waiting for transcript…', true);
  });

  pusherChannel.bind('pusher:subscription_error', (err) => {
    console.error('[noscreen] Subscription error:', err);
    showConnectScreen('Could not connect to session "' + sessionId + '". Check the link and try again.');
    if (pusherInstance) { pusherInstance.disconnect(); pusherInstance = null; }
  });

  pusherChannel.bind('transcript-event', (data) => {
    // Clear waiting message on first real data
    if (segments.length === 1 && segments[0].text.startsWith('Connected to session')) {
      resetTranscript();
    }
    if (!data.text || !data.text.trim()) return;
    processIncomingText(data.text, data.isFinal);
  });
}

// === Transcript helpers ===
function resetTranscript() {
  segments = [];
  wordBuffer = [];
  hasLiveBox = false;
  segmentsEl.innerHTML = '';
  segmentsEl.appendChild(bottomSpacer);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function createSegmentEl(segment, index) {
  const card = document.createElement('div');
  card.className = 'segment-card';
  card.innerHTML = `
    <span class="segment-number">${index + 1}</span>
    <span class="segment-dot"></span>
    <span class="segment-text">${escapeHtml(segment.text)}</span>
  `;
  return card;
}

function addSegment(text, isLive = false) {
  const prevLive = segmentsEl.querySelector('.segment-card.live');
  if (prevLive) prevLive.classList.remove('live');

  const segment = { text };
  segments.push(segment);
  const el = createSegmentEl(segment, segments.length - 1);
  if (isLive) el.classList.add('live');
  const spacer = document.getElementById('bottom-spacer');
  if (spacer) segmentsEl.insertBefore(el, spacer);
  else segmentsEl.appendChild(el);
}

function updateLastSegment(text) {
  if (segments.length === 0) return;
  segments[segments.length - 1].text = text;
  const cards = segmentsEl.querySelectorAll('.segment-card');
  const lastCard = cards[cards.length - 1];
  if (lastCard) lastCard.querySelector('.segment-text').textContent = text;
}

function finalizeLastSegment() {
  const cards = segmentsEl.querySelectorAll('.segment-card');
  const lastCard = cards[cards.length - 1];
  if (lastCard) lastCard.classList.remove('live');
}

// === Process incoming transcript text (100-word chunking) ===
function processIncomingText(text, isFinal) {
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return;

  if (isFinal) {
    wordBuffer.push(...words);
    while (wordBuffer.length >= WORDS_PER_CHUNK) {
      const chunk = wordBuffer.splice(0, WORDS_PER_CHUNK);
      if (hasLiveBox) { updateLastSegment(chunk.join(' ')); finalizeLastSegment(); hasLiveBox = false; }
      else addSegment(chunk.join(' '), false);
    }
    if (wordBuffer.length > 0) {
      const currentText = wordBuffer.join(' ');
      if (hasLiveBox) updateLastSegment(currentText);
      else { addSegment(currentText, true); hasLiveBox = true; }
    }
  } else {
    const previewText = [...wordBuffer, ...words].join(' ');
    if (hasLiveBox) updateLastSegment(previewText);
    else { addSegment(previewText, true); hasLiveBox = true; }
  }
}

// === Bottom spacer (pushes latest chunk near top) ===
const bottomSpacer = document.createElement('div');
bottomSpacer.id = 'bottom-spacer';
segmentsEl.appendChild(bottomSpacer);

function updateBottomSpacer() {
  const viewportH = scrollEl.clientHeight;
  bottomSpacer.style.height = Math.max(viewportH - 120, 60) + 'px';
  bottomSpacer.style.flexShrink = '0';
}
updateBottomSpacer();
window.addEventListener('resize', updateBottomSpacer);
new ResizeObserver(updateBottomSpacer).observe(scrollEl);

// === Auto-scroll loop ===
const SPEED_MAP = [10, 20, 30, 45, 60];
let isUserScrolling = false;
let userScrollTimeout = null;
let lastFrameTime = 0;

scrollEl.addEventListener('wheel', () => {
  if (!autoScroll) return;
  isUserScrolling = true;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(() => { isUserScrolling = false; }, 1000);
}, { passive: true });

(function startAutoScrollLoop() {
  function animate(now) {
    if (!lastFrameTime) { lastFrameTime = now; requestAnimationFrame(animate); return; }
    const dt = now - lastFrameTime;
    lastFrameTime = now;

    if (!autoScroll || isUserScrolling || isPaused) { requestAnimationFrame(animate); return; }

    const liveEl = segmentsEl.querySelector('.segment-card.live');
    if (liveEl) {
      const rect = liveEl.getBoundingClientRect();
      const containerRect = scrollEl.getBoundingClientRect();
      if (rect.top - containerRect.top <= containerRect.height * 0.15) {
        requestAnimationFrame(animate);
        return;
      }
    }

    const pxPerSec = SPEED_MAP[speed - 1] || 30;
    scrollEl.scrollTop += (pxPerSec * dt) / 1000;
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
})();

// === Speed UI ===
function updateSpeedUI(newSpeed) {
  speed = newSpeed;
  speedBtns.forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.speed) === speed));
}
speedBtns.forEach(btn => btn.addEventListener('click', () => updateSpeedUI(parseInt(btn.dataset.speed))));

function updateScrollUI() { scrollTag.textContent = autoScroll ? 'Scroll ON' : 'Scroll OFF'; }

// === IPC from main process ===
if (window.noscreen) {
  window.noscreen.onSpeedChanged(s => updateSpeedUI(s));
  window.noscreen.onToggleAutoscroll(() => { autoScroll = !autoScroll; updateScrollUI(); });
  window.noscreen.onOpacityChanged(pct => { opacityTag.textContent = `${pct}%`; });
  window.noscreen.onInteractiveChanged(interactive => {
    document.body.classList.toggle('interactive', interactive);
    if (currentSessionId) {
      modeLabel.textContent = interactive ? 'Interactive' : (isPaused ? 'Paused' : 'Live');
    }
    modeLabel.classList.toggle('interactive', interactive);
  });
  window.noscreen.onTogglePause(() => {
    if (!currentSessionId) return;
    isPaused = !isPaused;
    modeLabel.textContent = isPaused ? 'Paused' : 'Live';
    if (isPaused && pusherInstance) pusherInstance.disconnect();
    else if (!isPaused) {
      if (pusherInstance) pusherInstance.connect();
      else connectPusher(currentSessionId);
    }
  });
}

// Init
updateSpeedUI(4);
updateScrollUI();

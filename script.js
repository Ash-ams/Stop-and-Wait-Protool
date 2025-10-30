// Stop-and-Wait ARQ simulator (final stable version)
// - Proper timeout / txId / late-ACK handling
// - Late ACK dashed visuals
// - Correct timeout factor scaling
// - Optional log for timeout cleared

// --- DOM Elements ---
const startNoiselessBtn = document.getElementById('start-noiseless-btn');
const startNoisyBtn = document.getElementById('start-noisy-btn');
const resetBtn = document.getElementById('reset-btn');
const pauseBtn = document.getElementById('pause-btn');
const nextStepBtn = document.getElementById('next-step-btn');
const downloadLogBtn = document.getElementById('download-log-btn');

const animationSpeedInput = document.getElementById('animation-speed');
const numFramesInput = document.getElementById('num-frames');
const frameLossInput = document.getElementById('frame-loss');
const ackLossInput = document.getElementById('ack-loss');
const timeoutFactorInput = document.getElementById('timeout-factor');
const stepModeCheckbox = document.getElementById('step-mode-checkbox');
const darkModeCheckbox = document.getElementById('dark-mode-checkbox');
const soundToggle = document.getElementById('sound-toggle');


const logBox = document.getElementById('log-box');
const senderSeqEl = document.getElementById('sender-seq');
const receiverSeqEl = document.getElementById('receiver-seq');
const lineContainer = document.getElementById('line-container');

const channelStatusEl = document.getElementById('channel-status');
const senderStateEl = document.getElementById('sender-state');
const receiverStateEl = document.getElementById('receiver-state');
const statSummaryEl = document.getElementById('stat-summary');
const perfSummaryEl = document.getElementById('perf-summary');
const progressBarEl = document.getElementById('progress-bar');

const sndSend = document.getElementById('snd-send');
const sndAck = document.getElementById('snd-ack');
const sndLost = document.getElementById('snd-lost');

// --- Simulation State ---
let senderSeq = 0;
let receiverExpectedSeq = 0;
let activeTxSeq = null;
let isNoisy = false;

let timeoutId = null;
let currentTxId = 0;
let timeoutExpired = false;
let lastAckTxIdHandled = 0;

let simulationRunning = false;
let simulationPaused = false;
let stepMode = false;
let awaitingNextStep = false;
let waitingForAck = false;

let dataToSend = [];
let dataIndex = 0;

let ANIMATION_DURATION = parseInt(animationSpeedInput.value) || 1600;
let TIMEOUT_FACTOR = parseFloat(timeoutFactorInput.value) || 2.5;
let FRAME_LOSS_PROBABILITY = parseFloat(frameLossInput.value) / 100 || 0;
let ACK_LOSS_PROBABILITY = parseFloat(ackLossInput.value) / 100 || 0;

let stats = {
  totalTransmissions: 0,
  retransmissions: 0,
  framesLost: 0,
  acksLost: 0,
  successfulDeliveries: 0,
  startTime: null,
  endTime: null
};

// --- Helper Functions ---
function delay(ms) {
  return new Promise(resolve => {
    const tick = () => { if (simulationPaused) setTimeout(tick, 100); else resolve(); };
    setTimeout(() => tick(), ms);
  });
}

function log(message, type = 'system') {
  const ts = new Date().toLocaleTimeString();
  const p = document.createElement('p');
  p.classList.add('log-entry', type);
  p.textContent = `[${ts}] ${message}`;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
}

function playSound(type) {
  if (!soundToggle || !soundToggle.checked) return;
  const map = { send: sndSend, ack: sndAck, lost: sndLost };
  const s = map[type];
  if (!s) return;
  try { s.currentTime = 0; s.play().catch(()=>{}); } catch(e) {}
}

function updateUIFlags() {
  senderSeqEl.textContent = senderSeq;
  receiverSeqEl.textContent = receiverExpectedSeq;
  channelStatusEl.textContent = `Channel: ${isNoisy ? 'Noisy ⚡' : 'Noiseless 🌐'}`;
  statSummaryEl.textContent =
    `Sent: ${stats.totalTransmissions} | Retrans: ${stats.retransmissions} | LostF: ${stats.framesLost} | LostACK: ${stats.acksLost}`;
  updateProgress();
}

function updateProgress() {
  if (!dataToSend.length) { progressBarEl.style.width = `0%`; return; }
  const progress = (dataIndex / dataToSend.length) * 100;
  progressBarEl.style.width = `${progress}%`;
}

function setSenderState(t) { senderStateEl.textContent = `Sender: ${t}`; }
function setReceiverState(t) { receiverStateEl.textContent = `Receiver: ${t}`; }

// --- Reset / Cleanup ---
function resetState(clearUI = true) {
  simulationRunning = false;
  simulationPaused = false;
  awaitingNextStep = false;
  waitingForAck = false;
  stepMode = false;

  if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  currentTxId = 0;

  senderSeq = 0;
  receiverExpectedSeq = 0;
  activeTxSeq = null;
  dataIndex = 0;
  dataToSend = [];
  timeoutExpired = false;
  lastAckTxIdHandled = 0;

  stats = {
    totalTransmissions: 0,
    retransmissions: 0,
    framesLost: 0,
    acksLost: 0,
    successfulDeliveries: 0,
    startTime: null,
    endTime: null
  };

  if (clearUI) {
    lineContainer.innerHTML = '';
    logBox.innerHTML = '';
    setSenderState('Idle');
    setReceiverState('Ready');
    progressBarEl.style.width = '0%';
    perfSummaryEl.textContent = 'Performance: -';
    updateUIFlags();
    nextStepBtn.disabled = true;
  }
}

// --- Animation Helpers ---
function createMessageLine(type) {
  const line = document.createElement('div');
  line.classList.add('message-line');

  const totalLines = lineContainer.querySelectorAll('.message-line').length;
  const lineSpacing = 70;
  const baseOffset = 60;
  const yPosition = baseOffset + totalLines * lineSpacing;

  line.style.position = 'absolute';
  line.style.top = `${yPosition}px`;
  line.style.left = '0';
  line.style.width = '100%';
  line.style.height = '0px';

  const track = document.createElement('div');
  track.classList.add('message-track');
  line.appendChild(track);
  lineContainer.appendChild(line);

  const newHeight = baseOffset + (totalLines + 1) * lineSpacing + 150;
  lineContainer.style.height = `${newHeight}px`;

  const diagram = document.querySelector('.diagram-container');
  const timelineHeight = Math.max(newHeight, 400);
  diagram.style.setProperty('--timeline-height', `${timelineHeight}px`);

  diagram.classList.remove('pulse');
  void diagram.offsetWidth;
  diagram.classList.add('pulse');

  setTimeout(() => {
    const dia = document.querySelector('.diagram-container');
    const diagramRect = dia.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const marginFromTop = 80;
    const lineTopRel = lineRect.top - diagramRect.top;
    const targetScroll =
      dia.scrollTop + lineTopRel - dia.clientHeight / 2 + marginFromTop;
    dia.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
  }, 100);

  return line;
}

function animateMessage(lineElement, type, text, isLost = false, color = null, dashed = false) {
  return new Promise(async resolve => {
    await delay(30);
    const msgBox = document.createElement('div');
    msgBox.textContent = text;
    msgBox.classList.add(type);
    if (color) msgBox.style.background = color;
    if (dashed) {
      msgBox.style.border = "2px dashed #888";
      msgBox.style.background = "#bbbbbb33";
      msgBox.style.color = "#222";
    }
    msgBox.style.setProperty('--animation-duration', `${ANIMATION_DURATION}ms`);
    msgBox.style.visibility = 'hidden';
    msgBox.style.opacity = '0';
    lineElement.appendChild(msgBox);

    const nodeA = document.querySelector('.node-A');
    const nodeB = document.querySelector('.node-B');
    const diagram = document.querySelector('.diagram-container');

    if (nodeA && nodeB && diagram) {
      const rectA = nodeA.getBoundingClientRect();
      const rectB = nodeB.getBoundingClientRect();
      const diaRect = diagram.getBoundingClientRect();
      const centerA = rectA.left + rectA.width / 2 - diaRect.left;
      const centerB = rectB.left + rectB.width / 2 - diaRect.left;
      const msgWidth = msgBox.offsetWidth || 1;
      let startLeft;
      const moveDistance = Math.abs(centerB - centerA);
      if (type === 'frame-box') {
        startLeft = centerA - (msgWidth / 2);
        msgBox.style.setProperty('--move-x', `${moveDistance}px`);
      } else {
        startLeft = centerB - (msgWidth / 2);
        msgBox.style.setProperty('--move-x', `${moveDistance}px`);
      }
      msgBox.style.left = `${Math.max(0, startLeft)}px`;
    }

    msgBox.style.visibility = 'visible';
    msgBox.style.opacity = '1';

    if (type === 'frame-box') playSound('send');
    if (isLost) {
      const lostX = document.createElement('span');
      lostX.classList.add('lost-x');
      lostX.textContent = '×';
      lineElement.appendChild(lostX);
      playSound('lost');
      await delay(Math.max(200, ANIMATION_DURATION / 2));
      lostX.remove(); msgBox.remove(); return resolve();
    }

    msgBox.addEventListener('animationend', () => {
      if (type === 'ack-box' && !dashed) playSound('ack');
      msgBox.remove();
      resolve();
    }, { once: true });
  });
}

async function showTimeout(lineElement) {
  const timeoutLabel = document.createElement('div');
  timeoutLabel.classList.add('timeout-label');
  timeoutLabel.textContent = 'Timeout';
  lineElement.appendChild(timeoutLabel);
  await delay(ANIMATION_DURATION / 2);
  timeoutLabel.remove();
}

async function showLateAck(ackNum) {
  const lateLine = lineContainer.lastElementChild || createMessageLine('ack');

  await animateMessage(lateLine, 'ack-box', `Late ACK ${ackNum} (ignored)`, false, null, true);
}
async function showAckIgnoredInline(ackNum) {
  const lastLine = lineContainer.lastElementChild;
  if (!lastLine) return;
  const note = document.createElement("div");
  note.classList.add("timeout-label");
  note.textContent = `ACK ${ackNum} Ignored`;
  note.style.color = "#555";
  note.style.fontStyle = "italic";
  note.style.marginLeft = "100px";
  note.style.marginTop = "4px";
  lastLine.appendChild(note);
  await delay(ANIMATION_DURATION / 2);
  note.remove();
}

// --- Core Logic ---
async function handleTimeout(txId) {
  // Grace delay to allow ACK handler to complete if both happen at same time
  await delay(100);
  if (!simulationRunning || txId !== currentTxId || !waitingForAck) return;

  timeoutExpired = true;
  log('⚠️ Timeout — no ACK, retransmitting.', 'system');
  setSenderState('Timeout — Retransmitting');
  stats.retransmissions++;

  const lastLine = lineContainer.lastElementChild;
  if (lastLine) await showTimeout(lastLine);

  await delay(ANIMATION_DURATION / 3);
  await sendFrame(true);
}


async function startSimulation(noisyMode) {
  if (simulationRunning) return;
  resetState(false);
  const frameCount = parseInt(numFramesInput.value, 10);
  if (isNaN(frameCount) || frameCount <= 0) { log('Invalid frame count'); return; }

  dataToSend = Array.from({ length: frameCount }, (_, i) => `Data-${i + 1}`);
  simulationRunning = true; isNoisy = noisyMode;
  stepMode = stepModeCheckbox.checked;
  awaitingNextStep = stepMode; waitingForAck = false;
  ANIMATION_DURATION = parseInt(animationSpeedInput.value, 10) || 1600;
  TIMEOUT_FACTOR = parseFloat(timeoutFactorInput.value) || 2.5;
  FRAME_LOSS_PROBABILITY = Math.min(1, Math.max(0, parseFloat(frameLossInput.value) / 100));
  ACK_LOSS_PROBABILITY = Math.min(1, Math.max(0, parseFloat(ackLossInput.value) / 100));

  stats.startTime = Date.now();
  log(`--- Simulation Started (${isNoisy ? 'Noisy' : 'Noiseless'}) ---`, 'system');
  updateUIFlags();
  nextStepBtn.disabled = !stepMode;
  if (!stepMode) await sendFrame(); else log('Step mode: click Next Step.', 'system');
}

async function sendFrame(isRetransmit = false) {
  if (!simulationRunning) return;
  if (waitingForAck && !isRetransmit) return;
  if (dataIndex >= dataToSend.length) return finishSimulation();

  const data = dataToSend[dataIndex];
  stats.totalTransmissions++;
  if (isRetransmit) stats.retransmissions++;

  currentTxId++;
  const txId = currentTxId;
  activeTxSeq = senderSeq;
  waitingForAck = true;
  timeoutExpired = false;

  log(`SENDER → Frame ${senderSeq} '${data}' ${isRetransmit ? '(retransmit)' : ''}`, 'send');
  setSenderState(isRetransmit ? 'Retransmitting frame' : 'Sending frame');
  updateUIFlags();

  const currentLine = createMessageLine('frame');
  const frameLost = isNoisy && Math.random() < FRAME_LOSS_PROBABILITY;
  if (frameLost) stats.framesLost++;

  const expectedRTT = ANIMATION_DURATION * 2;
  const timeoutMs = expectedRTT * TIMEOUT_FACTOR * 0.9;
  


  if (timeoutId) clearTimeout(timeoutId);
  timeoutId = setTimeout(() => handleTimeout(txId), timeoutMs);

  log(`⏱ Timeout scheduled: ${Math.round(timeoutMs)} ms (expected RTT ≈ ${Math.round(expectedRTT)} ms)`, 'system');

  await animateMessage(currentLine, 'frame-box', `Frame ${senderSeq} [${data}]`, frameLost);
  if (frameLost) { log('Frame lost. Waiting for timeout.', 'system'); updateUIFlags(); return; }

  await receiveFrame({ seq: senderSeq, data, txId }, currentLine);
}

async function receiveFrame(frame, currentLine) {
  log(`RECEIVER ← Frame seq=${frame.seq} '${frame.data}'`, 'recv');
  setReceiverState('Processing frame');
  await delay(200);

  if (frame.seq === receiverExpectedSeq) {
    log(`RECEIVER ✓ Will send ACK ${frame.seq} (for ${frame.data})`, 'ack');
    receiverExpectedSeq = 1 - receiverExpectedSeq;
    stats.successfulDeliveries++;
    await sendAck(frame.seq, currentLine, frame.data);
  } else {
    const lastData = dataToSend[dataIndex - 1] || "previous";
    log(`RECEIVER ⚠ Duplicate — re-ACK last received.`, 'system');
    await sendAck(1 - receiverExpectedSeq, currentLine, lastData);
  }
}

async function sendAck(ackNum, currentLine, forData = '') {
  const ackLine = createMessageLine('ack');
  const ackLost = isNoisy && Math.random() < ACK_LOSS_PROBABILITY;
  if (ackLost) stats.acksLost++;
  const label = forData ? `ACK ${ackNum} [for ${forData}]` : `ACK ${ackNum}`;
  await animateMessage(ackLine, 'ack-box', label, ackLost);
  if (ackLost) { log(`ACK ${ackNum} lost.`, 'lost'); updateUIFlags(); return; }

  receiveAck(ackNum);
}

function receiveAck(ackNum) {
  if (!simulationRunning) return;

  // Ignore old or invalid ACKs
  if (ackNum !== activeTxSeq || currentTxId <= lastAckTxIdHandled) {
    log(`⚠️ Late or invalid ACK ${ackNum} ignored (expected seq=${activeTxSeq})`, 'lost');
    showLateAck(ackNum);
    return;
  }

  if (timeoutExpired) {
    log(`⚠️ ACK ${ackNum} arrived after timeout — ignored.`, 'lost');
    showAckIgnoredInline(ackNum);
    return;
  }
  

  lastAckTxIdHandled = currentTxId;
  clearTimeout(timeoutId);
  timeoutId = null;
  log(`⏹ Timeout cleared — ACK ${ackNum} arrived in time`, 'system');

  waitingForAck = false;
  activeTxSeq = null;
  timeoutExpired = false;

  log(`SENDER ✓ ACK ${ackNum} received`, 'ack');
  senderSeq = 1 - senderSeq;
  dataIndex++;
  updateUIFlags();

  if (dataIndex >= dataToSend.length) return finishSimulation();

  if (stepMode) {
    awaitingNextStep = true;
    nextStepBtn.disabled = false;
    setSenderState('Waiting for Next Step');
  } else {
    setSenderState('Ready');
    setTimeout(() => {
      if (!simulationPaused && simulationRunning && !waitingForAck && activeTxSeq === null)
        sendFrame();
    }, 400);
  }
}

function finishSimulation() {
  simulationRunning = false;
  if (timeoutId) clearTimeout(timeoutId);
  stats.endTime = Date.now();
  const dur = stats.startTime ? ((stats.endTime - stats.startTime) / 1000).toFixed(2) : '0.00';
  
  // Calculate efficiency
  const efficiency = stats.totalTransmissions
    ? ((stats.successfulDeliveries / stats.totalTransmissions) * 100).toFixed(1)
    : '100.0';
  
  // Calculate Goodput
  const goodput = (dur > 0) ? (stats.successfulDeliveries / dur).toFixed(2) : '0';

  const logMsg = `✅ Complete. Successful: ${stats.successfulDeliveries}/${dataToSend.length}. Duration ${dur}s. Efficiency ${efficiency}%`;
  log(logMsg, 'system');
  
  // --- 👇 NEW PART ---
  const perfMsg = `Perf: ${goodput} frames/s | Efficiency: ${efficiency}%`;
  perfSummaryEl.textContent = perfMsg;
  // --- 👆 NEW PART ---

  setSenderState('Done');
  setReceiverState('Done');
  nextStepBtn.disabled = true;
  updateUIFlags();
}

// --- UI Controls ---
startNoiselessBtn.addEventListener('click', () => startSimulation(false));
startNoisyBtn.addEventListener("click", () => startSimulation(true));
pauseBtn.addEventListener("click", () => {
  if (!simulationRunning) return;
  simulationPaused = !simulationPaused;
  pauseBtn.textContent = simulationPaused ? "Resume" : "Pause";
});
resetBtn.addEventListener("click", () => resetState(true));
nextStepBtn.addEventListener("click", async () => {
  if (!simulationRunning || !stepMode) return;
  if (awaitingNextStep) {
    awaitingNextStep = false;
    nextStepBtn.disabled = true;
    await sendFrame();
  }
});
if (darkModeCheckbox)
  darkModeCheckbox.addEventListener("change", () =>
    document.body.classList.toggle("dark", darkModeCheckbox.checked)
  );
if (soundToggle)
  soundToggle.addEventListener("change", () =>
    log(`Sound ${soundToggle.checked ? "ON" : "OFF"}`)
  );
if (downloadLogBtn)
  downloadLogBtn.addEventListener("click", () => {
    const lines = Array.from(logBox.querySelectorAll(".log-entry")).map(
      (n) => n.textContent
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stop_and_wait_log.txt";
    a.click();
    URL.revokeObjectURL(url);
  });

updateUIFlags();
window._sim = { startSimulation, sendFrame, resetState };

const socket = io();
const messageQueue = [];
let queueProcessing = false;
let isRecording = false;
let source;
let mediaStream;
let audioCtx;
let nextStartTime = 0;
let playingSources = new Set(); // New global variable

const form = document.querySelector("form");
const instructions = document.getElementById("instructions");
const sendButton = document.getElementById("send");

// Send button handler
sendButton.onclick = () => {
  if (instructions.value.trim() !== "") {
    socket.emit("contentUpdateText", instructions.value);
    instructions.value = "";
  }
};

// Quick response buttons
document.getElementById("busy").onclick = () => {
  socket.emit("contentUpdateText", "Tell the caller that we cannot take appointments at the moment and ask them to call back later.");
};

document.getElementById("bookAsap").onclick = () => {
  socket.emit("contentUpdateText", "Book an appointment as soon as possible. Ask for their preferred time and date.");
};

document.getElementById("bookNextWeek").onclick = () => {
  socket.emit("contentUpdateText", "Book an appointment for next week. Ask for their preferred day and time.");
};

// New utility functions from audio-orb/utils.ts, adapted for app.js
function encode(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createBlob(data) { // data is Float32Array
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // convert float32 -1 to 1 to int16 -32768 to 32767
    int16[i] = data[i] * 32768;
  }

  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

async function decodeAudioData(
  data, // Uint8Array
  ctx, // AudioContext
  sampleRate,
  numChannels,
) {
  const buffer = ctx.createBuffer(
    numChannels,
    data.length / 2 / numChannels,
    sampleRate,
  );

  const dataInt16 = new Int16Array(data.buffer);
  const l = dataInt16.length;
  const dataFloat32 = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    dataFloat32[i] = dataInt16[i] / 32768.0;
  }
  // Extract interleaved channels
  if (numChannels === 1) { // Assuming mono audio
    buffer.copyToChannel(dataFloat32, 0);
  } else {
    for (let i = 0; i < numChannels; i++) {
      const channel = dataFloat32.filter(
        (_, index) => index % numChannels === i,
      );
      buffer.copyToChannel(channel, i);
    }
  }

  return buffer;
}

socket.on("audioStream", async function (msg) {
  messageQueue.push(decode(msg)); // msg is base64 string, decode it to Uint8Array

  if (!queueProcessing) {
    playAudioData();
  }
});

async function playAudioData() {
  queueProcessing = true;

  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
    nextStartTime = audioCtx.currentTime;
  }

  while (messageQueue.length > 0) {
    const audioDataUint8 = messageQueue.shift(); // This is now Uint8Array

    // Create an AudioBuffer (Assuming 1 channel and 24k sample rate)
    const audioBuffer = await decodeAudioData(audioDataUint8, audioCtx, 24000, 1);

    // Create an AudioBufferSourceNode
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    // Connect the source to the destination (speakers)
    source.connect(audioCtx.destination);

    source.addEventListener('ended', () => {
      playingSources.delete(source);
    });

    // Schedule the audio to play
    if (nextStartTime < audioCtx.currentTime) {
      nextStartTime = audioCtx.currentTime;
    }
    source.start(nextStartTime);

    // Advance the next start time by the duration of the current buffer
    nextStartTime += audioBuffer.duration;
    playingSources.add(source); // Add to playingSources
  }
  queueProcessing = false;
}

document.getElementById("record").onclick = async function (evt) {
  if (isRecording) {
    recordStop();
  } else {
    await recordStart();
  }
};

// Handle interrupted event from the server
socket.on("interrupted", function () {
  console.log("Received interrupted event. Stopping audio playback.");
  for (const source of playingSources.values()) {
    source.stop();
  }
  playingSources.clear();
  messageQueue.length = 0; // Clear the message queue
  nextStartTime = 0; // Reset nextStartTime
  queueProcessing = false; // Ensure queue processing can restart
});

async function recordAudio() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(async (stream) => {
    mediaStream = stream;
    const inputAudioContext = new AudioContext({ sampleRate: 16000 });
    const sourceNode = inputAudioContext.createMediaStreamSource(stream);

    // Add audio analyzer
    const analyser = inputAudioContext.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);
    
    // Start monitoring audio levels
    const micStatus = document.querySelector(".mic-status");
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    function updateMicStatus() {
      if (!isRecording) return;
      
      analyser.getByteFrequencyData(dataArray);
      // Calculate average volume
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      // Scale the volume to a smaller range (0-1.8) to prevent overlap
      const scale = 1 + (average / 100); // Changed from 64 to 100 for smaller max scale
      const opacity = 0.3 + (average / 128);
      
      micStatus.style.transform = `scale(${scale})`;
      micStatus.style.opacity = opacity;
      
      requestAnimationFrame(updateMicStatus);
    }
    
    updateMicStatus();

    const bufferSize = 256;
    const scriptProcessorNode = inputAudioContext.createScriptProcessor(
      bufferSize,
      1,
      1,
    );

    scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
      if (!isRecording) return;

      const inputBuffer = audioProcessingEvent.inputBuffer;
      const pcmData = inputBuffer.getChannelData(0);

      socket.emit("realtimeInput", createBlob(pcmData).data);
    };

    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(inputAudioContext.destination); // Connect to destination to keep it alive

    // Store references for stopping
    source = sourceNode; // Overwrite global 'source' with MediaStreamAudioSourceNode
    audioCtx = inputAudioContext; // Overwrite global 'audioCtx' with inputAudioContext
    window.scriptProcessorNode = scriptProcessorNode; // Store globally to disconnect later
  });
}

async function recordStart() {
  await recordAudio();
  isRecording = true;
  document.getElementById("record").textContent = "Stop Audio";
  document.querySelector(".mic-status").classList.add("active");
}

function recordStop() {
  source?.disconnect();
  window.scriptProcessorNode?.disconnect(); // Disconnect the scriptProcessorNode
  mediaStream?.getTracks().forEach((track) => track.stop());
  isRecording = false;
  document.getElementById("record").textContent = "Start Audio";
  const micStatus = document.querySelector(".mic-status");
  micStatus.classList.remove("active");
  micStatus.style.transform = "scale(1)";
  micStatus.style.opacity = "1";
}

// Recording audio logic reference:
// https://github.com/google-gemini/multimodal-live-api-web-console/blob/main/src/lib/audio-recorder.ts
 
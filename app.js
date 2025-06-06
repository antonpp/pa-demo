const socket = io();
const messageQueue = [];
let queueProcessing = false;
let isRecording = false;
let source;
let mediaStream;
let audioCtx;
let nextStartTime = 0;

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

function base64ToFloat32AudioData(base64String) {
  const byteCharacters = atob(base64String);
  const byteArray = [];

  for (let i = 0; i < byteCharacters.length; i++) {
    byteArray.push(byteCharacters.charCodeAt(i));
  }

  const audioChunks = new Uint8Array(byteArray);

  // Convert Uint8Array (which contains 16-bit PCM) to Float32Array
  const length = audioChunks.length / 2; // 16-bit audio, so 2 bytes per sample
  const float32AudioData = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    // Combine two bytes into one 16-bit signed integer (little-endian)
    let sample = audioChunks[i * 2] | (audioChunks[i * 2 + 1] << 8);
    // Convert from 16-bit PCM to Float32 (range -1 to 1)
    if (sample >= 32768) sample -= 65536;
    float32AudioData[i] = sample / 32768;
  }

  return float32AudioData;
}

socket.on("audioStream", async function (msg) {
  messageQueue.push(base64ToFloat32AudioData(msg));

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
    const audioChunks = messageQueue.shift();

    // Create an AudioBuffer (Assuming 1 channel and 24k sample rate)
    const audioBuffer = audioCtx.createBuffer(1, audioChunks.length, 24000);
    audioBuffer.copyToChannel(audioChunks, 0);

    // Create an AudioBufferSourceNode
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    // Connect the source to the destination (speakers)
    source.connect(audioCtx.destination);

    // Schedule the audio to play
    if (nextStartTime < audioCtx.currentTime) {
      nextStartTime = audioCtx.currentTime;
    }
    source.start(nextStartTime);

    // Advance the next start time by the duration of the current buffer
    nextStartTime += audioBuffer.duration;
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

async function recordAudio() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(async (stream) => {
    mediaStream = stream;
    const audioContext = new AudioContext({ sampleRate: 16000 });
    source = audioContext.createMediaStreamSource(stream);

    // Add audio analyzer
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
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

    const workletName = "audio-recorder-worklet";

    const AudioRecordingWorklet = `
      class AudioProcessingWorklet extends AudioWorkletProcessor {
        // send and clear buffer every 2048 samples,
        // which at 16khz is about 8 times a second
        buffer = new Int16Array(2048);

        // current write index
        bufferWriteIndex = 0;

        constructor() {
          super();
          this.hasAudio = false;
        }

        /**
         * @param inputs Float32Array[][] [input#][channel#][sample#] so to access first inputs 1st channel inputs[0][0]
         * @param outputs Float32Array[][]
         */
        process(inputs) {
          if (inputs[0].length) {
            const channel0 = inputs[0][0];
            this.processChunk(channel0);
          }
          return true;
        }

        sendAndClearBuffer(){
          this.port.postMessage({
            event: "chunk",
            data: {
              int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
            },
          });
          this.bufferWriteIndex = 0;
        }

        processChunk(float32Array) {
          const l = float32Array.length;

          for (let i = 0; i < l; i++) {
            // convert float32 -1 to 1 to int16 -32768 to 32767
            const int16Value = float32Array[i] * 32768;
            this.buffer[this.bufferWriteIndex++] = int16Value;
            if(this.bufferWriteIndex >= this.buffer.length) {
              this.sendAndClearBuffer();
            }
          }

          if(this.bufferWriteIndex >= this.buffer.length) {
            this.sendAndClearBuffer();
          }
        }
      }`;

    const script = new Blob(
      [`registerProcessor("${workletName}", ${AudioRecordingWorklet})`],
      {
        type: "application/javascript",
      },
    );

    const src = URL.createObjectURL(script);

    await audioContext.audioWorklet.addModule(src);
    const recordingWorklet = new AudioWorkletNode(audioContext, workletName);

    recordingWorklet.port.onmessage = (ev) => {
      // worklet processes recording floats and messages converted buffer
      const arrayBuffer = ev.data.data.int16arrayBuffer;

      if (arrayBuffer) {
        const arrayBufferString = arrayBufferToBase64(arrayBuffer);
        socket.emit("realtimeInput", arrayBufferString);
      }
    };
    source.connect(recordingWorklet);
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
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
} 
let audioCtx, streamSource;
// 独立音频实验，主流程只初始化 AudioContext，addWhiteDot 的调用已被注释。

export const initAudio = () => {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
};

export function addWhiteDot(video) {
  // 尝试生成两秒双声道白噪声；但 createMediaElementSource 返回的是媒体元素源节点，
  // 给它赋 buffer 不会播放生成的噪声，需要 AudioBufferSourceNode 才能使用该缓冲区。
  const channels = 2;
  const frameCount = audioCtx.sampleRate * 2.0;
  const myArrayBuffer = audioCtx.createBuffer(
    channels,
    frameCount,
    audioCtx.sampleRate
  );
  streamSource = audioCtx.createMediaElementSource(video);
  console.log(streamSource.buffer);
  // Fill the buffer with white noise;
  // just random values between -1.0 and 1.0
  for (var channel = 0; channel < channels; channel++) {
    // This gives us the actual array that contains the data
    var nowBuffering = myArrayBuffer.getChannelData(channel);
    for (var i = 0; i < frameCount; i++) {
      // Math.random() is in [0; 1.0]
      // audio needs to be in [-1.0; 1.0]
      nowBuffering[i] = Math.random() * 2 - 1;
    }
  }

  // Get an AudioBufferSourceNode.
  // This is the AudioNode to use when we want to play an AudioBuffer
  // var source = audioCtx.createBufferSource();

  // set the buffer in the AudioBufferSourceNode
  streamSource.buffer = myArrayBuffer;

  // connect the AudioBufferSourceNode to the
  // destination so we can hear the sound
  streamSource.connect(audioCtx.destination);

  // start the source playing
  // streamSource.start();
}

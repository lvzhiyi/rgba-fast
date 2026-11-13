/** 可能暴露帧流处理器的全局对象。主线程和 Worker 分别检查构造器是否存在。 */
export type TrackProcessorScope = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
    readable: ReadableStream<VideoFrame>;
  };
};

/** 可捕获视频轨道的 video 元素，兼容标准方法和浏览器前缀方法。 */
export type CaptureVideoElement = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

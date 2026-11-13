import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { FrameConfig } from './worker-protocol.ts';

/** 固定帧裁剪和画布绘制使用的像素宽高。 */
type FrameSize = Pick<FrameConfig, 'width' | 'height'>;
/** 可保存并反复重绘的静态来源，包括图片和截帧画布。 */
type StillImage = HTMLImageElement | HTMLCanvasElement;
/** 可绘制到固定帧画布的来源，涵盖静态图和视频当前画面。 */
type FrameSource = StillImage | HTMLVideoElement;

// 保存基准测试的输入。source 用于变更分辨率时重绘，fixedFrame 保存已裁剪的 RGBA 像素。
export function useFixedFrame(inputCanvas: RefObject<HTMLCanvasElement | null>, outputCanvas: RefObject<HTMLCanvasElement | null>) {
  const source = useRef<StillImage | null>(null);
  const fixedFrame = useRef<ImageData | null>(null);
  // 每次重绘固定帧递增一次版本号，结果导出时用来追溯输入。
  const revision = useRef(0);
  const [sourceName, setSourceName] = useState('示例图片');
  const [hasFrame, setHasFrame] = useState(false);

  // 按目标尺寸等比放大并居中裁切，同时更新两个静态画布。
  const draw = useCallback((image: FrameSource, { width, height }: FrameSize) => {
    const input = inputCanvas.current!;
    const output = outputCanvas.current!;
    input.width = output.width = width;
    input.height = output.height = height;
    // 提示浏览器输入画布会频繁读回像素，实时主线程管线也使用这个上下文。
    const context = input.getContext('2d', { willReadFrequently: true })!;
    const sourceWidth = ('videoWidth' in image && image.videoWidth) || ('naturalWidth' in image && image.naturalWidth) || image.width;
    const sourceHeight = ('videoHeight' in image && image.videoHeight) || ('naturalHeight' in image && image.naturalHeight) || image.height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const scaledWidth = sourceWidth * scale;
    const scaledHeight = sourceHeight * scale;
    context.drawImage(image, (width - scaledWidth) / 2, (height - scaledHeight) / 2, scaledWidth, scaledHeight);
    fixedFrame.current = context.getImageData(0, 0, width, height);
    output.getContext('2d')!.putImageData(fixedFrame.current, 0, 0);
    revision.current++;
    setHasFrame(true);
    return fixedFrame.current;
  }, [inputCanvas, outputCanvas]);

  // 替换示例图或上传图，更新固定帧及来源名称。
  const setImage = useCallback((image: StillImage, name: string, config: FrameSize) => {
    source.current = image;
    draw(image, config);
    setSourceName(name);
  }, [draw]);

  // 从保存的图片或截图重绘，避免拿实时管线刚写过的画布作为输入。
  function resize(config: FrameSize) {
    if (source.current) draw(source.current, config);
  }

  // 同步把当前视频画面保存成独立截图，供后续缩放和重复测试。
  function capture(video: HTMLVideoElement, config: FrameSize) {
    const name = video.srcObject ? '摄像头截帧' : `视频截帧 ${video.currentTime.toFixed(2)}s`;
    const pixels = draw(video, config);
    const snapshot = document.createElement('canvas');
    snapshot.width = config.width;
    snapshot.height = config.height;
    snapshot.getContext('2d')!.putImageData(pixels, 0, 0);
    source.current = snapshot;
    setSourceName(name);
    return name;
  }

  return { fixedFrame, revision, sourceName, hasFrame, setImage, resize, capture };
}

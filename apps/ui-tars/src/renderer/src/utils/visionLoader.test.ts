import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getLocalWasmPath,
  getLocalModelPath,
  resolveVisionWasmFileset,
  createHandLandmarkerWithFallback,
  createFaceLandmarkerWithFallback,
  createGestureRecognizerWithFallback,
  CDN_WASM_PATH,
} from './visionLoader';
import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
  GestureRecognizer,
} from '@mediapipe/tasks-vision';

vi.mock('@mediapipe/tasks-vision', () => {
  return {
    FilesetResolver: {
      forVisionTasks: vi.fn(),
    },
    HandLandmarker: {
      createFromOptions: vi.fn(),
    },
    FaceLandmarker: {
      createFromOptions: vi.fn(),
    },
    GestureRecognizer: {
      createFromOptions: vi.fn(),
    },
  };
});

describe('Vision Loader - Path Resolution', () => {
  it('resolves default local wasm path', () => {
    expect(getLocalWasmPath()).toBe('/wasm');
  });

  it('formats model asset path properly', () => {
    expect(getLocalModelPath('models/hand_landmarker.task')).toBe(
      '/models/hand_landmarker.task',
    );
    expect(getLocalModelPath('/models/face_landmarker.task')).toBe(
      '/models/face_landmarker.task',
    );
  });
});

describe('Vision Loader - WASM Fileset Resolution with Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves from local bundle on primary attempt', async () => {
    const mockFileset = { wasmLoaderPath: '/wasm/vision.js' };
    vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValueOnce(
      mockFileset as any,
    );

    const logs: string[] = [];
    const result = await resolveVisionWasmFileset((msg) => logs.push(msg));

    expect(result.source).toBe('local');
    expect(result.fileset).toBe(mockFileset);
    expect(FilesetResolver.forVisionTasks).toHaveBeenCalledWith('/wasm');
    expect(FilesetResolver.forVisionTasks).toHaveBeenCalledTimes(1);
  });

  it('falls back to CDN when local WASM loading fails', async () => {
    const mockCdnFileset = { wasmLoaderPath: `${CDN_WASM_PATH}/vision.js` };
    vi.mocked(FilesetResolver.forVisionTasks)
      .mockRejectedValueOnce(new Error('Local file not found'))
      .mockResolvedValueOnce(mockCdnFileset as any);

    const logs: string[] = [];
    const result = await resolveVisionWasmFileset((msg) => logs.push(msg));

    expect(result.source).toBe('cdn');
    expect(result.fileset).toBe(mockCdnFileset);
    expect(FilesetResolver.forVisionTasks).toHaveBeenNthCalledWith(1, '/wasm');
    expect(FilesetResolver.forVisionTasks).toHaveBeenNthCalledWith(
      2,
      CDN_WASM_PATH,
    );
  });

  it('throws descriptive error if both local bundle and CDN fail', async () => {
    vi.mocked(FilesetResolver.forVisionTasks)
      .mockRejectedValueOnce(new Error('Network offline (local)'))
      .mockRejectedValueOnce(new Error('CDN unreachable (offline)'));

    await expect(resolveVisionWasmFileset()).rejects.toThrow(
      /MediaPipe WASM loading failed for both local bundle and CDN/,
    );
  });
});

describe('Vision Loader - Hardware Acceleration Delegate Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates HandLandmarker with GPU delegate when supported', async () => {
    const mockLandmarker = { detectForVideo: vi.fn(), close: vi.fn() };
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce(
      mockLandmarker as any,
    );

    const result = await createHandLandmarkerWithFallback({} as any);
    expect(result.delegate).toBe('GPU');
    expect(result.landmarker).toBe(mockLandmarker);
    expect(HandLandmarker.createFromOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseOptions: expect.objectContaining({ delegate: 'GPU' }),
      }),
    );
  });

  it('falls back HandLandmarker to CPU delegate when GPU fails', async () => {
    const mockLandmarker = { detectForVideo: vi.fn(), close: vi.fn() };
    vi.mocked(HandLandmarker.createFromOptions)
      .mockRejectedValueOnce(new Error('WebGL not supported'))
      .mockResolvedValueOnce(mockLandmarker as any);

    const logs: string[] = [];
    const result = await createHandLandmarkerWithFallback(
      {} as any,
      {},
      (msg) => logs.push(msg),
    );

    expect(result.delegate).toBe('CPU');
    expect(result.landmarker).toBe(mockLandmarker);
    expect(HandLandmarker.createFromOptions).toHaveBeenCalledTimes(2);
    expect(HandLandmarker.createFromOptions).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        baseOptions: expect.objectContaining({ delegate: 'CPU' }),
      }),
    );
  });

  it('creates FaceLandmarker with GPU delegate and falls back to CPU on error', async () => {
    const mockLandmarker = { detectForVideo: vi.fn(), close: vi.fn() };
    vi.mocked(FaceLandmarker.createFromOptions)
      .mockRejectedValueOnce(new Error('GPU context lost'))
      .mockResolvedValueOnce(mockLandmarker as any);

    const result = await createFaceLandmarkerWithFallback({} as any);
    expect(result.delegate).toBe('CPU');
    expect(result.landmarker).toBe(mockLandmarker);
    expect(FaceLandmarker.createFromOptions).toHaveBeenCalledTimes(2);
  });

  it('creates GestureRecognizer with fallback to CPU delegate and available models', async () => {
    const mockRecognizer = { recognizeForVideo: vi.fn(), close: vi.fn() };
    // Fails with custom model on GPU & CPU, then succeeds on standard model with GPU
    vi.mocked(GestureRecognizer.createFromOptions)
      .mockRejectedValueOnce(new Error('Custom model 404 GPU'))
      .mockRejectedValueOnce(new Error('Custom model 404 CPU'))
      .mockResolvedValueOnce(mockRecognizer as any);

    const result = await createGestureRecognizerWithFallback(
      {} as any,
      '/models/nonexistent_custom.task',
    );
    expect(result.recognizer).toBe(mockRecognizer);
    expect(result.delegate).toBe('GPU');
  });
});

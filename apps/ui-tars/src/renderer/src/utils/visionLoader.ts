import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
  GestureRecognizer,
} from '@mediapipe/tasks-vision';

export const CDN_WASM_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm';
export const CDN_GESTURE_MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

export interface VisionEngineStatus {
  state: 'uninitialized' | 'loading' | 'ready' | 'error';
  source?: 'local' | 'cdn';
  delegate?: 'GPU' | 'CPU';
  error?: string | null;
}

/**
 * Returns the best local URL or path for locally bundled WASM assets.
 */
export function getLocalWasmPath(): string {
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
    try {
      return new URL('./wasm', window.location.href).href;
    } catch {
      return '/wasm';
    }
  }
  return '/wasm';
}

/**
 * Returns the best local URL or path for a model asset file.
 */
export function getLocalModelPath(modelName: string): string {
  const cleanName = modelName.startsWith('/') ? modelName.slice(1) : modelName;
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
    try {
      return new URL(`./${cleanName}`, window.location.href).href;
    } catch {
      return `/${cleanName}`;
    }
  }
  return `/${cleanName}`;
}

/**
 * Resolves the MediaPipe Vision WasmFileset with fallback:
 * 1. Locally bundled assets (/wasm)
 * 2. External CDN fallback if local fails
 */
export async function resolveVisionWasmFileset(
  onLog?: (msg: string) => void,
): Promise<{ fileset: any; source: 'local' | 'cdn' }> {
  const log = (msg: string) => {
    console.info(`[VisionEngine] ${msg}`);
    onLog?.(msg);
  };

  const localPath = getLocalWasmPath();
  log(`Attempting to load MediaPipe WASM from local bundle (${localPath})...`);

  try {
    const fileset = await FilesetResolver.forVisionTasks(localPath);
    log(`MediaPipe WASM fileset resolved successfully from local bundle.`);
    return { fileset, source: 'local' };
  } catch (localError: any) {
    console.warn(
      `[VisionEngine] Local WASM resolution failed: ${localError?.message || localError}. Falling back to CDN...`,
    );
    try {
      const fileset = await FilesetResolver.forVisionTasks(CDN_WASM_PATH);
      log(
        `MediaPipe WASM fileset resolved from external CDN (${CDN_WASM_PATH}).`,
      );
      return { fileset, source: 'cdn' };
    } catch (cdnError: any) {
      const errorMsg = `MediaPipe WASM loading failed for both local bundle and CDN: ${cdnError?.message || cdnError}`;
      console.error(`[VisionEngine] ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }
}

/**
 * Instantiates HandLandmarker with delegate fallback (GPU -> CPU).
 */
export async function createHandLandmarkerWithFallback(
  visionFileset: any,
  options: Record<string, any> = {},
  onLog?: (msg: string) => void,
): Promise<{ landmarker: HandLandmarker; delegate: 'GPU' | 'CPU' }> {
  const modelPath =
    options.modelAssetPath || getLocalModelPath('models/hand_landmarker.task');
  const baseConfig = {
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    ...options,
  };

  try {
    onLog?.('[VisionEngine] Initializing HandLandmarker with GPU delegate...');
    const landmarker = await HandLandmarker.createFromOptions(visionFileset, {
      ...baseConfig,
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'GPU',
      },
    });
    return { landmarker, delegate: 'GPU' };
  } catch (gpuError: any) {
    console.warn(
      '[VisionEngine] HandLandmarker GPU delegate failed, falling back to CPU:',
      gpuError,
    );
    onLog?.('[VisionEngine] GPU delegate failed, falling back to CPU...');
    const landmarker = await HandLandmarker.createFromOptions(visionFileset, {
      ...baseConfig,
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
    });
    return { landmarker, delegate: 'CPU' };
  }
}

/**
 * Instantiates FaceLandmarker with delegate fallback (GPU -> CPU).
 */
export async function createFaceLandmarkerWithFallback(
  visionFileset: any,
  options: Record<string, any> = {},
  onLog?: (msg: string) => void,
): Promise<{ landmarker: FaceLandmarker; delegate: 'GPU' | 'CPU' }> {
  const modelPath =
    options.modelAssetPath || getLocalModelPath('models/face_landmarker.task');
  const baseConfig = {
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    ...options,
  };

  try {
    onLog?.('[VisionEngine] Initializing FaceLandmarker with GPU delegate...');
    const landmarker = await FaceLandmarker.createFromOptions(visionFileset, {
      ...baseConfig,
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'GPU',
      },
    });
    return { landmarker, delegate: 'GPU' };
  } catch (gpuError: any) {
    console.warn(
      '[VisionEngine] FaceLandmarker GPU delegate failed, falling back to CPU:',
      gpuError,
    );
    onLog?.('[VisionEngine] GPU delegate failed, falling back to CPU...');
    const landmarker = await FaceLandmarker.createFromOptions(visionFileset, {
      ...baseConfig,
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
    });
    return { landmarker, delegate: 'CPU' };
  }
}

/**
 * Instantiates GestureRecognizer with delegate and model fallback.
 */
export async function createGestureRecognizerWithFallback(
  visionFileset: any,
  preferredModelPath?: string,
  onLog?: (msg: string) => void,
): Promise<{
  recognizer: GestureRecognizer;
  delegate: 'GPU' | 'CPU';
  modelPath: string;
}> {
  const modelCandidates = [
    preferredModelPath,
    getLocalModelPath('models/gesture_recognizer.task'),
    getLocalModelPath('models/custom_gestures.task'),
    CDN_GESTURE_MODEL_PATH,
  ].filter(Boolean) as string[];

  let lastError: any = null;

  for (const modelPath of modelCandidates) {
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        onLog?.(
          `[VisionEngine] Attempting GestureRecognizer with model: ${modelPath} (delegate: ${delegate})`,
        );
        const recognizer = await GestureRecognizer.createFromOptions(
          visionFileset,
          {
            baseOptions: {
              modelAssetPath: modelPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: 2,
          },
        );
        return { recognizer, delegate, modelPath };
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[VisionEngine] GestureRecognizer creation attempt failed (${modelPath}, ${delegate}):`,
          err?.message || err,
        );
      }
    }
  }

  throw new Error(
    `Failed to initialize GestureRecognizer across all models and delegates: ${lastError?.message || lastError}`,
  );
}

export interface RFInferenceResult {
  prediction: string;
  confidence: number;
  probabilities: Record<string, number>;
  isRecognized: boolean;
}

export interface RFModelTree {
  children_left: number[];
  children_right: number[];
  feature: number[];
  threshold: number[];
  value: number[][][]; // shape: [node][0][classIdx]
}

export interface RFModel {
  classes: string[];
  trees: RFModelTree[];
}

/**
 * Validates threshold bounds. Ensures threshold is a valid finite number in [0.0, 1.0].
 */
export function validateThreshold(threshold?: number, defaultThreshold = 0.50): number {
  if (threshold === undefined || threshold === null || !Number.isFinite(threshold)) {
    return defaultThreshold;
  }
  return Math.min(1.0, Math.max(0.0, threshold));
}

/**
 * Validates whether the feature array has usable non-zero landmark features.
 */
export function validateFeatures(features?: number[]): boolean {
  if (!features || !Array.isArray(features) || features.length === 0) {
    return false;
  }
  return features.some((f) => Number.isFinite(f) && f !== 0.0);
}

/**
 * Extracts 210 scale-invariant pairwise landmark distance features from timeline hand data.
 */
export function extractFeaturesJS(
  timelineData: Array<{ type?: string; data?: Array<{ x?: number; y?: number; z?: number }>; [key: string]: unknown }>,
): number[] {
  if (!Array.isArray(timelineData) || timelineData.length === 0) {
    return new Array(210).fill(0.0);
  }

  const handStates = timelineData
    .filter((item) => item && item.type === 'hand' && item.data)
    .map((item) => item.data);

  if (handStates.length === 0) {
    return new Array(210).fill(0.0);
  }

  const avgLandmarks: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 21; i++) {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let count = 0;
    for (const frame of handStates) {
      if (frame && frame.length === 21 && frame[i]) {
        sumX += frame[i].x || 0;
        sumY += frame[i].y || 0;
        sumZ += frame[i].z || 0;
        count++;
      }
    }
    if (count > 0) {
      avgLandmarks.push({ x: sumX / count, y: sumY / count, z: sumZ / count });
    } else {
      avgLandmarks.push({ x: 0, y: 0, z: 0 });
    }
  }

  if (avgLandmarks.length === 21 && avgLandmarks.some((lm) => lm.x !== 0 || lm.y !== 0 || lm.z !== 0)) {
    const dists: number[] = [];
    for (let i = 0; i < 21; i++) {
      for (let j = i + 1; j < 21; j++) {
        const dx = avgLandmarks[i].x - avgLandmarks[j].x;
        const dy = avgLandmarks[i].y - avgLandmarks[j].y;
        const dz = avgLandmarks[i].z - avgLandmarks[j].z;
        dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    const maxDist = Math.max(...dists, 1.0);
    return dists.map((d) => d / maxDist);
  }

  return new Array(210).fill(0.0);
}

/**
 * Predicts gesture label and confidence using continuous class probability aggregation (soft voting)
 * across Random Forest decision trees.
 *
 * This avoids hard majority voting where leaf nodes with skewed argmax classifications artificially
 * inflate confidence scores above the 0.50 threshold on out-of-distribution movements.
 */
export function predictRF(
  features: number[],
  model: RFModel | Record<string, unknown> | null | undefined,
  threshold: number = 0.50,
): RFInferenceResult {
  const defaultThreshold = validateThreshold(threshold, 0.50);

  if (
    !model ||
    !Array.isArray(model.trees) ||
    model.trees.length === 0 ||
    !Array.isArray(model.classes) ||
    model.classes.length === 0 ||
    !validateFeatures(features)
  ) {
    return {
      prediction: 'none',
      confidence: 0.0,
      probabilities: {},
      isRecognized: false,
    };
  }

  const numClasses = model.classes.length;
  const classProbSums = new Array(numClasses).fill(0);
  const numTrees = model.trees.length;

  for (const tree of model.trees) {
    let node = 0;
    // -1 indicates a leaf node in scikit-learn decision trees
    while (
      tree.children_left &&
      tree.children_left[node] !== undefined &&
      tree.children_left[node] !== -1 &&
      tree.children_left[node] !== tree.children_right[node]
    ) {
      const featIdx = tree.feature[node];
      const featVal =
        features[featIdx] !== undefined && Number.isFinite(features[featIdx])
          ? features[featIdx]
          : 0.0;

      if (featVal <= tree.threshold[node]) {
        node = tree.children_left[node];
      } else {
        node = tree.children_right[node];
      }
    }

    const values = tree.value?.[node]?.[0];
    if (values && Array.isArray(values) && values.length === numClasses) {
      let leafSum = 0;
      for (let i = 0; i < numClasses; i++) {
        const val = values[i];
        if (Number.isFinite(val) && val > 0) {
          leafSum += val;
        }
      }

      if (leafSum > 0) {
        for (let i = 0; i < numClasses; i++) {
          const val = values[i];
          const validVal = Number.isFinite(val) && val > 0 ? val : 0;
          classProbSums[i] += validVal / leafSum;
        }
      } else {
        // Degenerate leaf: distribute uniformly
        for (let i = 0; i < numClasses; i++) {
          classProbSums[i] += 1 / numClasses;
        }
      }
    } else {
      // Degenerate tree leaf structure: distribute uniformly
      for (let i = 0; i < numClasses; i++) {
        classProbSums[i] += 1 / numClasses;
      }
    }
  }

  const probabilities: Record<string, number> = {};
  let bestClassIdx = 0;
  let maxAvgProb = -1;

  for (let i = 0; i < numClasses; i++) {
    const avgProb = classProbSums[i] / numTrees;
    probabilities[model.classes[i]] = avgProb;
    if (avgProb > maxAvgProb) {
      maxAvgProb = avgProb;
      bestClassIdx = i;
    }
  }

  const confidence = Math.max(0.0, maxAvgProb);
  const prediction = model.classes[bestClassIdx] || 'none';
  const isRecognized =
    confidence >= defaultThreshold &&
    prediction !== 'none' &&
    prediction !== 'None';

  return {
    prediction,
    confidence,
    probabilities,
    isRecognized,
  };
}

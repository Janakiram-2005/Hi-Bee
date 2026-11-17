/**
 * Feature extraction and Random Forest inference for MediaPipe hand landmarks.
 * Preserves 3D hand geometry and temporal trajectory dynamics (multi-phase deltas,
 * velocities, path lengths, directional unit vectors).
 */

export const extractFeaturesJS = (timelineData: any[]): number[] => {
  const handStates = timelineData
    .filter((item) => item && item.type === 'hand' && item.data)
    .map((item) => item.data);
  const validFrames = handStates.filter(
    (frame: any) => Array.isArray(frame) && frame.length === 21,
  );

  const TOTAL_FEATURES = 417;
  if (validFrames.length === 0) {
    return new Array(TOTAL_FEATURES).fill(0.0);
  }

  const numFrames = validFrames.length;

  // 1. Multi-phase temporal slicing: Start (0..33%), Mid (33..66%), End (66..100%)
  const p1End = Math.max(1, Math.floor(numFrames / 3));
  const p2End = Math.max(p1End + 1, Math.floor((2 * numFrames) / 3));

  const phaseStart = validFrames.slice(0, p1End);
  const phaseMid =
    validFrames.slice(p1End, p2End).length > 0
      ? validFrames.slice(p1End, p2End)
      : phaseStart;
  const phaseEnd =
    validFrames.slice(p2End).length > 0 ? validFrames.slice(p2End) : phaseMid;

  const avgLandmarksPhase = (frames: any[]) => {
    const avg: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 21; i++) {
      let sumX = 0,
        sumY = 0,
        sumZ = 0;
      for (const f of frames) {
        sumX += f[i].x;
        sumY += f[i].y;
        sumZ += f[i].z;
      }
      avg.push({
        x: frames.length > 0 ? sumX / frames.length : 0.0,
        y: frames.length > 0 ? sumY / frames.length : 0.0,
        z: frames.length > 0 ? sumZ / frames.length : 0.0,
      });
    }
    return avg;
  };

  const lmAll = avgLandmarksPhase(validFrames);
  const lmStart = avgLandmarksPhase(phaseStart);
  const lmMid = avgLandmarksPhase(phaseMid);
  const lmEnd = avgLandmarksPhase(phaseEnd);

  const features: number[] = [];

  // 2. Hand shape: 210 pairwise distances of overall average pose (scale-invariant)
  const dists: number[] = [];
  for (let i = 0; i < 21; i++) {
    for (let j = i + 1; j < 21; j++) {
      const dx = lmAll[i].x - lmAll[j].x;
      const dy = lmAll[i].y - lmAll[j].y;
      const dz = lmAll[i].z - lmAll[j].z;
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }

  let maxDist = dists.length > 0 ? Math.max(...dists) : 1.0;
  if (maxDist === 0) maxDist = 1.0;
  for (const d of dists) {
    features.push(d / maxDist);
  }

  // 3. Temporal trajectory displacement: Start -> End (21 * 3 = 63 features)
  for (let i = 0; i < 21; i++) {
    features.push(lmEnd[i].x - lmStart[i].x);
    features.push(lmEnd[i].y - lmStart[i].y);
    features.push(lmEnd[i].z - lmStart[i].z);
  }

  // 4. Intermediate trajectory displacement: Start -> Mid (21 * 3 = 63 features)
  for (let i = 0; i < 21; i++) {
    features.push(lmMid[i].x - lmStart[i].x);
    features.push(lmMid[i].y - lmStart[i].y);
    features.push(lmMid[i].z - lmStart[i].z);
  }

  // 5. Intermediate trajectory displacement: Mid -> End (21 * 3 = 63 features)
  for (let i = 0; i < 21; i++) {
    features.push(lmEnd[i].x - lmMid[i].x);
    features.push(lmEnd[i].y - lmMid[i].y);
    features.push(lmEnd[i].z - lmMid[i].z);
  }

  // 6. Motion dynamics & trajectory metrics (18 features):
  // Key landmark indices: 0 (wrist), 4 (thumb tip), 8 (index tip), 12 (middle tip), 20 (pinky tip)
  const keyIndices = [0, 4, 8, 12, 20];

  // (a) Cumulative path length per key landmark (5 features)
  const pathLengths: number[] = [];
  for (const kidx of keyIndices) {
    let plen = 0.0;
    for (let fIdx = 1; fIdx < numFrames; fIdx++) {
      const pPrev = validFrames[fIdx - 1][kidx];
      const pCurr = validFrames[fIdx][kidx];
      plen += Math.sqrt(
        Math.pow(pCurr.x - pPrev.x, 2) +
          Math.pow(pCurr.y - pPrev.y, 2) +
          Math.pow(pCurr.z - pPrev.z, 2),
      );
    }
    pathLengths.push(plen);
  }
  features.push(...pathLengths);

  // (b) Net displacement magnitude per key landmark (5 features)
  const netDisps: number[] = [];
  for (const kidx of keyIndices) {
    const dx = lmEnd[kidx].x - lmStart[kidx].x;
    const dy = lmEnd[kidx].y - lmStart[kidx].y;
    const dz = lmEnd[kidx].z - lmStart[kidx].z;
    netDisps.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  features.push(...netDisps);

  // (c) Directional unit vector for wrist (0) and index tip (8) (6 features)
  for (const kidx of [0, 8]) {
    const dx = lmEnd[kidx].x - lmStart[kidx].x;
    const dy = lmEnd[kidx].y - lmStart[kidx].y;
    const dz = lmEnd[kidx].z - lmStart[kidx].z;
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (mag > 1e-6) {
      features.push(dx / mag, dy / mag, dz / mag);
    } else {
      features.push(0.0, 0.0, 0.0);
    }
  }

  // (d) Linearity ratio (net displacement / path length) for wrist and index tip (2 features)
  const wristPlen = pathLengths[0];
  const wristNdisp = netDisps[0];
  features.push(wristPlen > 1e-6 ? Math.min(1.0, wristNdisp / wristPlen) : 0.0);

  const indexPlen = pathLengths[2];
  const indexNdisp = netDisps[2];
  features.push(indexPlen > 1e-6 ? Math.min(1.0, indexNdisp / indexPlen) : 0.0);

  return features;
};

export const predictRF = (
  features: number[],
  model: any,
): { prediction: string; confidence: number } => {
  if (!model || !model.trees || features.every((f) => f === 0.0)) {
    return { prediction: 'none', confidence: 0.0 };
  }

  const classVotes = new Array(model.classes.length).fill(0);

  for (const tree of model.trees) {
    let node = 0;
    while (
      tree.children_left[node] !== -1 &&
      tree.children_left[node] !== tree.children_right[node]
    ) {
      if (features[tree.feature[node]] <= tree.threshold[node]) {
        node = tree.children_left[node];
      } else {
        node = tree.children_right[node];
      }
    }
    const values = tree.value[node][0];
    let maxIdx = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[maxIdx]) maxIdx = i;
    }
    classVotes[maxIdx]++;
  }

  let bestClassIdx = 0;
  for (let i = 1; i < classVotes.length; i++) {
    if (classVotes[i] > classVotes[bestClassIdx]) bestClassIdx = i;
  }

  return {
    prediction: model.classes[bestClassIdx],
    confidence: classVotes[bestClassIdx] / model.trees.length,
  };
};

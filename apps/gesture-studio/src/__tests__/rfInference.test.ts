import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  predictRF,
  extractFeaturesJS,
  validateThreshold,
  validateFeatures,
} from '../utils/rfInference';
import type { RFModel } from '../utils/rfInference';

describe('Random Forest Soft Voting & Gesture Probability Aggregation', () => {
  // Test 1: Hard voting would inflate confidence > 0.50 on OOD inputs, while soft voting correctly deflates it below 0.50
  it('corrects hard voting inflated confidence on out-of-distribution movements', () => {
    // 10 trees, 4 classes
    const classes = ['danger', 'i', 'love', 'you'];

    // In 6 out of 10 trees, class 0 has the highest leaf count (30%), but low actual probability:
    // leaf values: [0.30, 0.25, 0.25, 0.20] -> hard voting: argmax = 0 ('danger')
    // In 4 out of 10 trees, class 1 has [0.10, 0.35, 0.30, 0.25] -> hard voting: argmax = 1 ('i')
    // Under hard voting: 'danger' gets 6/10 = 60% confidence (> 0.50 threshold -> spurious trigger!)
    // Under soft voting: 'danger' has (6 * 0.30 + 4 * 0.10) / 10 = 22%
    //                   'i' has (6 * 0.25 + 4 * 0.35) / 10 = 29%
    //                   'love' has (6 * 0.25 + 4 * 0.30) / 10 = 27%
    //                   'you' has (6 * 0.20 + 4 * 0.25) / 10 = 22%
    // Max probability is 29% ('i'), which is strictly below 0.50 -> NOT recognized, preventing false trigger!
    const trees = [];
    for (let i = 0; i < 6; i++) {
      trees.push({
        children_left: [-1],
        children_right: [-1],
        feature: [-2],
        threshold: [-2.0],
        value: [[[0.30, 0.25, 0.25, 0.20]]],
      });
    }
    for (let i = 0; i < 4; i++) {
      trees.push({
        children_left: [-1],
        children_right: [-1],
        feature: [-2],
        threshold: [-2.0],
        value: [[[0.10, 0.35, 0.30, 0.25]]],
      });
    }

    const model: RFModel = { classes, trees };
    const dummyFeatures = new Array(210).fill(0.5);

    const result = predictRF(dummyFeatures, model, 0.50);

    // Continuous aggregated confidence should be 0.29 (29%), NOT 0.60 (60%)
    expect(result.confidence).toBeCloseTo(0.29, 2);
    expect(result.probabilities['danger']).toBeCloseTo(0.22, 2);
    expect(result.probabilities['i']).toBeCloseTo(0.29, 2);
    expect(result.probabilities['love']).toBeCloseTo(0.27, 2);
    expect(result.probabilities['you']).toBeCloseTo(0.22, 2);

    // Crucially: it must NOT be recognized because confidence (29%) < threshold (50%)
    expect(result.isRecognized).toBe(false);
  });

  it('correctly recognizes in-distribution gestures with high leaf probabilities', () => {
    const classes = ['danger', 'i', 'love', 'you'];
    const trees = [];
    for (let i = 0; i < 10; i++) {
      trees.push({
        children_left: [-1],
        children_right: [-1],
        feature: [-2],
        threshold: [-2.0],
        value: [[[0.05, 0.05, 0.85, 0.05]]],
      });
    }

    const model: RFModel = { classes, trees };
    const features = new Array(210).fill(0.4);

    const result = predictRF(features, model, 0.50);

    expect(result.prediction).toBe('love');
    expect(result.confidence).toBeCloseTo(0.85, 2);
    expect(result.isRecognized).toBe(true);
  });

  describe('Threshold boundary validation', () => {
    const classes = ['gesture_a', 'gesture_b'];
    const createModelWithProb = (pA: number, pB: number): RFModel => ({
      classes,
      trees: [
        {
          children_left: [-1],
          children_right: [-1],
          feature: [-2],
          threshold: [-2.0],
          value: [[[pA, pB]]],
        },
      ],
    });

    const features = new Array(210).fill(0.2);

    it('recognizes gesture when confidence exactly meets the 0.50 threshold', () => {
      const model = createModelWithProb(0.50, 0.50);
      const result = predictRF(features, model, 0.50);
      expect(result.confidence).toBeCloseTo(0.50, 4);
      expect(result.isRecognized).toBe(true);
    });

    it('rejects gesture when confidence is just below threshold (0.499)', () => {
      const model = createModelWithProb(0.499, 0.501);
      const result = predictRF(features, model, 0.502);
      expect(result.confidence).toBeCloseTo(0.501, 3);
      expect(result.isRecognized).toBe(false);
    });

    it('respects custom user-configured thresholds', () => {
      const model = createModelWithProb(0.75, 0.25);
      // At threshold 0.70, 0.75 is recognized
      expect(predictRF(features, model, 0.70).isRecognized).toBe(true);
      // At threshold 0.80, 0.75 is rejected
      expect(predictRF(features, model, 0.80).isRecognized).toBe(false);
    });

    it('validates and clamps threshold bounds properly', () => {
      expect(validateThreshold(0.5)).toBe(0.5);
      expect(validateThreshold(-0.2)).toBe(0.0);
      expect(validateThreshold(1.5)).toBe(1.0);
      expect(validateThreshold(NaN, 0.5)).toBe(0.5);
      expect(validateThreshold(undefined, 0.5)).toBe(0.5);
    });
  });

  describe('Tree traversal with internal decision nodes', () => {
    it('correctly follows feature splits to appropriate leaf nodes', () => {
      const model: RFModel = {
        classes: ['left_pose', 'right_pose'],
        trees: [
          {
            // Node 0 tests feature 0 <= 0.5
            // If <= 0.5 -> Node 1 (left_pose: 90%)
            // If > 0.5 -> Node 2 (right_pose: 90%)
            children_left: [1, -1, -1],
            children_right: [2, -1, -1],
            feature: [0, -2, -2],
            threshold: [0.5, -2.0, -2.0],
            value: [
              [[0.5, 0.5]],
              [[0.9, 0.1]],
              [[0.1, 0.9]],
            ],
          },
        ],
      };

      const featuresLeft = [0.3, ...new Array(209).fill(0.1)];
      const resultLeft = predictRF(featuresLeft, model, 0.50);
      expect(resultLeft.prediction).toBe('left_pose');
      expect(resultLeft.confidence).toBeCloseTo(0.9, 2);
      expect(resultLeft.isRecognized).toBe(true);

      const featuresRight = [0.8, ...new Array(209).fill(0.1)];
      const resultRight = predictRF(featuresRight, model, 0.50);
      expect(resultRight.prediction).toBe('right_pose');
      expect(resultRight.confidence).toBeCloseTo(0.9, 2);
      expect(resultRight.isRecognized).toBe(true);
    });
  });

  describe('Edge cases and error handling', () => {
    const dummyModel: RFModel = {
      classes: ['a', 'b'],
      trees: [
        {
          children_left: [-1],
          children_right: [-1],
          feature: [-2],
          threshold: [-2.0],
          value: [[[0.8, 0.2]]],
        },
      ],
    };

    it('returns none with confidence 0.0 when all features are 0.0', () => {
      const zeroFeatures = new Array(210).fill(0.0);
      const res = predictRF(zeroFeatures, dummyModel);
      expect(res.prediction).toBe('none');
      expect(res.confidence).toBe(0.0);
      expect(res.isRecognized).toBe(false);
    });

    it('returns none with confidence 0.0 when features array is empty or invalid', () => {
      expect(predictRF([], dummyModel).confidence).toBe(0.0);
      expect(predictRF(null as unknown as number[], dummyModel).confidence).toBe(0.0);
      expect(predictRF(undefined as unknown as number[], dummyModel).confidence).toBe(0.0);
    });

    it('returns none with confidence 0.0 when model is null or missing trees', () => {
      const features = new Array(210).fill(0.5);
      expect(predictRF(features, null).confidence).toBe(0.0);
      expect(predictRF(features, {}).confidence).toBe(0.0);
      expect(predictRF(features, { classes: ['a'], trees: [] }).confidence).toBe(0.0);
      expect(predictRF(features, { classes: [], trees: [{}] as unknown as RFModel['trees'] }).confidence).toBe(0.0);
    });

    it('handles degenerate tree leaves with zero total sum without NaN', () => {
      const modelWithEmptyLeaf: RFModel = {
        classes: ['a', 'b'],
        trees: [
          {
            children_left: [-1],
            children_right: [-1],
            feature: [-2],
            threshold: [-2.0],
            value: [[[0, 0]]],
          },
        ],
      };
      const features = new Array(210).fill(0.5);
      const res = predictRF(features, modelWithEmptyLeaf, 0.50);
      expect(Number.isFinite(res.confidence)).toBe(true);
      expect(res.confidence).toBeCloseTo(0.5, 2);
    });
  });

  describe('Real exported custom_word_model.json inference & performance', () => {
    it('successfully loads and predicts using the real exported model within latency bounds', () => {
      const modelPath = path.resolve(__dirname, '../../../ui-tars/dataset/custom_word_model.json');
      if (fs.existsSync(modelPath)) {
        const raw = fs.readFileSync(modelPath, 'utf8');
        const realModel = JSON.parse(raw);

        expect(realModel.classes).toBeDefined();
        expect(realModel.trees.length).toBeGreaterThan(0);

        const dummyFeatures = new Array(210).fill(0.35);
        const startTime = performance.now();

        // Run 1000 iterations to verify 60 FPS real-time processing constraints (< 16.6ms per frame)
        const iterations = 1000;
        for (let i = 0; i < iterations; i++) {
          predictRF(dummyFeatures, realModel, 0.50);
        }
        const totalDuration = performance.now() - startTime;
        const avgPerInference = totalDuration / iterations;

        // An inference call should easily take < 1ms (typically < 0.05ms)
        expect(avgPerInference).toBeLessThan(1.0);
      }
    });
  });

  describe('extractFeaturesJS', () => {
    it('returns 210 zeros for empty timeline data', () => {
      const feats = extractFeaturesJS([]);
      expect(feats).toHaveLength(210);
      expect(feats.every((f) => f === 0.0)).toBe(true);
    });

    it('extracts 210 scale-invariant features bounded in [0, 1] for 21 landmarks', () => {
      const landmarks = [];
      for (let i = 0; i < 21; i++) {
        landmarks.push({ x: i * 0.04, y: i * 0.03, z: i * 0.01 });
      }
      const timelineData = [
        { type: 'hand', timestamp: Date.now(), data: landmarks },
        { type: 'hand', timestamp: Date.now() + 50, data: landmarks },
      ];

      const feats = extractFeaturesJS(timelineData);
      expect(feats).toHaveLength(210);
      expect(validateFeatures(feats)).toBe(true);
      // All values should be normalized <= 1.0
      expect(feats.every((f) => f >= 0.0 && f <= 1.0)).toBe(true);
      // The maximum distance is normalized to 1.0
      expect(Math.max(...feats)).toBeCloseTo(1.0, 4);
    });
  });
});

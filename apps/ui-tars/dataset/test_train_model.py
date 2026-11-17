import os
import sys
import math
import pytest
import numpy as np

# Add dataset dir to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from train_word_model import extract_features, export_rf_to_json
from sklearn.ensemble import RandomForestClassifier

def generate_mock_hand_frame(pose='open_palm'):
    wrist = {'x': 0.5, 'y': 0.9, 'z': 0.0}
    landmarks = [{'x': 0.5, 'y': 0.5, 'z': 0.0} for _ in range(21)]
    landmarks[0] = wrist
    landmarks[17] = {'x': 0.6, 'y': 0.7, 'z': 0.0}

    if pose == 'open_palm':
        landmarks[3] = {'x': 0.35, 'y': 0.75, 'z': 0.0}
        landmarks[4] = {'x': 0.25, 'y': 0.7, 'z': 0.0}
        landmarks[6] = {'x': 0.45, 'y': 0.6, 'z': 0.0}
        landmarks[8] = {'x': 0.45, 'y': 0.3, 'z': 0.0}
        landmarks[10] = {'x': 0.5, 'y': 0.6, 'z': 0.0}
        landmarks[12] = {'x': 0.5, 'y': 0.25, 'z': 0.0}
        landmarks[14] = {'x': 0.55, 'y': 0.6, 'z': 0.0}
        landmarks[16] = {'x': 0.55, 'y': 0.3, 'z': 0.0}
        landmarks[18] = {'x': 0.6, 'y': 0.65, 'z': 0.0}
        landmarks[20] = {'x': 0.6, 'y': 0.35, 'z': 0.0}
    elif pose == 'fist':
        landmarks[3] = {'x': 0.4, 'y': 0.7, 'z': 0.0}
        landmarks[4] = {'x': 0.5, 'y': 0.72, 'z': 0.0}
        landmarks[6] = {'x': 0.45, 'y': 0.65, 'z': 0.0}
        landmarks[8] = {'x': 0.45, 'y': 0.75, 'z': 0.0}
        landmarks[10] = {'x': 0.5, 'y': 0.65, 'z': 0.0}
        landmarks[12] = {'x': 0.5, 'y': 0.75, 'z': 0.0}
        landmarks[14] = {'x': 0.55, 'y': 0.65, 'z': 0.0}
        landmarks[16] = {'x': 0.55, 'y': 0.75, 'z': 0.0}
        landmarks[18] = {'x': 0.6, 'y': 0.68, 'z': 0.0}
        landmarks[20] = {'x': 0.6, 'y': 0.78, 'z': 0.0}

    return landmarks

class TestFeatureExtractionAndTraining:
    def test_extract_features_valid_data(self):
        hand = generate_mock_hand_frame('open_palm')
        timeline = [
            {'type': 'hand', 'timestamp': 1000, 'data': hand},
            {'type': 'hand', 'timestamp': 1050, 'data': hand},
        ]
        features = extract_features(timeline)
        assert len(features) == 210
        assert all(math.isfinite(f) for f in features)
        assert any(f > 0.0 for f in features)
        assert max(features) <= 1.0

    def test_extract_features_corrupted_coordinates(self):
        valid_hand = generate_mock_hand_frame('open_palm')
        corrupt_nan = [{'x': float('nan'), 'y': 0.5, 'z': 0.0} for _ in range(21)]
        corrupt_inf = [{'x': float('inf'), 'y': 0.5, 'z': 0.0} for _ in range(21)]
        corrupt_string = [{'x': 'corrupt', 'y': 0.5, 'z': 0.0} for _ in range(21)]
        wrong_count = [{'x': 0.5, 'y': 0.5, 'z': 0.0} for _ in range(10)]

        timeline = [
            {'type': 'hand', 'timestamp': 1000, 'data': None},
            {'type': 'hand', 'timestamp': 1030, 'data': corrupt_nan},
            {'type': 'hand', 'timestamp': 1060, 'data': corrupt_inf},
            {'type': 'hand', 'timestamp': 1090, 'data': corrupt_string},
            {'type': 'hand', 'timestamp': 1120, 'data': wrong_count},
            {'type': 'hand', 'timestamp': 1150, 'data': valid_hand},
        ]

        features = extract_features(timeline)
        assert len(features) == 210
        assert all(math.isfinite(f) for f in features)
        assert any(f > 0.0 for f in features)

    def test_extract_features_all_corrupted(self):
        timeline = [
            {'type': 'hand', 'timestamp': 1000, 'data': None},
            {'type': 'hand', 'timestamp': 1050, 'data': []},
            {'type': 'face', 'timestamp': 1100, 'data': {'blink': True}},
        ]
        features = extract_features(timeline)
        assert len(features) == 210
        assert all(f == 0.0 for f in features)

    def test_rf_model_training_with_corrupted_data_injected(self):
        # Generate training dataset: palm vs fist
        X = []
        y = []

        palm_hand = generate_mock_hand_frame('open_palm')
        fist_hand = generate_mock_hand_frame('fist')

        for _ in range(10):
            # Mix valid frames with intermittent frame drops and corrupted events
            palm_tl = [
                {'type': 'hand', 'timestamp': 1000, 'data': None},
                {'type': 'hand', 'timestamp': 1050, 'data': palm_hand},
                {'type': 'hand', 'timestamp': 1100, 'data': [{'x': float('nan'), 'y': 0.5, 'z': 0.0} for _ in range(21)]},
                {'type': 'hand', 'timestamp': 1150, 'data': palm_hand},
            ]
            X.append(extract_features(palm_tl))
            y.append('palm')

            fist_tl = [
                {'type': 'hand', 'timestamp': 1000, 'data': fist_hand},
                {'type': 'hand', 'timestamp': 1050, 'data': None},
                {'type': 'hand', 'timestamp': 1100, 'data': fist_hand},
            ]
            X.append(extract_features(fist_tl))
            y.append('fist')

        X = np.array(X)
        y = np.array(y)

        assert not np.isnan(X).any()
        assert not np.isinf(X).any()

        clf = RandomForestClassifier(n_estimators=10, max_depth=5, random_state=42)
        clf.fit(X, y)

        preds = clf.predict(X)
        accuracy = (preds == y).mean()
        assert accuracy == 1.0

        model_json = export_rf_to_json(clf, clf.classes_)
        assert 'classes' in model_json
        assert 'trees' in model_json
        assert len(model_json['trees']) == 10

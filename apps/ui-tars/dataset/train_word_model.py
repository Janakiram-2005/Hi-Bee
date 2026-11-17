import os
import json
import glob
import numpy as np
try:
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import accuracy_score
    import joblib
except ImportError:
    print("Please install required packages: pip install scikit-learn numpy joblib")
    exit(1)

import math

def export_rf_to_json(clf, classes):
    """
    Exports the trained Random Forest into a lightweight JSON structure 
    so it can be executed natively in Javascript!
    """
    trees = []
    for estimator in clf.estimators_:
        tree = estimator.tree_
        tree_dict = {
            "children_left": tree.children_left.tolist(),
            "children_right": tree.children_right.tolist(),
            "feature": tree.feature.tolist(),
            "threshold": tree.threshold.tolist(),
            "value": [v.tolist() for v in tree.value]
        }
        trees.append(tree_dict)
    
    return {
        "classes": classes.tolist(),
        "trees": trees
    }

def extract_features(timeline_data):
    """
    Extracts robust 3D features and temporal trajectory dynamics from MediaPipe landmarks.
    Combines scale-invariant pairwise distances (hand shape geometry) with multi-phase
    temporal trajectory features (displacement deltas, intermediate trajectory vectors,
    path lengths, velocities, and directional metrics) to avoid collapsing temporal dynamics.
    Total features: 417.
    """
    hand_states = [item['data'] for item in timeline_data if item.get('type') == 'hand' and item.get('data')]
    valid_frames = [f for f in hand_states if isinstance(f, list) and len(f) == 21]

    TOTAL_FEATURES = 417
    if not valid_frames:
        return [0.0] * TOTAL_FEATURES

    num_frames = len(valid_frames)

    # 1. Multi-phase temporal slicing: Start (0..33%), Mid (33..66%), End (66..100%)
    p1_end = max(1, num_frames // 3)
    p2_end = max(p1_end + 1, (2 * num_frames) // 3)

    phase_start = valid_frames[:p1_end]
    phase_mid = valid_frames[p1_end:p2_end]
    phase_end = valid_frames[p2_end:]
    if not phase_mid:
        phase_mid = phase_start
    if not phase_end:
        phase_end = phase_mid

    def avg_landmarks_phase(frames):
        avg = []
        for i in range(21):
            xs = [f[i]['x'] for f in frames]
            ys = [f[i]['y'] for f in frames]
            zs = [f[i]['z'] for f in frames]
            avg.append({
                'x': sum(xs) / len(xs) if xs else 0.0,
                'y': sum(ys) / len(ys) if ys else 0.0,
                'z': sum(zs) / len(zs) if zs else 0.0
            })
        return avg

    lm_all = avg_landmarks_phase(valid_frames)
    lm_start = avg_landmarks_phase(phase_start)
    lm_mid = avg_landmarks_phase(phase_mid)
    lm_end = avg_landmarks_phase(phase_end)

    features = []

    # 2. Hand shape: 210 pairwise distances of overall average pose (scale-invariant)
    dists = []
    for i in range(21):
        for j in range(i + 1, 21):
            dx = lm_all[i]['x'] - lm_all[j]['x']
            dy = lm_all[i]['y'] - lm_all[j]['y']
            dz = lm_all[i]['z'] - lm_all[j]['z']
            dists.append(math.sqrt(dx * dx + dy * dy + dz * dz))

    max_dist = max(dists) if dists else 1.0
    if max_dist == 0:
        max_dist = 1.0
    features.extend([d / max_dist for d in dists])

    # 3. Temporal trajectory displacement: Start -> End (21 * 3 = 63 features)
    for i in range(21):
        features.append(lm_end[i]['x'] - lm_start[i]['x'])
        features.append(lm_end[i]['y'] - lm_start[i]['y'])
        features.append(lm_end[i]['z'] - lm_start[i]['z'])

    # 4. Intermediate trajectory displacement: Start -> Mid (21 * 3 = 63 features)
    for i in range(21):
        features.append(lm_mid[i]['x'] - lm_start[i]['x'])
        features.append(lm_mid[i]['y'] - lm_start[i]['y'])
        features.append(lm_mid[i]['z'] - lm_start[i]['z'])

    # 5. Intermediate trajectory displacement: Mid -> End (21 * 3 = 63 features)
    for i in range(21):
        features.append(lm_end[i]['x'] - lm_mid[i]['x'])
        features.append(lm_end[i]['y'] - lm_mid[i]['y'])
        features.append(lm_end[i]['z'] - lm_mid[i]['z'])

    # 6. Motion dynamics & trajectory metrics (18 features):
    # Key landmark indices: 0 (wrist), 4 (thumb tip), 8 (index tip), 12 (middle tip), 20 (pinky tip)
    key_indices = [0, 4, 8, 12, 20]

    # (a) Cumulative path length per key landmark (5 features)
    path_lengths = []
    for kidx in key_indices:
        plen = 0.0
        for f_idx in range(1, num_frames):
            p_prev = valid_frames[f_idx - 1][kidx]
            p_curr = valid_frames[f_idx][kidx]
            plen += math.sqrt(
                (p_curr['x'] - p_prev['x']) ** 2 +
                (p_curr['y'] - p_prev['y']) ** 2 +
                (p_curr['z'] - p_prev['z']) ** 2
            )
        path_lengths.append(plen)
    features.extend(path_lengths)

    # (b) Net displacement magnitude per key landmark (5 features)
    net_disps = []
    for kidx in key_indices:
        dx = lm_end[kidx]['x'] - lm_start[kidx]['x']
        dy = lm_end[kidx]['y'] - lm_start[kidx]['y']
        dz = lm_end[kidx]['z'] - lm_start[kidx]['z']
        net_disps.append(math.sqrt(dx * dx + dy * dy + dz * dz))
    features.extend(net_disps)

    # (c) Directional unit vector for wrist (0) and index tip (8) (6 features)
    for kidx in [0, 8]:
        dx = lm_end[kidx]['x'] - lm_start[kidx]['x']
        dy = lm_end[kidx]['y'] - lm_start[kidx]['y']
        dz = lm_end[kidx]['z'] - lm_start[kidx]['z']
        mag = math.sqrt(dx * dx + dy * dy + dz * dz)
        if mag > 1e-6:
            features.extend([dx / mag, dy / mag, dz / mag])
        else:
            features.extend([0.0, 0.0, 0.0])

    # (d) Linearity ratio (net displacement / path length) for wrist and index tip (2 features)
    for kidx, p_idx, n_idx in [(0, 0, 0), (8, 2, 2)]:
        plen = path_lengths[p_idx]
        ndisp = net_disps[n_idx]
        if plen > 1e-6:
            features.append(min(1.0, ndisp / plen))
        else:
            features.append(0.0)

    return features

# Configuration
DATASET_DIR = os.path.join(os.path.dirname(__file__), "words")
MODEL_PATH = os.path.join(os.path.dirname(__file__), "custom_word_model.pkl")
JSON_MODEL_PATH = os.path.join(os.path.dirname(__file__), "custom_word_model.json")

def main():
    gestures_dir = DATASET_DIR
    
    if not os.path.exists(gestures_dir):
        print(f"Dataset directory not found: {gestures_dir}")
        print("Please record some gestures using the Dataset Studio first.")
        return

    X = []
    y = []

    # Iterate over all gesture labels (folder names)
    for label in os.listdir(gestures_dir):
        label_dir = os.path.join(gestures_dir, label)
        if not os.path.isdir(label_dir):
            continue
        
        # Find all JSON data files
        json_files = glob.glob(os.path.join(label_dir, 'data_*.json'))
        for jf in json_files:
            try:
                with open(jf, 'r') as f:
                    timeline = json.load(f)
                    features = extract_features(timeline)
                    X.append(features)
                    y.append(label)
            except Exception as e:
                print(f"Error reading {jf}: {e}")

    if len(X) == 0:
        print("No training data found. Please record gestures in the Dataset Studio.")
        return

    print(f"Loaded {len(X)} samples across {len(set(y))} gesture classes.")

    # Convert to numpy arrays
    X = np.array(X)
    y = np.array(y)

    # Split dataset
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42) if len(X) > 5 else (X, X, y, y)

    # Train Random Forest Classifier
    print("Training robust Random Forest model on pairwise distance geometry...")
    clf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
    clf.fit(X_train, y_train)

    # Evaluate
    preds = clf.predict(X_test)
    acc = accuracy_score(y_test, preds)
    print(f"Validation Accuracy: {acc * 100:.2f}%")

    # Save model as PKL (for potential future use)
    model_path = MODEL_PATH
    joblib.dump(clf, model_path)
    print(f"Model saved to {model_path}")

    # Export to JSON for zero-latency JavaScript execution!
    json_path = JSON_MODEL_PATH
    model_json = export_rf_to_json(clf, clf.classes_)
    with open(json_path, 'w') as f:
        json.dump(model_json, f)
    print(f"Model exported to {json_path} for native JS inference!")

if __name__ == '__main__':
    main()

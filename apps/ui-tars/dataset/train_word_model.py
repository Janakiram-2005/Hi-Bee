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
    Extracts robust 3D features from the MediaPipe landmarks.
    Computes all 210 pairwise distances between the 21 landmarks
    to make the model perfectly invariant to position and rotation!
    """
    hand_states = [item['data'] for item in timeline_data if item['type'] == 'hand' and item.get('data')]

    features = []

    if hand_states:
        # Calculate the average position of each of the 21 landmarks over the recording
        avg_landmarks = []
        for i in range(21):
            # Only process if the frame has 21 landmarks
            xs = [frame[i]['x'] for frame in hand_states if isinstance(frame, list) and len(frame) == 21]
            ys = [frame[i]['y'] for frame in hand_states if isinstance(frame, list) and len(frame) == 21]
            zs = [frame[i]['z'] for frame in hand_states if isinstance(frame, list) and len(frame) == 21]
            if xs:
                avg_landmarks.append({'x': sum(xs)/len(xs), 'y': sum(ys)/len(ys), 'z': sum(zs)/len(zs)})
            else:
                avg_landmarks.append({'x': 0, 'y': 0, 'z': 0})
        
        if len(avg_landmarks) == 21 and any(lm['x'] != 0 for lm in avg_landmarks):
            # Calculate pairwise distances (21 * 20 / 2 = 210 features)
            dists = []
            for i in range(21):
                for j in range(i + 1, 21):
                    dx = avg_landmarks[i]['x'] - avg_landmarks[j]['x']
                    dy = avg_landmarks[i]['y'] - avg_landmarks[j]['y']
                    dz = avg_landmarks[i]['z'] - avg_landmarks[j]['z']
                    dists.append(math.sqrt(dx*dx + dy*dy + dz*dz))
            
            # Normalize distances by the max distance to make it scale-invariant
            max_dist = max(dists) if dists else 1.0
            if max_dist == 0: max_dist = 1.0
            
            features.extend([d / max_dist for d in dists])
        else:
            features.extend([0.0] * 210)
    else:
        features.extend([0.0] * 210)

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

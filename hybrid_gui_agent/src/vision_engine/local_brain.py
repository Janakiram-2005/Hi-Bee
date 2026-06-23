import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import numpy as np
import time
import json
import sys
import base64
import os
import math

HAND_CONNECTIONS = frozenset([
  (0, 1), (1, 2), (2, 3), (3, 4),
  (0, 5), (5, 6), (6, 7), (7, 8),
  (5, 9), (9, 10), (10, 11), (11, 12),
  (9, 13), (13, 14), (14, 15), (15, 16),
  (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)
])

def process_vision():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Setup MediaPipe Tasks
    base_options_face = python.BaseOptions(model_asset_path=os.path.join(script_dir, 'face_landmarker.task'))
    options_face = vision.FaceLandmarkerOptions(
        base_options=base_options_face,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        num_faces=1,
    )
    face_mesh = vision.FaceLandmarker.create_from_options(options_face)
    
    base_options_hands = python.BaseOptions(model_asset_path=os.path.join(script_dir, 'hand_landmarker.task'))
    options_hands = vision.HandLandmarkerOptions(
        base_options=base_options_hands,
        num_hands=2,
    )
    hands = vision.HandLandmarker.create_from_options(options_hands)
    
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    if not cap.isOpened():
        print(json.dumps({"type": "error", "message": "Failed to open camera"}))
        sys.stdout.flush()
        return

    # Constants
    HOLD_TIME_REQUIRED = 1.2
    TARGET_MIN = 0.42
    TARGET_MAX = 0.58
    LOW_LIGHT_THRESHOLD = 40.0

    gaze_start_time = None
    gesture_states = {} # Tracks held time for gestures
    blink_history = []
    head_history = []

    gesture_file_path = sys.argv[1] if len(sys.argv) > 1 else None
    
    def load_gestures():
        if gesture_file_path:
            try:
                with open(gesture_file_path, 'r') as f:
                    return json.load(f)
            except Exception:
                pass
        return []

    def get_finger_states(hand_landmarks):
        # Calculate finger states (open/closed)
        # Thumb: compare x-coordinates for open/close relative to hand orientation
        thumb_open = hand_landmarks[4].x < hand_landmarks[3].x if hand_landmarks[17].x > hand_landmarks[5].x else hand_landmarks[4].x > hand_landmarks[3].x
        index_open = hand_landmarks[8].y < hand_landmarks[6].y
        middle_open = hand_landmarks[12].y < hand_landmarks[10].y
        ring_open = hand_landmarks[16].y < hand_landmarks[14].y
        pinky_open = hand_landmarks[20].y < hand_landmarks[18].y
        
        return {
            "thumb": "open" if thumb_open else "closed",
            "index": "open" if index_open else "closed",
            "middle": "open" if middle_open else "closed",
            "ring": "open" if ring_open else "closed",
            "pinky": "open" if pinky_open else "closed"
        }

    def detect_hand_gestures(hand_landmarks, custom_gestures):
        states = get_finger_states(hand_landmarks)
        matched = []
        for g in custom_gestures:
            if g.get('type', 'hand') != 'hand': continue
            match = True
            for finger, req_state in g.get('fingers', {}).items():
                if req_state != 'any' and states.get(finger) != req_state:
                    match = False
                    break
            if match:
                matched.append(g)
        return matched, states
        
    def detect_face_gestures(custom_gestures, blink_left, blink_right, pitch, yaw, now):
        matched = []
        
        # Determine current blinks
        # Use simple thresholding on blendshape scores
        is_blink_left = blink_left > 0.45
        is_blink_right = blink_right > 0.45
        
        nonlocal blink_history
        # Record blink event (debounce by checking last entry)
        if is_blink_left or is_blink_right:
            if not blink_history or now - blink_history[-1]['time'] > 0.3:
                blink_history.append({'time': now, 'left': is_blink_left, 'right': is_blink_right})
                
        # Clean old blinks (> 1.5s)
        blink_history = [b for b in blink_history if now - b['time'] < 1.5]
        
        nonlocal head_history
        head_history.append({'time': now, 'pitch': pitch, 'yaw': yaw})
        head_history = [h for h in head_history if now - h['time'] < 1.5]
        
        # Calculate max deltas for head
        pitches = [h['pitch'] for h in head_history]
        yaws = [h['yaw'] for h in head_history]
        pitch_delta = max(pitches) - min(pitches) if pitches else 0
        yaw_delta = max(yaws) - min(yaws) if yaws else 0
        
        is_nod = pitch_delta > 15.0 and yaw_delta < 12.0
        is_shake = yaw_delta > 15.0 and pitch_delta < 12.0
        
        # Check double blink (2 distinct blinks within 1.5s where both eyes blinked)
        full_blinks = [b for b in blink_history if b['left'] and b['right']]
        is_double_blink = len(full_blinks) >= 2
        
        # Check winks
        winks_left = [b for b in blink_history if b['left'] and not b['right']]
        winks_right = [b for b in blink_history if not b['left'] and b['right']]
        
        for g in custom_gestures:
            t = g.get('type', 'hand')
            if t == 'eye':
                ea = g.get('eyeAction')
                if ea == 'double_blink' and is_double_blink:
                    matched.append(g)
                elif ea == 'wink_left' and len(winks_left) > 0:
                    matched.append(g)
                elif ea == 'wink_right' and len(winks_right) > 0:
                    matched.append(g)
            elif t == 'head':
                ha = g.get('headAction')
                if ha == 'nod' and is_nod:
                    matched.append(g)
                elif ha == 'shake' and is_shake:
                    matched.append(g)
                    
        # If we matched an eye or head gesture, we clear the history to avoid spam
        if any(g.get('type') in ['eye', 'head'] for g in matched):
            blink_history.clear()
            head_history.clear()
            
        return matched

    try:
        while True:
            success, frame = cap.read()
            if not success:
                print(json.dumps({"type": "error", "message": "Frame drop"}))
                sys.stdout.flush()
                time.sleep(0.1)
                continue

            # Brightness check
            mean_brightness = float(np.mean(frame))
            is_low_light = bool(mean_brightness < LOW_LIGHT_THRESHOLD)
            
            # MediaPipe processing
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            
            results_face = face_mesh.detect(mp_image)
            results_hands = hands.detect(mp_image)
            
            payload = {
                "type": "vision-update",
                "low_light": is_low_light,
                "face_found": False,
                "face_mesh_points": [],
                "hands": []
            }

            current_gestures = []
            
            # Load gestures dynamically
            custom_gestures = load_gestures()
            
            if results_face.face_landmarks:
                payload["face_found"] = True
                face_landmarks = results_face.face_landmarks[0]
                
                # Extract landmarks (33, 133 for left eye corners, 468 for left iris center)
                pt33 = face_landmarks[33]
                pt133 = face_landmarks[133]
                pt468 = face_landmarks[468]
                pt473 = face_landmarks[473] # Right iris
                
                left_x = min(pt33.x, pt133.x)
                right_x = max(pt33.x, pt133.x)
                
                if right_x - left_x > 0:
                    relative_position = (pt468.x - left_x) / (right_x - left_x)
                else:
                    relative_position = 0
                
                payload["iris"] = {
                    "left": {"x": pt468.x, "y": pt468.y},
                    "right": {"x": pt473.x, "y": pt473.y}
                }
                
                xs = [lm.x for lm in face_landmarks]
                ys = [lm.y for lm in face_landmarks]
                payload["face_box"] = {
                    "min_x": min(xs),
                    "max_x": max(xs),
                    "min_y": min(ys),
                    "max_y": max(ys)
                }
                
                # Send a subset of face points for drawing blue dots
                downsampled = [{"x": lm.x, "y": lm.y} for i, lm in enumerate(face_landmarks) if i % 10 == 0]
                payload["face_mesh_points"] = downsampled
                
                # Extract blendshapes for blink detection
                blink_left = 0.0
                blink_right = 0.0
                if results_face.face_blendshapes:
                    for cat in results_face.face_blendshapes[0]:
                        if cat.category_name == 'eyeBlinkLeft': blink_left = cat.score
                        if cat.category_name == 'eyeBlinkRight': blink_right = cat.score
                        
                # Extract head pose
                pitch, yaw = 0.0, 0.0
                if results_face.facial_transformation_matrixes:
                    matrix = results_face.facial_transformation_matrixes[0]
                    sy = math.sqrt(matrix[0,0]**2 + matrix[1,0]**2)
                    if sy > 1e-6:
                        pitch = math.atan2(matrix[2,1], matrix[2,2]) * 180.0 / math.pi
                        yaw = math.atan2(-matrix[2,0], sy) * 180.0 / math.pi
                    else:
                        pitch = math.atan2(-matrix[1,2], matrix[1,1]) * 180.0 / math.pi
                        yaw = math.atan2(-matrix[2,0], sy) * 180.0 / math.pi
                        
                # Detect Face Gestures (Eye/Head)
                now_t = time.time()
                face_matched = detect_face_gestures(custom_gestures, blink_left, blink_right, pitch, yaw, now_t)
                for mg in face_matched:
                    current_gestures.append(mg)
                
                # Gaze holding logic
                if TARGET_MIN <= relative_position <= TARGET_MAX:
                    if gaze_start_time is None:
                        gaze_start_time = now_t
                    elif now_t - gaze_start_time >= HOLD_TIME_REQUIRED:
                        print(json.dumps({"type": "vision-wake"}))
                        sys.stdout.flush()
                        gaze_start_time = None
                else:
                    gaze_start_time = None
            else:
                gaze_start_time = None
            
            if results_hands.hand_landmarks:
                for hand_landmarks in results_hands.hand_landmarks:
                    pts = [{"x": lm.x, "y": lm.y} for lm in hand_landmarks]
                    matched_gestures, states = detect_hand_gestures(hand_landmarks, custom_gestures)
                    
                    # We just take the first matched gesture name for display purposes
                    display_gesture = matched_gestures[0]['name'] if matched_gestures else "none"
                    
                    for mg in matched_gestures:
                        current_gestures.append(mg)
                        
                    payload["hands"].append({
                        "landmarks": pts,
                        "gesture": display_gesture,
                        "finger_states": states
                    })
            
            # Update gesture holds based on action
            now = time.time()
            active_actions = {g['action']: g for g in current_gestures}
            
            for action, g in active_actions.items():
                if action not in gesture_states:
                    gesture_states[action] = now
                elif now - gesture_states[action] >= HOLD_TIME_REQUIRED:
                    # Emit gesture trigger
                    print(json.dumps({
                        "type": "vision-gesture", 
                        "gesture": g['name'], 
                        "action": action, 
                        "actionArg": g.get('actionArg')
                    }))
                    sys.stdout.flush()
                    # Reset to avoid spamming
                    gesture_states[action] = now + 1.5 # 1.5 second cooldown
                    
            # Clear states for actions no longer active
            inactive_actions = [a for a in gesture_states.keys() if a not in active_actions]
            for a in inactive_actions:
                if gesture_states[a] < now: # keep cooldowns active
                    del gesture_states[a]
                
            # --- Draw and Encode Live Frame ---
            # Draw Face Points (lightly) since we don't have tessellation connections
            if results_face.face_landmarks:
                for face_landmarks in results_face.face_landmarks:
                    h, w, _ = frame.shape
                    for i, lm in enumerate(face_landmarks):
                        if i % 15 == 0: # Draw fewer points to avoid clutter
                            cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 1, (100, 100, 100), -1)
            
            # Draw Hands with Custom Dynamic Colors
            if results_hands.hand_landmarks:
                for hand_landmarks in results_hands.hand_landmarks:
                    states = get_finger_states(hand_landmarks)
                    h, w, c = frame.shape
                    pixel_pts = [ (int(lm.x * w), int(lm.y * h)) for lm in hand_landmarks ]
                    
                    # 1. Draw Connections
                    for p1, p2 in HAND_CONNECTIONS:
                        is_palm = (p1 in [0, 5, 9, 13, 17] and p2 in [0, 5, 9, 13, 17])
                        color = (255, 255, 255) # White for palm
                        thickness = 2
                        
                        if not is_palm:
                            if p2 in [1, 2, 3, 4]:
                                color = (0, 255, 0) if states['thumb'] == 'open' else (0, 0, 255)
                            elif p2 in [6, 7, 8]:
                                color = (0, 255, 0) if states['index'] == 'open' else (0, 0, 255)
                            elif p2 in [10, 11, 12]:
                                color = (0, 255, 0) if states['middle'] == 'open' else (0, 0, 255)
                            elif p2 in [14, 15, 16]:
                                color = (0, 255, 0) if states['ring'] == 'open' else (0, 0, 255)
                            elif p2 in [18, 19, 20]:
                                color = (0, 255, 0) if states['pinky'] == 'open' else (0, 0, 255)
                            thickness = 3
                            
                        cv2.line(frame, pixel_pts[p1], pixel_pts[p2], color, thickness)
                        
                    # 2. Draw Joints
                    for i, pt in enumerate(pixel_pts):
                        if i in [4, 8, 12, 16, 20]: # Fingertips
                            # Red & Blue style for tips
                            cv2.circle(frame, pt, 7, (255, 0, 0), -1) # Blue filled
                            cv2.circle(frame, pt, 8, (0, 0, 255), 2)  # Red outline
                        elif i == 0: # Wrist
                            cv2.circle(frame, pt, 6, (255, 255, 255), -1)
                        else:
                            # Match finger color
                            color = (200, 200, 200)
                            if i in [1, 2, 3]: color = (0, 255, 0) if states['thumb'] == 'open' else (0, 0, 255)
                            elif i in [5, 6, 7]: color = (0, 255, 0) if states['index'] == 'open' else (0, 0, 255)
                            elif i in [9, 10, 11]: color = (0, 255, 0) if states['middle'] == 'open' else (0, 0, 255)
                            elif i in [13, 14, 15]: color = (0, 255, 0) if states['ring'] == 'open' else (0, 0, 255)
                            elif i in [17, 18, 19]: color = (0, 255, 0) if states['pinky'] == 'open' else (0, 0, 255)
                            
                            cv2.circle(frame, pt, 5, color, -1)

            # Resize to minimize JSON bloat over stdout (e.g., 320x240)
            small_frame = cv2.resize(frame, (320, 240))
            ret, buffer = cv2.imencode('.jpg', small_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 50])
            if ret:
                payload["frame_b64"] = base64.b64encode(buffer).decode('utf-8')

            print(json.dumps(payload))
            sys.stdout.flush()
            
            # Small sleep to yield CPU
            time.sleep(1/60)
            
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}))
        sys.stdout.flush()
    finally:
        cap.release()
        face_mesh.close()
        hands.close()

if __name__ == "__main__":
    process_vision()


import cv2
try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
except ImportError:
    mp = None
    python = None
    vision = None
import numpy as np
import time
import json
import sys
import base64
import os
import math

script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

try:
    from vision_engine.gesture_engine import (
        get_finger_states,
        detect_hand_gestures,
        calculate_gesture_specificity,
        rank_gestures_by_specificity,
        validate_landmarks,
        validate_hold_threshold,
        GestureHoldTracker
    )
except ImportError:
    from gesture_engine import (
        get_finger_states,
        detect_hand_gestures,
        calculate_gesture_specificity,
        rank_gestures_by_specificity,
        validate_landmarks,
        validate_hold_threshold,
        GestureHoldTracker
    )

HAND_CONNECTIONS = frozenset([
  (0, 1), (1, 2), (2, 3), (3, 4),
  (0, 5), (5, 6), (6, 7), (7, 8),
  (5, 9), (9, 10), (10, 11), (11, 12),
  (9, 13), (13, 14), (14, 15), (15, 16),
  (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)
])


def _get_coord(pt, attr, default=0.0):
    """Safely extracts a coordinate (x, y, z) from a dict or MediaPipe landmark object."""
    if pt is None:
        return default
    if isinstance(pt, dict):
        return float(pt.get(attr, default))
    return float(getattr(pt, attr, default))


def calculate_landmark_distance(p1, p2, aspect_ratio=1.0, include_z=False):
    """
    Calculates Euclidean distance with aspect-ratio correction between two landmarks.
    Supports both dict and MediaPipe landmark objects.
    """
    if p1 is None or p2 is None:
        return 0.0

    x1, y1 = _get_coord(p1, 'x'), _get_coord(p1, 'y')
    x2, y2 = _get_coord(p2, 'x'), _get_coord(p2, 'y')
    dx = (x1 - x2) * aspect_ratio
    dy = y1 - y2

    if include_z:
        z1, z2 = _get_coord(p1, 'z'), _get_coord(p2, 'z')
        dz = (z1 - z2) * aspect_ratio
        return math.sqrt(dx * dx + dy * dy + dz * dz)
    return math.sqrt(dx * dx + dy * dy)


def check_hand_bounds(hand_landmarks, margin=0.05):
    """
    Validates whether hand landmarks are within visible frame boundaries.
    Guards against rapid frame drops, edge clipping, and out-of-camera hand positions.

    Returns:
        dict: {
            "in_bounds": bool,
            "out_of_bounds_count": int,
            "total_landmarks": int,
            "box": {"min_x": float, "max_x": float, "min_y": float, "max_y": float}
        }
    """
    if not hand_landmarks or len(hand_landmarks) == 0:
        return {
            "in_bounds": False,
            "out_of_bounds_count": 0,
            "total_landmarks": 0,
            "box": {"min_x": 0.0, "max_x": 0.0, "min_y": 0.0, "max_y": 0.0}
        }

    key_indices = [0, 4, 8, 12, 16, 20]
    xs = [_get_coord(lm, 'x') for lm in hand_landmarks]
    ys = [_get_coord(lm, 'y') for lm in hand_landmarks]

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    out_of_bounds_count = 0
    for x, y in zip(xs, ys):
        if x < -margin or x > 1.0 + margin or y < -margin or y > 1.0 + margin:
            out_of_bounds_count += 1

    wrist_x, wrist_y = xs[0], ys[0]
    wrist_in_bounds = (-margin <= wrist_x <= 1.0 + margin) and (-margin <= wrist_y <= 1.0 + margin)

    key_out_of_bounds = 0
    for idx in key_indices:
        if idx < len(hand_landmarks):
            kx, ky = xs[idx], ys[idx]
            if kx < -margin or kx > 1.0 + margin or ky < -margin or ky > 1.0 + margin:
                key_out_of_bounds += 1

    # Hand is considered in_bounds if wrist is visible, at most 1 key landmark is marginally out,
    # total out of bounds points <= 4, and full 21 landmarks exist.
    in_bounds = bool(
        len(hand_landmarks) >= 21 and
        wrist_in_bounds and
        key_out_of_bounds <= 1 and
        out_of_bounds_count <= 4
    )

    return {
        "in_bounds": in_bounds,
        "out_of_bounds_count": out_of_bounds_count,
        "total_landmarks": len(hand_landmarks),
        "box": {
            "min_x": round(min_x, 4),
            "max_x": round(max_x, 4),
            "min_y": round(min_y, 4),
            "max_y": round(max_y, 4)
        }
    }


def get_finger_states(hand_landmarks, aspect_ratio=1.0, margin=0.05):
    """
    Calculates individual finger states ('open' or 'closed') using distance heuristics
    robust to hand orientation, rotation, roll, pitch, and yaw.
    Also validates bounds to avoid false detections on dropped or partially visible hands.
    """
    default_states = {
        "thumb": "closed",
        "index": "closed",
        "middle": "closed",
        "ring": "closed",
        "pinky": "closed"
    }

    if not hand_landmarks or len(hand_landmarks) < 21:
        return default_states

    bounds = check_hand_bounds(hand_landmarks, margin=margin)
    if not bounds["in_bounds"]:
        return default_states

    dist = lambda p1, p2: calculate_landmark_distance(p1, p2, aspect_ratio=aspect_ratio)

    wrist = hand_landmarks[0]
    pinky_mcp = hand_landmarks[17]

    # For fingers (index, middle, ring, pinky):
    # Tip should be further from wrist (0) than the PIP joint (6, 10, 14, 18)
    index_open = dist(hand_landmarks[8], wrist) > dist(hand_landmarks[6], wrist)
    middle_open = dist(hand_landmarks[12], wrist) > dist(hand_landmarks[10], wrist)
    ring_open = dist(hand_landmarks[16], wrist) > dist(hand_landmarks[14], wrist)
    pinky_open = dist(hand_landmarks[20], wrist) > dist(hand_landmarks[18], wrist)

    # For thumb:
    # Tip (4) should be further from Pinky MCP (17) than Thumb IP (3) is from Pinky MCP (17)
    thumb_open = dist(hand_landmarks[4], pinky_mcp) > dist(hand_landmarks[3], pinky_mcp)

    return {
        "thumb": "open" if thumb_open else "closed",
        "index": "open" if index_open else "closed",
        "middle": "open" if middle_open else "closed",
        "ring": "open" if ring_open else "closed",
        "pinky": "open" if pinky_open else "closed"
    }


def detect_hand_gestures(hand_landmarks, custom_gestures, aspect_ratio=1.0):
    """Matches hand landmarks against custom gesture configurations."""
    states = get_finger_states(hand_landmarks, aspect_ratio=aspect_ratio)
    matched = []
    if not custom_gestures:
        return matched, states

    for g in custom_gestures:
        if g.get('type', 'hand') != 'hand':
            continue
        match = True
        for finger, req_state in g.get('fingers', {}).items():
            if req_state != 'any' and states.get(finger) != req_state:
                match = False
                break
        if match:
            matched.append(g)
    return matched, states


def detect_face_gestures(custom_gestures, blink_left, blink_right, pitch, yaw, now,
                         blink_history, head_history):
    """Matches facial blendshapes and orientation history against custom gestures."""
    matched = []

    # Determine current blinks using blendshape score thresholding
    is_blink_left = blink_left > 0.45
    is_blink_right = blink_right > 0.45

    if is_blink_left or is_blink_right:
        if not blink_history or now - blink_history[-1]['time'] > 0.3:
            blink_history.append({'time': now, 'left': is_blink_left, 'right': is_blink_right})

    # Clean old blinks (> 1.5s)
    blink_history[:] = [b for b in blink_history if now - b['time'] < 1.5]

    head_history.append({'time': now, 'pitch': pitch, 'yaw': yaw})
    head_history[:] = [h for h in head_history if now - h['time'] < 1.5]

    # Calculate max deltas for head movement
    pitches = [h['pitch'] for h in head_history]
    yaws = [h['yaw'] for h in head_history]
    pitch_delta = max(pitches) - min(pitches) if pitches else 0
    yaw_delta = max(yaws) - min(yaws) if yaws else 0

    is_nod = pitch_delta > 15.0 and yaw_delta < 12.0
    is_shake = yaw_delta > 15.0 and pitch_delta < 12.0

    # Double blink: 2 distinct blinks within 1.5s where both eyes blinked
    full_blinks = [b for b in blink_history if b['left'] and b['right']]
    is_double_blink = len(full_blinks) >= 2

    # Winks
    winks_left = [b for b in blink_history if b['left'] and not b['right']]
    winks_right = [b for b in blink_history if not b['left'] and b['right']]

    if custom_gestures:
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

    # Clear history if eye/head gesture triggered to prevent duplicate fires
    if any(g.get('type') in ['eye', 'head'] for g in matched):
        blink_history.clear()
        head_history.clear()

    return matched


class Base64FrameThrottler:
    """
    Controls base64 frame encoding and stdout serialization frequency to prevent
    OS pipe buffer saturation and severe IPC latency.

    At 60 FPS, unthrottled base64 JPEG encoding emits ~1.5 - 2.5 MB/s of text over
    stdout, filling the pipe buffer and causing seconds of latency backlog.
    This throttler limits frame JPEG serialization to target_fps (default 10 FPS),
    reducing serialized stdout payload by >95% while keeping gesture interactions
    at full real-time frame rates.
    """
    def __init__(self, target_fps=10.0, enabled=True, jpeg_quality=50, target_size=(320, 240)):
        self.target_fps = float(target_fps)
        self.interval = (1.0 / self.target_fps) if self.target_fps > 0 else float('inf')
        self.enabled = bool(enabled and self.target_fps > 0)
        self.jpeg_quality = int(jpeg_quality)
        self.target_size = tuple(target_size)
        self.last_encoded_time = 0.0
        self.encoded_frame_count = 0
        self.throttled_frame_count = 0

    def should_encode(self, now=None):
        if not self.enabled:
            return False
        if now is None:
            now = time.time()
        return (now - self.last_encoded_time) >= self.interval

    def encode_frame(self, frame, now=None):
        """
        Encodes frame to base64 JPEG if the throttle interval has elapsed.
        Returns:
            tuple: (b64_string or None, was_encoded: bool)
        """
        if not self.should_encode(now=now):
            self.throttled_frame_count += 1
            return None, False

        if frame is None or getattr(frame, 'size', 0) == 0:
            return None, False

        if now is None:
            now = time.time()

        try:
            small_frame = cv2.resize(frame, self.target_size)
            ret, buffer = cv2.imencode('.jpg', small_frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
            if ret:
                self.last_encoded_time = now
                self.encoded_frame_count += 1
                b64_str = base64.b64encode(buffer).decode('utf-8')
                return b64_str, True
        except Exception:
            pass

        return None, False

    def process_payload(self, payload, frame, now=None):
        """
        Attaches frame_b64 conditionally to payload when interval elapsed.
        Always sets b64_included flag for clear IPC contracts.
        """
        b64_str, was_encoded = self.encode_frame(frame, now=now)
        if was_encoded and b64_str:
            payload["frame_b64"] = b64_str
            payload["b64_included"] = True
        else:
            payload.pop("frame_b64", None)
            payload["b64_included"] = False
        return was_encoded


class LocalVisionBrain:
    """
    Local vision engine coordinator for gesture recognition, face/gaze tracking,
    and throttled IPC stdout communication.
    """
    def __init__(
        self,
        gesture_file_path=None,
        hold_time_required=1.2,
        target_fps=10.0,
        stream_frames=True,
        target_min=0.42,
        target_max=0.58,
        low_light_threshold=40.0,
    ):
        self.gesture_file_path = gesture_file_path
        self.hold_time_required = hold_time_required
        self.target_min = target_min
        self.target_max = target_max
        self.low_light_threshold = low_light_threshold

        self.gaze_start_time = None
        self.gesture_states = {}
        self.blink_history = []
        self.head_history = []

        self.custom_gestures = []
        self.load_gestures()

        self.throttler = Base64FrameThrottler(
            target_fps=target_fps,
            enabled=stream_frames,
            jpeg_quality=50,
            target_size=(320, 240)
        )

    def load_gestures(self):
        if self.gesture_file_path:
            try:
                with open(self.gesture_file_path, 'r') as f:
                    self.custom_gestures = json.load(f)
                    return self.custom_gestures
            except Exception:
                pass
        self.custom_gestures = []
        return self.custom_gestures

    def process_frame_data(
        self,
        frame,
        face_landmarks_list=None,
        face_blendshapes=None,
        facial_transformation_matrixes=None,
        hand_landmarks_list=None,
        now=None
    ):
        """
        Processes vision frame data and returns the structured payload and any triggered events.
        Decoupled from webcam capture for unit testing and modular orchestration.
        """
        if now is None:
            now = time.time()

        # Aspect ratio for distance calculations
        aspect_ratio = 1.0
        is_low_light = False
        if frame is not None and getattr(frame, 'shape', None) is not None:
            h, w = frame.shape[:2]
            if h > 0:
                aspect_ratio = w / h
            mean_brightness = float(np.mean(frame))
            is_low_light = bool(mean_brightness < self.low_light_threshold)

        payload = {
            "type": "vision-update",
            "timestamp": round(now, 4),
            "low_light": is_low_light,
            "face_found": False,
            "face_mesh_points": [],
            "hands": []
        }

        triggered_events = []
        current_gestures = []

        # Process face landmarks
        if face_landmarks_list and len(face_landmarks_list) > 0:
            payload["face_found"] = True
            face_landmarks = face_landmarks_list[0]

            pt33 = face_landmarks[33]
            pt133 = face_landmarks[133]
            pt468 = face_landmarks[468]
            pt473 = face_landmarks[473]

            left_x = min(_get_coord(pt33, 'x'), _get_coord(pt133, 'x'))
            right_x = max(_get_coord(pt33, 'x'), _get_coord(pt133, 'x'))

            if right_x - left_x > 0:
                relative_position = (_get_coord(pt468, 'x') - left_x) / (right_x - left_x)
            else:
                relative_position = 0.0

            payload["iris"] = {
                "left": {"x": round(_get_coord(pt468, 'x'), 4), "y": round(_get_coord(pt468, 'y'), 4)},
                "right": {"x": round(_get_coord(pt473, 'x'), 4), "y": round(_get_coord(pt473, 'y'), 4)}
            }

            xs = [_get_coord(lm, 'x') for lm in face_landmarks]
            ys = [_get_coord(lm, 'y') for lm in face_landmarks]
            payload["face_box"] = {
                "min_x": round(min(xs), 4),
                "max_x": round(max(xs), 4),
                "min_y": round(min(ys), 4),
                "max_y": round(max(ys), 4)
            }

            downsampled = [
                {"x": round(_get_coord(lm, 'x'), 4), "y": round(_get_coord(lm, 'y'), 4)}
                for i, lm in enumerate(face_landmarks) if i % 10 == 0
            ]
            payload["face_mesh_points"] = downsampled

            blink_left = 0.0
            blink_right = 0.0
            if face_blendshapes and len(face_blendshapes) > 0:
                for cat in face_blendshapes[0]:
                    cat_name = getattr(cat, 'category_name', '')
                    cat_score = getattr(cat, 'score', 0.0)
                    if cat_name == 'eyeBlinkLeft':
                        blink_left = cat_score
                    elif cat_name == 'eyeBlinkRight':
                        blink_right = cat_score

            pitch, yaw = 0.0, 0.0
            if facial_transformation_matrixes and len(facial_transformation_matrixes) > 0:
                matrix = facial_transformation_matrixes[0]
                sy = math.sqrt(matrix[0, 0]**2 + matrix[1, 0]**2)
                if sy > 1e-6:
                    pitch = math.atan2(matrix[2, 1], matrix[2, 2]) * 180.0 / math.pi
                    yaw = math.atan2(-matrix[2, 0], sy) * 180.0 / math.pi
                else:
                    pitch = math.atan2(-matrix[1, 2], matrix[1, 1]) * 180.0 / math.pi
                    yaw = math.atan2(-matrix[2, 0], sy) * 180.0 / math.pi

            face_matched = detect_face_gestures(
                self.custom_gestures, blink_left, blink_right, pitch, yaw, now,
                self.blink_history, self.head_history
            )
            for mg in face_matched:
                current_gestures.append(mg)

            # Gaze holding logic
            if self.target_min <= relative_position <= self.target_max:
                if self.gaze_start_time is None:
                    self.gaze_start_time = now
                elif now - self.gaze_start_time >= self.hold_time_required:
                    triggered_events.append({"type": "vision-wake"})
                    self.gaze_start_time = None
            else:
                self.gaze_start_time = None
        else:
            self.gaze_start_time = None

        # Process hand landmarks
        if hand_landmarks_list:
            for hand_landmarks in hand_landmarks_list:
                pts = [
                    {"x": round(_get_coord(lm, 'x'), 4), "y": round(_get_coord(lm, 'y'), 4)}
                    for lm in hand_landmarks
                ]
                bounds = check_hand_bounds(hand_landmarks)
                matched_gestures, states = detect_hand_gestures(
                    hand_landmarks, self.custom_gestures, aspect_ratio=aspect_ratio
                )

                display_gesture = matched_gestures[0]['name'] if matched_gestures else "none"
                for mg in matched_gestures:
                    current_gestures.append(mg)

                payload["hands"].append({
                    "landmarks": pts,
                    "gesture": display_gesture,
                    "finger_states": states,
                    "bounds": bounds,
                    "in_bounds": bounds["in_bounds"]
                })

        # Process gesture hold actions with cooldown
        active_actions = {g['action']: g for g in current_gestures}
        for action, g in active_actions.items():
            if action not in self.gesture_states:
                self.gesture_states[action] = now
            elif now - self.gesture_states[action] >= self.hold_time_required:
                triggered_events.append({
                    "type": "vision-gesture",
                    "gesture": g['name'],
                    "action": action,
                    "actionArg": g.get('actionArg')
                })
                # 1.5 second cooldown to avoid spamming
                self.gesture_states[action] = now + 1.5

        inactive_actions = [a for a in list(self.gesture_states.keys()) if a not in active_actions]
        for a in inactive_actions:
            if self.gesture_states[a] < now:
                del self.gesture_states[a]

        # Throttled base64 frame serialization
        if frame is not None:
            self.throttler.process_payload(payload, frame, now=now)
        else:
            payload["b64_included"] = False

        return payload, triggered_events

    def draw_debug_annotations(self, frame, face_landmarks_list, hand_landmarks_list):
        """Draws visual skeleton indicators onto frame."""
        if frame is None:
            return frame

        h, w = frame.shape[:2]
        if face_landmarks_list:
            for face_landmarks in face_landmarks_list:
                for i, lm in enumerate(face_landmarks):
                    if i % 15 == 0:
                        cv2.circle(frame, (int(_get_coord(lm, 'x') * w), int(_get_coord(lm, 'y') * h)), 1, (100, 100, 100), -1)

        if hand_landmarks_list:
            for hand_landmarks in hand_landmarks_list:
                states = get_finger_states(hand_landmarks)
                pixel_pts = [
                    (int(_get_coord(lm, 'x') * w), int(_get_coord(lm, 'y') * h))
                    for lm in hand_landmarks
                ]

                # Draw Connections
                for p1, p2 in HAND_CONNECTIONS:
                    if p1 >= len(pixel_pts) or p2 >= len(pixel_pts):
                        continue
                    is_palm = (p1 in [0, 5, 9, 13, 17] and p2 in [0, 5, 9, 13, 17])
                    color = (255, 255, 255)
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

                # Draw Joints
                for i, pt in enumerate(pixel_pts):
                    if i in [4, 8, 12, 16, 20]:
                        cv2.circle(frame, pt, 7, (255, 0, 0), -1)
                        cv2.circle(frame, pt, 8, (0, 0, 255), 2)
                    elif i == 0:
                        cv2.circle(frame, pt, 6, (255, 255, 255), -1)
                    else:
                        color = (200, 200, 200)
                        if i in [1, 2, 3]:
                            color = (0, 255, 0) if states['thumb'] == 'open' else (0, 0, 255)
                        elif i in [5, 6, 7]:
                            color = (0, 255, 0) if states['index'] == 'open' else (0, 0, 255)
                        elif i in [9, 10, 11]:
                            color = (0, 255, 0) if states['middle'] == 'open' else (0, 0, 255)
                        elif i in [13, 14, 15]:
                            color = (0, 255, 0) if states['ring'] == 'open' else (0, 0, 255)
                        elif i in [17, 18, 19]:
                            color = (0, 255, 0) if states['pinky'] == 'open' else (0, 0, 255)
                        cv2.circle(frame, pt, 5, color, -1)

        return frame


def process_vision():
    """CLI runtime entry point for webcam processing loop."""
    script_dir = os.path.dirname(os.path.abspath(__file__))

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

    gesture_file_path = sys.argv[1] if len(sys.argv) > 1 else None
    stream_fps = float(os.environ.get("VISION_STREAM_FPS", 10.0))
    stream_frames = os.environ.get("VISION_STREAM_FRAMES", "1") != "0"

    brain = LocalVisionBrain(
        gesture_file_path=gesture_file_path,
        hold_time_required=1.2,
        target_fps=stream_fps,
        stream_frames=stream_frames,
    )

    try:
        while True:
            success, frame = cap.read()
            if not success:
                print(json.dumps({"type": "error", "message": "Frame drop"}))
                sys.stdout.flush()
                time.sleep(0.1)
                continue

            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)

            results_face = face_mesh.detect(mp_image)
            results_hands = hands.detect(mp_image)

            # Reload gestures dynamically if file changes
            brain.load_gestures()

            # Render visual debugging overlay on the frame before encoding
            brain.draw_debug_annotations(
                frame,
                results_face.face_landmarks if results_face else None,
                results_hands.hand_landmarks if results_hands else None
            )

            now = time.time()
            payload, events = brain.process_frame_data(
                frame,
                face_landmarks_list=results_face.face_landmarks if results_face else None,
                face_blendshapes=results_face.face_blendshapes if results_face else None,
                facial_transformation_matrixes=results_face.facial_transformation_matrixes if results_face else None,
                hand_landmarks_list=results_hands.hand_landmarks if results_hands else None,
                now=now
            )

            # Emit triggered events first
            for event in events:
                print(json.dumps(event))
                sys.stdout.flush()

            # Emit throttled vision update
            print(json.dumps(payload))
            sys.stdout.flush()

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

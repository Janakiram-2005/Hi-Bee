import os
import re
import sys
import time
import datetime
import asyncio
from typing import Callable, Optional, Dict, Tuple, Union

import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig, Part
from vertexai.preview.caching import CachedContent

import os_dom_engine.win32_api

def clean_id_token(text: str) -> str:
    """
    Sanitize text fragments returned by VLM.
    Strips whitespaces, newlines, markdown formatting elements (*, `, etc.),
    leaving only raw alphanumeric characters and underscores.
    """
    cleaned = text.strip().replace("\n", "").replace("\r", "")
    # Strip leading/trailing markdown characters, spaces, dashes or underscores
    cleaned = re.sub(r'^[*`\s_-]+|[*`\s_-]+$', '', cleaned)
    # Strip other punctuation except internal alphanumeric and underscores
    cleaned = re.sub(r'[^a-zA-Z0-9_]', '', cleaned)
    return cleaned

def check_match(accumulated_str: str, active_map: dict) -> Optional[str]:
    """
    Check if the current accumulated text buffer matches any known UI key in active_map.
    Supports exact matching and suffix-based matching (e.g. if buffer ends with a key).
    """
    cleaned = clean_id_token(accumulated_str).lower()
    if not cleaned:
        return None
        
    # 1. Look for exact match
    for key in active_map.keys():
        if key == cleaned:
            return key
            
    # 2. Look for suffix match (e.g. "selection btn_4" or "target 14")
    # Sort keys by length descending to match the most specific identifier first (e.g. btn_14 over 14)
    sorted_keys = sorted(active_map.keys(), key=len, reverse=True)
    for key in sorted_keys:
        if cleaned.endswith(key):
            return key
            
    return None

class ContextCacheManager:
    """
    Manages the creation and rotation of Vertex AI CachedContent resources on the server side.
    Maintains a 10-minute TTL and recreates the cache after 9 minutes to prevent expiration.
    """
    _cached_content = None
    _cache_created_time = 0.0

    @classmethod
    def get_or_create_cache(cls, model_name: str, project_id: str, location: str) -> Optional[CachedContent]:
        now = time.time()
        # If cache is valid (created less than 9 minutes ago), reuse it
        if cls._cached_content and (now - cls._cache_created_time < 540):
            return cls._cached_content

        print(f"[ContextCache] Registering new server-side Context Cache for {model_name}...")
        static_heuristics = (
            "System parameters: Windows OS environment, layout parsed via UIA DOM or fallback tags.\n"
            "Navigation heuristics: To click an item, identify its raw alphanumeric ID (e.g. btn_4 or visual index tag 14).\n"
            "Layout alignment rules: Always click the center of the element rectangle. Match tag indexes exactly.\n"
            "App-specific rules: Notepad and common windows standard UIA components should be preferred. Visual fallback applies when DOM is absent."
        )

        try:
            cls._cached_content = CachedContent.create(
                model_name=model_name,
                contents=[static_heuristics],
                ttl=datetime.timedelta(minutes=10),
                display_name="vlm_heuristics_cache"
            )
            cls._cache_created_time = now
            print(f"[ContextCache] Server-side cache created successfully: {cls._cached_content.name}")
        except Exception as e:
            print(f"[WARNING] ContextCache: Failed to create server-side cache. Falling back to non-cached mode. Error: {e}")
            cls._cached_content = None

        return cls._cached_content


class VLMClient:
    """
    Vertex AI Gemini Streaming and Caching Client interface.
    Controls low-latency token streaming loops and checks for window coordinate drift race conditions.
    """
    def __init__(self, project_id: str = None, location: str = None, model_name: str = "gemini-2.5-flash"):
        self.project_id = project_id or os.environ.get("VERTEX_VLM_PROJECT_ID") or os.environ.get("VERTEX_PROJECT_ID") or ""
        self.location = location or os.environ.get("VERTEX_VLM_LOCATION") or os.environ.get("VERTEX_LOCATION") or "us-central1"
        self.model_name = model_name

        if self.project_id:
            print(f"[VLMClient] Initializing Vertex AI in project: {self.project_id}, location: {self.location}")
            vertexai.init(project=self.project_id, location=self.location)
        else:
            print("[WARNING] VLMClient: No Google Cloud Project ID provided. API requests will fail unless ADC is configured.")

    async def generate_target_id_async(
        self,
        hwnd: int,
        command: str,
        layout: dict,
        screenshot_bytes: bytes,
        active_map: dict,
        on_ttft_callback: Optional[Callable[[float], None]] = None
    ) -> str:
        """
        Connects to the Vertex AI API stream asynchronously.
        Iterates over token fragments and resolves the target ID the exact millisecond it is matched.
        Ensures strict hyperparameter controls and verifies window drift in real-time.
        """
        # 1. Setup deterministic generation configurations
        config = GenerationConfig(
            max_output_tokens=20,
            temperature=0.0
        )

        system_instruction = (
            "You are an embedded operating system automation execution module. "
            "Analyze the input screenshot/JSON layout. Return only the raw alphanumeric ID matching the target item. "
            "Do not include markdown wraps, conversational prefixes, punctuation, or trailing explanations."
        )

        # 2. Get or initialize Context Cache
        cached_content = None
        if self.project_id:
            cached_content = ContextCacheManager.get_or_create_cache(self.model_name, self.project_id, self.location)

        # 3. Instantiate Model
        if cached_content:
            # Load model instance with pre-processed server-side cache
            model = GenerativeModel.from_cached_content(
                cached_content=cached_content,
                generation_config=config
            )
        else:
            # Fallback to standard model instantiation
            model = GenerativeModel(
                model_name=self.model_name,
                system_instruction=system_instruction,
                generation_config=config
            )

        # 4. Prepare image and instructions payload
        image_part = Part.from_data(data=screenshot_bytes, mime_type="image/png")
        
        # Prepare layout list text
        layout_elements_str = ""
        if layout["mode"] == "dom":
            layout_elements = []
            for el in layout["elements"]:
                layout_elements.append(f"ID: {el.get('id')}, Name: {el.get('name')}, Type: {el.get('type')}, Rect: {el.get('rect')}")
            layout_elements_str = "\n".join(layout_elements)
        else:
            layout_elements = []
            for el in layout["elements"]:
                layout_elements.append(f"Tag: {el.get('index')}, Type: {el.get('type')}, Text: {el.get('text')}")
            layout_elements_str = "\n".join(layout_elements)

        user_prompt = (
            f"Active Window Mode: {layout['mode']}\n"
            f"User Action Command: '{command}'\n\n"
            f"Interactable elements layout:\n{layout_elements_str}\n\n"
            f"Analyze the screenshot and return the matched raw element ID or visual tag to execute the user's action."
        )

        contents = [image_part, user_prompt]

        # 5. Lock initial window bounds to monitor moving target hazards
        initial_rect = os_dom_engine.win32_api.get_window_rect(hwnd)
        if not initial_rect:
            raise RuntimeError("Target window handle invalidated before API dispatch.")

        # 6. Dispatch streaming request
        print(f"[VLMClient] Invoking non-blocking async stream using {self.model_name}...")
        start_time = time.perf_counter()
        ttft_recorded = False

        # Request options with cached content display references if available
        request_kwargs = {
            "contents": contents,
            "stream": True
        }

        response_stream = await model.generate_content_async(**request_kwargs)

        accumulated_text = ""
        matched_key = None

        # Iterate over network fragments
        async for chunk in response_stream:
            # Measure Time-To-First-Token (TTFT)
            if not ttft_recorded:
                ttft_recorded = True
                ttft_duration = (time.perf_counter() - start_time) * 1000.0
                if on_ttft_callback:
                    on_ttft_callback(ttft_duration)
                print(f"[VLMClient] Time-to-First-Token (TTFT): {ttft_duration:.2f} ms")

            # Check window drift boundaries dynamically during streaming
            current_rect = os_dom_engine.win32_api.get_window_rect(hwnd)
            if current_rect:
                c_left, c_top, c_w, c_h = initial_rect
                n_left, n_top, n_w, n_h = current_rect
                if (abs(n_left - c_left) > 3 or 
                    abs(n_top - c_top) > 3 or 
                    abs(n_w - c_w) > 3 or 
                    abs(n_h - c_h) > 3):
                    raise RuntimeError(
                        f"Window moved/resized during streaming (drift: "
                        f"dx={abs(n_left - c_left)}, dy={abs(n_top - c_top)}). Aborting stream."
                    )

            # Append text fragment
            chunk_text = chunk.text
            if chunk_text:
                accumulated_text += chunk_text
                # Perform regex pattern validation against active dictionary keys
                matched_key = check_match(accumulated_text, active_map)
                if matched_key:
                    print(f"[VLMClient] Fragment match detected on buffer: '{accumulated_text}' -> Key: '{matched_key}'")
                    # Terminate streaming instantly, bypassing remaining text
                    break

        if not matched_key:
            # Clean final text once more as fallback
            cleaned_final = clean_id_token(accumulated_text).lower()
            if cleaned_final in active_map:
                matched_key = cleaned_final
            else:
                raise ValueError(f"VLM responded with '{accumulated_text}' which does not resolve to a valid element.")

        return matched_key

    def generate_target_id(
        self,
        hwnd: int,
        command: str,
        layout: dict,
        screenshot_bytes: bytes,
        active_map: dict,
        on_ttft_callback: Optional[Callable[[float], None]] = None
    ) -> str:
        """
        Synchronous wrapper execution utilizing the async client.
        Enables seamless execution within standard background threads.
        """
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        return loop.run_until_complete(
            self.generate_target_id_async(
                hwnd, command, layout, screenshot_bytes, active_map, on_ttft_callback
            )
        )

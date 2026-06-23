import os
import re
import sys
import time
import datetime
import asyncio
import base64
from typing import Callable, Optional, Dict, Tuple, Union

import anthropic

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

class VLMClient:
    """
    Anthropic API Claude Streaming Client interface.
    Controls low-latency token streaming loops and checks for window coordinate drift race conditions.
    """
    def __init__(self, api_key: str = None, model_name: str = "claude-3-5-sonnet-20241022"):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model_name = model_name

        if self.api_key:
            print(f"[VLMClient] Initializing Anthropic API with model: {self.model_name}")
            self.client = anthropic.AsyncAnthropic(api_key=self.api_key)
        else:
            print("[WARNING] VLMClient: No ANTHROPIC_API_KEY provided. API requests will fail.")
            self.client = None

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
        Connects to the Anthropic API stream asynchronously.
        Iterates over token fragments and resolves the target ID the exact millisecond it is matched.
        Ensures strict hyperparameter controls and verifies window drift in real-time.
        """
        system_instruction = (
            "You are an embedded operating system automation execution module. "
            "Analyze the input screenshot/JSON layout. Return only the raw alphanumeric ID matching the target item. "
            "Do not include markdown wraps, conversational prefixes, punctuation, or trailing explanations.\n"
            "System parameters: Windows OS environment, layout parsed via UIA DOM or fallback tags.\n"
            "Navigation heuristics: To click an item, identify its raw alphanumeric ID (e.g. btn_4 or visual index tag 14).\n"
            "Layout alignment rules: Always click the center of the element rectangle. Match tag indexes exactly.\n"
            "App-specific rules: Notepad and common windows standard UIA components should be preferred. Visual fallback applies when DOM is absent."
        )

        # Base64 encode the image
        image_b64 = base64.b64encode(screenshot_bytes).decode("utf-8")
        
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

        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": image_b64,
                        }
                    },
                    {
                        "type": "text",
                        "text": user_prompt
                    }
                ]
            }
        ]

        # 5. Lock initial window bounds to monitor moving target hazards
        initial_rect = os_dom_engine.win32_api.get_window_rect(hwnd)
        if not initial_rect:
            raise RuntimeError("Target window handle invalidated before API dispatch.")

        if not self.client:
            raise ValueError("Anthropic client is not initialized. Please set ANTHROPIC_API_KEY in your environment variables.")

        # 6. Dispatch streaming request
        print(f"[VLMClient] Invoking non-blocking async stream using {self.model_name}...")
        start_time = time.perf_counter()
        ttft_recorded = False

        accumulated_text = ""
        matched_key = None

        try:
            async with self.client.messages.stream(
                model=self.model_name,
                max_tokens=20,
                system=system_instruction,
                messages=messages
            ) as stream:
                async for text in stream.text_stream:
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
                    if text:
                        accumulated_text += text
                        # Perform regex pattern validation against active dictionary keys
                        matched_key = check_match(accumulated_text, active_map)
                        if matched_key:
                            print(f"[VLMClient] Fragment match detected on buffer: '{accumulated_text}' -> Key: '{matched_key}'")
                            # Terminate streaming instantly, bypassing remaining text
                            break
        except Exception as e:
            print(f"[VLMClient] Error during API streaming: {e}")
            raise

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

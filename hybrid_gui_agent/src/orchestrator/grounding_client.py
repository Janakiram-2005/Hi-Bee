import os
import json
import re
import asyncio
from typing import Optional, Dict

import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig, Part

class GroundingAgentClient:
    """
    Ultra-precise GUI Grounding Agent.
    Operates solely on visual parsing and returns coordinate points normalized [0, 1000].
    """
    def __init__(self, project_id: str = None, location: str = None, model_name: str = "gemini-2.5-flash"):
        self.project_id = project_id or os.environ.get("VERTEX_VLM_PROJECT_ID") or os.environ.get("VERTEX_PROJECT_ID") or ""
        self.location = location or os.environ.get("VERTEX_VLM_LOCATION") or os.environ.get("VERTEX_LOCATION") or "us-central1"
        self.model_name = model_name

        if self.project_id:
            print(f"[GroundingAgent] Initializing Vertex AI in project: {self.project_id}, location: {self.location}")
            vertexai.init(project=self.project_id, location=self.location)

    async def get_target_coordinates_async(self, command: str, screenshot_bytes: bytes) -> dict:
        system_instruction = (
            "# ROLE AND OBJECTIVE\n"
            "You are an ultra-precise GUI Grounding Agent acting as the semantic core of an automated operating system interaction pipeline. "
            "Your objective is to look at a high-resolution GUI screenshot and determine the most mathematically sound coordinate point or bounding box for a given user request.\n"
            "This model hub includes a finetuned version of YOLOv8 and a finetuned Florence-2 base model on the above dataset respectively if this improves efficiency.\n\n"
            "Since you reason in a normalized coordinate space [0, 1000], your outputs will be refined by a local precision computer vision engine (snapping loop). "
            "You must provide clear structural bounding containers or centroid points to ensure a flawless pixel snap.\n\n"
            "# COORDINATE SYSTEM SPECIFICATIONS\n"
            "- All coordinates must be normalized to a scale of 0 to 1000.\n"
            "- Point format: [X, Y] (where X is distance from left, Y is distance from top).\n"
            "- Box format: [ymin, xmin, ymax, xmax].\n"
            "- Target the exact interactive structural center of the element, not its textual label or trailing whitespace, unless explicitly asked to interact with the text.\n\n"
            "# ANCHOR SELECTION STRATEGY FOR ~100% ACCURACY\n"
            "To assist the local Computer Vision snapping engine, follow these strict element extraction rules:\n"
            "1. FOR ICONS / BUTTONS: Bound the absolute outer geometric perimeter of the asset. Avoid clipping decorative borders.\n"
            "2. FOR TEXT LINKS / LETTERS: Return the box enclosing the precise word boundary. Do not include surrounding margins or empty layout container padding.\n"
            "3. FOR INPUT FIELDS: Target the center coordinates of the inner text cursor box location, or provide a box bounding the input box lines.\n"
            "4. FOR DROPDOWNS / LIST ITEMS: Target the precise text centroid inside the targeted row item.\n\n"
            "# THOUGHT CHAIN PATTERN (CoT)\n"
            "Before declaring the action coordinate, you must reason step-by-step using the following strict structure wrapped in <thought_chain> tags:\n"
            "1. Identify the requested target element description, label, or purpose.\n"
            "2. Scan the layout coordinates visually to isolate parent structural containers (e.g., sidebars, windows, divs).\n"
            "3. Compute the rough coordinate bounds on the [0, 1000] canvas scale.\n"
            "4. Verify whether the element is clickable, focused, obscured, or within a scrollable frame.\n\n"
            "# OUTPUT FORMAT SPECIFICATIONS\n"
            "Your final answer must match one of these strict formats after the thought block. Do not append conversational text or explanations outside the tags.\n"
            "Format 1 (Click / Hover Actions):\n"
            "```json\n"
            "{\n"
            '  "action": "CLICK",\n'
            '  "target_description": "Exact name or class of the div/button/icon",\n'
            '  "point": [X, Y],\n'
            '  "rough_roi_box": [ymin, xmin, ymax, xmax]\n'
            "}\n"
            "```"
        )

        config = GenerationConfig(
            temperature=0.0
        )

        model = GenerativeModel(
            model_name=self.model_name,
            system_instruction=system_instruction,
            generation_config=config
        )

        image_part = Part.from_data(data=screenshot_bytes, mime_type="image/png")
        user_prompt = f"User Action Command: '{command}'\nAnalyze the screenshot and return the thought chain and JSON response."
        
        print(f"[GroundingAgent] Querying {self.model_name} for visual semantic coordinates...")
        response = await model.generate_content_async([image_part, user_prompt])
        
        try:
            # Safely extract all text parts from the response since response.text crashes on multiple parts
            full_text = ""
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, "text"):
                        full_text += part.text
            else:
                try:
                    full_text = response.text
                except Exception:
                    full_text = str(response)

            # Use regex to extract the JSON block out of the text
            json_match = re.search(r"\{.*\}", full_text, re.DOTALL)
            if not json_match:
                raise ValueError("No JSON block found in the response.")
            
            parsed_data = json.loads(json_match.group(0))
            print(f"[GroundingAgent] Parsed visual coordinates successfully: {parsed_data.get('point')}")
            return parsed_data
        except Exception as e:
            raise ValueError(f"Failed to parse Grounding Agent JSON response: {e}\nRaw Response: {str(response)}")

    def get_target_coordinates(self, command: str, screenshot_bytes: bytes) -> dict:
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop.run_until_complete(self.get_target_coordinates_async(command, screenshot_bytes))

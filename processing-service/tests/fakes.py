import json
from dataclasses import dataclass, field

from app.services.gemini import GenerationResult

VALID_SUMMARY = {
    "title": "How Urban Trees Cool Cities",
    "overview": (
        "Researchers comparing twelve European cities found that neighbourhoods with dense tree canopy are "
        "consistently cooler. The cooling benefit is unevenly distributed, with lower-income districts having far less shade."
    ),
    "sections": [
        {
            "heading": "How trees lower temperatures",
            "content": "Leaves block sunlight and evapotranspiration draws heat from the air.",
        },
        {
            "heading": "Unequal access to shade",
            "content": "Lower-income districts have less canopy because of planning history.",
        },
    ],
    "key_takeaways": [
        "Dense canopy makes neighbourhoods several degrees cooler.",
        "Trees cool through shade and evapotranspiration.",
        "Lower-income districts have less canopy.",
        "Young trees take a decade or more to cool meaningfully.",
        "Protecting mature trees matters as much as planting new ones.",
    ],
    "concepts": [
        {"term": "Evapotranspiration", "explanation": "Release of water vapour by leaves, which cools the air."}
    ],
    "main_arguments": ["Urban forests are a cost-effective way to adapt cities to heat, if funding is sustained."],
}


@dataclass
class FakeGenerator:
    """Stands in for Gemini. Returns queued responses (str/dict) or raises queued exceptions."""

    responses: list = field(default_factory=lambda: [VALID_SUMMARY])
    model: str = "fake-gemini"
    calls: list = field(default_factory=list)

    async def generate_structured(self, *, system_instruction, prompt, response_schema, **options):
        self.calls.append(
            {"system_instruction": system_instruction, "prompt": prompt, "schema": response_schema, **options}
        )
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        text = item if isinstance(item, str) or item is None else json.dumps(item)
        return GenerationResult(text=text, finish_reason="STOP", input_tokens=1200, output_tokens=400)

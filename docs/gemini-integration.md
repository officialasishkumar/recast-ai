# Gemini Integration

Recast AI hands the entire screen recording to the Google Gemini File API as a single multimodal input, then asks the model for a schema-constrained JSON transcript. This document covers why we picked a whole-video approach, how the file lifecycle works, cost ranges, and how we defend against failure modes and prompt injection.

## Why Whole-Video Analysis Beats Per-Frame Sampling

The previous architecture sampled frames at 1 fps, captioned each frame, and stitched the captions into a narration. That approach has three structural problems that the File API resolves:

- **Token savings.** Sending 600 JPEGs as inline image parts burns roughly 600 x 258 image tokens plus per-frame structural overhead. A single video reference is billed on actual video duration, not on the number of frames we cared to sample.
- **Motion and temporal context.** Per-frame captions cannot see a cursor move, a modal animate in, or a loading spinner transition to a success state. The Gemini video tokenizer preserves temporal coherence, which shows up as more accurate scene boundaries.
- **Audio channel.** The video file carries any narration the user already recorded, UI sound effects, and music beds. Gemini processes the audio jointly with the video, giving us a stronger language signal than OCR alone.

## File API Flow

The video-analyzer service uses the `google-genai` Python SDK. The full path is: download the MinIO object to a temp file, upload to Gemini, poll for `ACTIVE`, invoke `generate_content` with `response_schema`, validate, persist, delete the remote file.

```python
from google import genai
from google.genai import types
import time

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

uploaded = client.files.upload(
    file=local_video_path,
    config={"mime_type": "video/mp4"},
)

for _ in range(60):
    if uploaded.state.name == "ACTIVE":
        break
    if uploaded.state.name not in {"PROCESSING", "ACTIVE"}:
        raise RuntimeError(f"Gemini upload failed: {uploaded.state.name}")
    time.sleep(2)
    uploaded = client.files.get(name=uploaded.name)
else:
    raise RuntimeError("Gemini file never reached ACTIVE state")

response = client.models.generate_content(
    model="gemini-2.5-pro",
    contents=[uploaded, build_user_prompt(style, language, duration_ms)],
    config=types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=TRANSCRIPT_SCHEMA,
        temperature=0.2,
    ),
)

segments = validate_segments(response.parsed)
persist_segments(job_id, segments)

client.files.delete(name=uploaded.name)
```

## Token Cost Rundown

Gemini bills video content at roughly **300 tokens per second** at the default media resolution and roughly **100 tokens per second** at the low-resolution setting. Two reference points:

- A 5-minute recording at default resolution is around 90k input tokens.
- A 10-minute recording at default resolution is around 180k input tokens.

At the 2026 `gemini-2.5-pro` list price of around $1.25 per 1M input tokens and around $10 per 1M output tokens, a 10-minute analysis typically costs in the low cents for input and well under a cent for the JSON output. These numbers are approximate and should be treated as order-of-magnitude estimates rather than commitments.

For recordings longer than 30 minutes we recommend switching to `gemini-2.5-flash`, which has a materially lower price per input token at the cost of modest transcript-quality regression. The video-analyzer selects the model based on probed duration; operators can override with `GEMINI_MODEL`.

## Polling Strategy

After `files.upload` the file starts in `PROCESSING`. We poll `files.get` every **2 seconds** for up to **60 attempts** (two minutes of wall time). A file that never reaches `ACTIVE` is treated as a hard failure and the job goes to the `ingestion.queue.dlq`.

## Schema-Constrained Output

We pass a strict JSON schema through `response_schema` so the model is forced into a well-formed shape (`segment_id`, `start_ms`, `end_ms`, `text`, `confidence`). This virtually eliminates the "malformed JSON" error class that plagued the per-frame pipeline, because the SDK's structured output path returns already-parsed Python objects that we then re-validate against our own Pydantic model.

## Word-Level Timings

Gemini does **not** produce reliable word-level timings from visual-only transcription, so we do not ask for them. Word timings come from the TTS layer:

- **ElevenLabs:** the `alignment` response contains per-character start and end milliseconds; the tts-service aggregates these into per-word ranges.
- **AWS Polly:** the service requests `SpeechMarks` of type `word` alongside the synthesis and uses those directly.
- **gTTS and any provider without native timings:** the tts-service assigns each word a slice of the segment duration proportional to its character count.

In every case the final `words_json` column on `transcript_segments` carries the canonical timings used downstream.

## Failure Modes

| Failure | Handling |
|---|---|
| 429 rate limit from Gemini | Exponential backoff (2s, 4s, 8s, 16s, 32s) with jitter; fail to DLQ after five attempts. |
| 5xx from Gemini | Same exponential backoff; the message is nacked and redelivered until the retry budget is exhausted. |
| Response fails schema validation | One retry with a strict reminder appended to the prompt. On second failure the message routes to the DLQ. |
| File state remains `PROCESSING` after 60 polls | Abort, attempt to delete the remote file, route to DLQ. |
| File state becomes `FAILED` | Abort, delete the remote file, route to DLQ with the Gemini failure reason attached. |

Every failure path attempts `client.files.delete` in a `try/finally` so remote artifacts do not accumulate.

## Prompt Injection Defense

User-supplied videos can contain on-screen text or narration that tries to manipulate the model. Our defenses are layered:

- **Schema first.** The response shape is constrained by `response_schema`, so text instructions in the video cannot rewrite the contract.
- **System instruction.** The system prompt explicitly tells the model to treat any text visible on screen as content to describe, not as instructions to follow.
- **No user-controlled system prompt.** Users choose only `style` (`formal` or `casual`) and `language`. Both are validated against an allow-list before they are formatted into the user prompt.
- **Output scrubbing.** Before persistence, segments are checked for zero-width characters and suspicious control sequences.

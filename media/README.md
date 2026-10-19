# Video processing pipeline

`ffmpeg.js` processes a **local video file already obtained through an authorized source workflow**. It probes duration, chooses up to three time ranges, and encodes MP4 files in vertical 9:16 (1080x1920), without adding captions.

Requirements: `ffmpeg` and `ffprobe` must be installed and available on PATH.

## Important limitation

This module does not download or extract video from YouTube/Twitch URLs. A platform URL is not a direct media file, and a resolver must use a permitted/authorized method for the specific account and content before calling `createVerticalClips`. The official Twitch clips endpoints are limited to clips up to 60 seconds, so they cannot alone satisfy the 1–5 minute requirement. YouTube API policies prohibit downloading/caching audiovisual content without prior written approval.

The current MVP does not yet connect a source resolver to the processing pipeline, so the web UI must not claim a clip was created until that integration is configured and a real output file has been verified.

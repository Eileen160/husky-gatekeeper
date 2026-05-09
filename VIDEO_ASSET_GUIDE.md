# Real Husky Video Assets

The extension is now wired for a real video version, like the cat extension:

- `assets/husky-enter.webm`
- `assets/husky-sleep.webm`

MP4 fallback is also supported:

- `assets/husky-enter.mp4`
- `assets/husky-sleep.mp4`

`husky-enter.webm` should be one non-looping shot:

> A photorealistic Siberian husky enters from the right side of frame, walks
> into view, playfully rolls onto its back, rolls back over, lies down facing
> the viewer, then relaxes. Locked camera, no people, no text, no logos,
> soft daylight, neutral clean floor, 16:9, 8 seconds, silent.

`husky-sleep.webm` should be a seamless loop:

> A photorealistic Siberian husky lying down asleep, slow breathing, tiny ear
> twitch, peaceful expression. Locked camera, no people, no text, no logos,
> same lighting and camera angle as the first clip, 16:9, 5 seconds, seamless
> loop, silent.

Recommended export:

- WebM VP9 or H.264 MP4 converted to WebM.
- 1280x720 or 1920x1080.
- Muted/silent.
- Keep each file under roughly 10 MB for Chrome Web Store comfort.

The current SVG husky remains as a fallback when these files are absent.

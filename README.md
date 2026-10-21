# Weightlifting Coach

Analyse your snatch, clean and jerk from a phone video, without a coach and without the cloud. The app tracks the
bar and your body, measures the lift, checks your technique against published elite ranges, and explains what to
work on. Everything runs on your own computer: videos never leave it.

## Features

- **Bar tracking:** finds the plate automatically and tracks the bar end. Reports pull height, drop, horizontal
  movement, bar speed, timing and power.
- **Technique checks:** body tracking (MediaPipe) with good / watch / fault findings. Each finding has a confidence
  based on what the camera could actually see.
- **Elite comparison:** your numbers next to ranges from published studies of elite lifters, with sources.
- **AI coach (optional):** a local language model (Ollama) explains the analysis and answers follow-up questions,
  grounded in the measurements.
- **Library:** save lifts, compare them, ghost an earlier lift over a new one, label lifts, export a dataset.
- **Local engine (optional):** SAM 2.1, OWLv2 and RTMPose for more accurate tracking on Apple silicon.
- Works offline and installs as an app. No build step, no account, no telemetry.

## Quick start

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000 in Chrome, Edge or Safari. The app opens with a sample lift already tracked.

Optional extras:

```bash
engine/start.sh                         # local engine (first run downloads ~2.7 GB)
ollama serve && ollama pull qwen3:14b   # AI coach (~9 GB model)
```

## Filming tips

Film exactly side-on to the bar, with the lens at hip height, from 5–8 m away (zoom in), on a tripod, at 60 fps or
more. Keep the whole lift in the frame, with a standard 450 mm plate on the near side.

## Docs

- [Setup and user guide](docs/GUIDE.md)
- [What a good lift looks like, with sources](knowledge/good-lift.md)
- [Accuracy measurements](docs/baseline.md)
- [Engine result format](docs/result-format.md) · [Dataset format](docs/dataset-format.md)

## Development

```bash
npm test                       # unit tests, no install needed
node tests/make_synthetic.js   # generate test clips with ground truth
```

Every tuning value is in `js/config.js`.

## Licence

MIT, see [LICENSE](LICENSE).
